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

import { readFileSync } from "node:fs";

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
