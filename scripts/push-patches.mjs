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

import { existsSync, readFileSync as readF, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadOrgRegistry, patchTargets } from "./lib/orgs-config.mjs";

export function loadOrgs(configPath) {
  const registry = loadOrgRegistry(configPath);
  const active = patchTargets(registry);
  const selected = new Set(active.map((org) => org.name));
  const skipped = registry.orgs.filter((org) => !selected.has(org.name));
  return { active, skipped, invalid: registry.invalid };
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
const DEFAULT_CALLER_REF = "v1";
const PIPELINE_CORE_WORKFLOW_REF = /leebaroneau\/pipeline-core\/\.github\/workflows\/([^@\s'"]+\.ya?ml)@[^ \t\r\n'"]+/g;

export function renderCallerTemplate(text, { callerRef = DEFAULT_CALLER_REF } = {}) {
  return String(text).replace(PIPELINE_CORE_WORKFLOW_REF, (_match, workflow) => (
    `leebaroneau/pipeline-core/.github/workflows/${workflow}@${callerRef}`
  ));
}

export function planRefresh({ repoDir, callerTemplatesDir, callerRef = DEFAULT_CALLER_REF }) {
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
    const tplBody = renderCallerTemplate(readF(join(callerTemplatesDir, name), "utf8"), { callerRef });
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

export function applyRefresh({ plan, callerTemplatesDir, repoDir, callerRef = DEFAULT_CALLER_REF }) {
  const written = [];
  const toWrite = [...plan.added, ...plan.updated];
  for (const name of toWrite) {
    const dest = join(repoDir, ".github", "workflows", name);
    mkdirSync(dirname(dest), { recursive: true });
    const rendered = renderCallerTemplate(readF(join(callerTemplatesDir, name), "utf8"), { callerRef });
    writeFileSync(dest, rendered);
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

export async function cloneConsumer({ owner, name, branch = "main", token, urlOverride }) {
  const dir = mkdtempSync(join(tmpdir(), `push-patches-${name}-`));
  const url = urlOverride ?? `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
  run("git", ["clone", "--depth", "1", "--single-branch", "--branch", branch, url, dir]);
  return dir;
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

export async function runPushPatches({
  orgsConfigPath,
  callerTemplatesDir,
  owners,                  // optional: filter active orgs to this allowlist
  includeInactive = false,
  callerRef,
  dryRun = false,
  newVersion,              // PR title/body label
  token = process.env.FLEET_PAT ?? process.env.GITHUB_TOKEN,
  // Injected dependencies (defaults are real):
  listConsumerRepos: listFn = listConsumerRepos,
  cloneConsumer: cloneFn,
  openPR: openFn = openRefreshPR,
}) {
  if (!token) throw new Error("runPushPatches needs FLEET_PAT or GITHUB_TOKEN.");
  const registry = loadOrgRegistry(orgsConfigPath);
  const ownerFilters = owners ?? [];
  const callerRefExplicit = callerRef !== undefined;
  const requestedCallerRef = callerRef ?? DEFAULT_CALLER_REF;
  let filtered;
  if (includeInactive) {
    if (ownerFilters.length !== 1) {
      throw new Error("includeInactive handoff needs exactly one --owner filter.");
    }
    const owner = ownerFilters[0];
    const invalidPinned = registry.invalid.find(
      (row) => row.entry?.name === owner && /pinned_version/.test(row.reason),
    );
    if (invalidPinned && !callerRefExplicit) {
      throw new Error(`includeInactive handoff for ${owner} needs --caller-ref because the org has no pinned_version.`);
    }
    let org = registry.orgs.find((entry) => entry.name === owner);
    if (!org && invalidPinned && callerRefExplicit) {
      org = {
        name: invalidPinned.entry.name,
        retainer_status: "inactive",
        deployment_mode: invalidPinned.entry.deployment_mode ?? "retainer-coolify",
        runner_enabled: invalidPinned.entry.runner_enabled ?? true,
        patches_enabled: false,
        pinned_version: null,
        fleet_repo: invalidPinned.entry.fleet_repo,
        notes: invalidPinned.entry.notes ?? "",
      };
    }
    if (!org) {
      throw new Error(`includeInactive handoff could not find normalized org ${owner}.`);
    }
    if (org.retainer_status !== "inactive") {
      throw new Error(`includeInactive handoff only supports inactive orgs; ${owner} is ${org.retainer_status}.`);
    }
    const effectiveCallerRef = callerRefExplicit ? requestedCallerRef : org.pinned_version;
    if (!effectiveCallerRef) {
      throw new Error(`includeInactive handoff for ${owner} needs pinned_version or --caller-ref.`);
    }
    filtered = [{ ...org, callerRef: effectiveCallerRef, newVersion: newVersion ?? effectiveCallerRef }];
  } else {
    filtered = patchTargets(registry, { owners: ownerFilters }).map((org) => ({
      ...org,
      callerRef: requestedCallerRef,
      newVersion: newVersion ?? requestedCallerRef,
    }));
  }
  const selected = new Set(filtered.map((org) => org.name));
  const skipped = registry.orgs.filter((org) => !selected.has(org.name));

  const orgsOut = [];
  for (const org of filtered) {
    const consumers = await listFn({ owner: org.name, fleetRepo: org.fleet_repo, token });
    const repos = [];
    for (const c of consumers) {
      const repoDir = await cloneFn({ owner: c.owner, name: c.name, branch: c.branch, token });
      try {
        const plan = planRefresh({ repoDir, callerTemplatesDir, callerRef: org.callerRef });
        const willWrite = plan.added.length + plan.updated.length;
        if (willWrite === 0) {
          repos.push({ slug: `${c.owner}/${c.name}`, plan, prUrl: null, action: "noop" });
          continue;
        }
        if (dryRun) {
          repos.push({ slug: `${c.owner}/${c.name}`, plan, prUrl: null, action: "dry-run" });
          continue;
        }
        const branch = `chore/refresh-pipeline-core-${org.newVersion}`;
        preflightAutoPR({ repoDir, branch });
        const written = applyRefresh({ plan, callerTemplatesDir, repoDir, callerRef: org.callerRef });
        const prUrl = openFn({ repoDir, branch, written, newVersion: org.newVersion, plan });
        repos.push({ slug: `${c.owner}/${c.name}`, plan, prUrl, action: "pr-opened" });
      } catch (err) {
        repos.push({ slug: `${c.owner}/${c.name}`, plan: null, prUrl: null, action: "error", error: redactToken(err.message) });
      }
    }
    orgsOut.push({ name: org.name, fleet_repo: org.fleet_repo, repos });
  }
  return { orgs: orgsOut, skippedOrgs: skipped, invalidOrgs: registry.invalid };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { owners: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--orgs-config")      args.orgsConfigPath     = argv[++i];
    else if (a === "--templates")   args.callerTemplatesDir = argv[++i];
    else if (a === "--owner")       args.owners.push(argv[++i]);
    else if (a === "--new-version") args.newVersion         = argv[++i];
    else if (a === "--caller-ref")  args.callerRef          = argv[++i];
    else if (a === "--include-inactive") args.includeInactive = true;
    else if (a === "--dry-run")     args.dryRun             = true;
    else if (a === "--help" || a === "-h") args.help        = true;
  }
  return args;
}

const HELP = `Usage: push-patches.mjs --orgs-config <path> --templates <path> [options]

Cascades pipeline-core caller-workflow updates to every consumer repo across
active retainer orgs. Opens one PR per repo if any caller has changed.

Required:
  --orgs-config <path>         config/orgs.json (pipeline-fleet)
  --templates <path>           pipeline-core/templates/caller-workflows/

Options:
  --owner <name>               Restrict to one active org. Repeatable.
  --new-version <ref>          Label shown in PR title/body (default: v1)
  --caller-ref <ref>           Pipeline Core reusable workflow ref (default: v1)
  --include-inactive           One-time handoff pin for exactly one --owner
  --dry-run                    Plan only — no clones write back, no PRs open
  --help, -h                   Show this help

Auth: FLEET_PAT or GITHUB_TOKEN env var.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (!args.orgsConfigPath || !args.callerTemplatesDir) {
    process.stderr.write("push-patches.mjs needs --orgs-config and --templates.\n");
    return 1;
  }
  const summary = await runPushPatches({
    orgsConfigPath:     args.orgsConfigPath,
    callerTemplatesDir: args.callerTemplatesDir,
    owners:             args.owners,
    includeInactive:    args.includeInactive,
    callerRef:          args.callerRef,
    dryRun:             args.dryRun,
    newVersion:         args.newVersion,
    cloneConsumer,
  });
  // Concise stdout summary
  for (const org of summary.orgs) {
    process.stdout.write(`\n[${org.name}] ${org.repos.length} consumer(s):\n`);
    for (const r of org.repos) {
      const tag = r.action === "pr-opened" ? `→ ${r.prUrl}` : `(${r.action})`;
      process.stdout.write(`  ${r.slug}  ${tag}\n`);
    }
  }
  for (const s of summary.skippedOrgs) {
    process.stdout.write(`\n[skip] ${s.name} (retainer_status=${s.retainer_status})\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/push-patches.mjs")) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`push-patches.mjs failed: ${redactToken(err.stack ?? err.message ?? err)}\n`);
    process.exit(1);
  });
}
