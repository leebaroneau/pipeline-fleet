#!/usr/bin/env node

// scripts/push-patches.mjs
//
// Patch-cascade tool. Reads config/orgs.json, iterates ACTIVE orgs, opens a PR
// in each consumer repo whose installed caller workflows have drifted from
// pipeline-core's latest templates.
//
// Triggered by Lee locally after cutting a pipeline-core release. NOT a CI
// workflow — it walks 5 orgs × N consumers and rate-limit hygiene + auth
// scope warrant a human-in-the-loop trigger.

import { readFileSync, existsSync, readFileSync as readF, readdirSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ACTIVE_STATUSES = new Set(["self", "active"]);
const KNOWN_STATUSES = new Set(["self", "active", "inactive"]);

export function loadOrgs(configPath) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.orgs ?? [];
  const active = [];
  const skipped = [];
  const invalid = [];
  for (const e of entries) {
    if (!e.name) {
      invalid.push({ entry: e, reason: "missing name" });
      continue;
    }
    if (!KNOWN_STATUSES.has(e.retainer_status)) {
      invalid.push({ entry: e, reason: `unknown retainer_status: ${e.retainer_status}` });
      continue;
    }
    if (ACTIVE_STATUSES.has(e.retainer_status)) {
      active.push(e);
    } else {
      skipped.push(e);
    }
  }
  return { active, skipped, invalid };
}

export async function listConsumerRepos({ owner, fleetRepo, token, fetch = globalThis.fetch }) {
  const url = `https://api.github.com/repos/${fleetRepo}/contents/config/repos.json`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`config/repos.json fetch failed for ${fleetRepo}: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
  const entries = Array.isArray(decoded) ? decoded : decoded.repos ?? [];
  return entries
    .filter((e) => e.owner && e.name)
    .map((e) => ({ ...e, branch: e.branch ?? "main", tier: e.tier ?? 1 }));
}

const PIPELINE_PREFIX = "pipeline-";
const YAML_EXT = /\.(yml|yaml)$/;

export function planRefresh({ repoDir, callerTemplatesDir }) {
  const templates = readdirSync(callerTemplatesDir)
    .filter((f) => f.startsWith(PIPELINE_PREFIX) && YAML_EXT.test(f));
  const workflowsDir = join(repoDir, ".github", "workflows");
  const existing = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((f) => f.startsWith(PIPELINE_PREFIX) && YAML_EXT.test(f))
    : [];

  const unchanged = [];
  const updated   = [];
  const added     = [];

  for (const name of templates) {
    const tplBody = readF(join(callerTemplatesDir, name), "utf8");
    if (!existing.includes(name)) {
      added.push(name);
      continue;
    }
    const consumerBody = readF(join(workflowsDir, name), "utf8");
    if (consumerBody === tplBody) {
      unchanged.push(name);
    } else {
      updated.push(name);
    }
  }

  const templateSet = new Set(templates);
  const removed = existing.filter((f) => !templateSet.has(f));

  return { unchanged, updated, added, removed };
}

export function applyRefresh({ plan, callerTemplatesDir, repoDir }) {
  const written = [];
  const toWrite = [...plan.added, ...plan.updated];
  for (const name of toWrite) {
    const dest = join(repoDir, ".github", "workflows", name);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(callerTemplatesDir, name), dest);
    written.push(dest);
  }
  return written;
}

// Strip auth tokens out of any string that might land in logs or PR descriptions.
// `git clone https://x-access-token:TOKEN@github.com/...` puts the token in argv
// and any subsequent error message. Mirrors the helper in fleet-doctor.mjs.
export function redactToken(s) {
  return String(s ?? "").replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  if (r.status !== 0 && !opts.allowFailure) {
    const safeArgs = args.map(redactToken).join(" ");
    const safeStream = redactToken(r.stderr || r.stdout);
    const err = new Error(`${cmd} ${safeArgs} exited ${r.status}: ${safeStream}`);
    err.status = r.status;
    err.stdout = redactToken(r.stdout);
    err.stderr = redactToken(r.stderr);
    throw err;
  }
  return r;
}

export function preflightAutoPR({ repoDir, branch }) {
  run("git", ["-C", repoDir, "rev-parse", "--show-toplevel"]);
  run("git", ["-C", repoDir, "remote", "get-url", "origin"]);
  const status = run("git", ["-C", repoDir, "status", "--porcelain"]);
  if (status.stdout?.trim()) {
    throw new Error(`push-patches needs a clean working tree in ${repoDir}; found uncommitted changes.`);
  }
  const r = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "ignore" });
  if (r.status === 0) {
    throw new Error(`Branch \`${branch}\` already exists in ${repoDir}.`);
  }
}

function relativizePath(repoDir, absPath) {
  return relative(repoDir, absPath) || absPath;
}

export function openRefreshPR({ repoDir, branch, written, newVersion, plan }) {
  run("git", ["-C", repoDir, "checkout", "-b", branch]);
  run("git", ["-C", repoDir, "add", ...written.map((p) => relativizePath(repoDir, p))]);
  const summary = [
    plan.added.length    ? `add: ${plan.added.join(", ")}` : null,
    plan.updated.length  ? `update: ${plan.updated.join(", ")}` : null,
  ].filter(Boolean).join("; ");
  const title = `chore(pipeline-core): refresh caller workflows to ${newVersion}`;
  const body = [
    `## Summary`,
    ``,
    `Refreshes pipeline-core caller workflows to match \`leebaroneau/pipeline-core@${newVersion}\`.`,
    ``,
    `### Changed`,
    plan.added.length    ? `**Added** (${plan.added.length}):\n- ${plan.added.join("\n- ")}` : "",
    plan.updated.length  ? `**Updated** (${plan.updated.length}):\n- ${plan.updated.join("\n- ")}` : "",
    plan.removed.length  ? `**Note:** these caller files exist in this repo but are no longer in the upstream templates — left in place for your review:\n- ${plan.removed.join("\n- ")}` : "",
    ``,
    `Generated by \`pipeline-fleet/scripts/push-patches.mjs\`.`,
  ].filter(Boolean).join("\n");
  run("git", ["-C", repoDir, "commit", "-m", `${title}\n\n${summary}`]);
  run("git", ["-C", repoDir, "push", "-u", "origin", branch]);
  try {
    run("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], { cwd: repoDir });
  } catch (err) {
    process.stderr.write(`Branch pushed, but \`gh pr create\` failed: ${redactToken(err.message)}\n`);
    return null;
  }
  return run("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd: repoDir }).stdout.trim();
}
