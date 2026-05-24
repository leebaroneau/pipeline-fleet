import { readFileSync } from "node:fs";

const ACTIVE_STATUSES = new Set(["self", "active"]);
const KNOWN_STATUSES = new Set(["self", "active", "inactive"]);
const DEFAULT_BRANCH = "main";
const DEFAULT_TIER = 1;

export function loadOrgRegistry(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.orgs ?? [];
  const orgs = [];
  const invalid = [];

  for (const entry of entries) {
    const normalized = normalizeOrg(entry);
    if (normalized.error) {
      invalid.push({ entry, reason: normalized.error });
    } else {
      orgs.push(normalized.org);
    }
  }

  return { orgs, invalid };
}

export function normalizeOrg(entry) {
  if (!entry?.name) return { error: "missing name" };
  if (!entry?.fleet_repo) return { error: `missing fleet_repo for ${entry.name}` };
  if (!KNOWN_STATUSES.has(entry.retainer_status)) {
    return { error: `unknown retainer_status: ${entry.retainer_status}` };
  }

  const inactive = entry.retainer_status === "inactive";
  const pinnedVersion = entry.pinned_version ?? null;
  if (inactive && !pinnedVersion) {
    return { error: `inactive org ${entry.name} needs pinned_version` };
  }
  const aliases = Array.isArray(entry.aliases) ? entry.aliases.filter(Boolean) : [];
  const ownerNames = new Set([entry.name, ...aliases]);

  return {
    org: {
      name: entry.name,
      aliases,
      retainer_status: entry.retainer_status,
      deployment_mode: entry.deployment_mode ?? "retainer-coolify",
      runner_enabled: entry.runner_enabled ?? true,
      patches_enabled: entry.patches_enabled ?? !inactive,
      pinned_version: pinnedVersion,
      fleet_repo: entry.fleet_repo,
      repos: normalizeRepoEntries(entry.repos ?? [], entry.name, ownerNames),
      skip: normalizeSkipEntries(entry.skip ?? [], entry.name, ownerNames),
      notes: entry.notes ?? "",
    },
  };
}

export function patchTargets(registry, { owners = [] } = {}) {
  const ownerSet = new Set(owners);
  return registry.orgs.filter((org) => {
    if (ownerSet.size && !matchesOwner(org, ownerSet)) return false;
    return ACTIVE_STATUSES.has(org.retainer_status) && org.patches_enabled;
  });
}

export function runnerTargets(registry, { owner, allowMultiOrg = false } = {}) {
  if (!owner && !allowMultiOrg) {
    throw new Error("runnerTargets needs owner unless allowMultiOrg=true");
  }
  return registry.orgs.filter((org) => {
    if (owner && !matchesOwner(org, new Set([owner]))) return false;
    return org.runner_enabled;
  });
}

function matchesOwner(org, ownerSet) {
  if (ownerSet.has(org.name)) return true;
  return (org.aliases ?? []).some((alias) => ownerSet.has(alias));
}

function canonicalizeOwner(owner, canonicalOwner, ownerNames) {
  if (!owner || ownerNames.has(owner)) return canonicalOwner;
  return owner;
}

function normalizeRepoEntries(entries, canonicalOwner, ownerNames) {
  return entries
    .filter((entry) => entry?.name)
    .map((entry) => ({
      owner: canonicalizeOwner(entry.owner, canonicalOwner, ownerNames),
      name: entry.name,
      branch: entry.branch ?? DEFAULT_BRANCH,
      tier: entry.tier ?? DEFAULT_TIER,
      ...(entry.notes ? { notes: entry.notes } : {}),
    }));
}

function normalizeSkipEntries(entries, canonicalOwner, ownerNames) {
  return entries
    .filter((entry) => entry?.name)
    .map((entry) => ({
      owner: canonicalizeOwner(entry.owner, canonicalOwner, ownerNames),
      name: entry.name,
      reason: entry.reason ?? "",
    }));
}

export function fleetConfigForOrg(registry, owner) {
  const org = registry.orgs.find((candidate) => matchesOwner(candidate, new Set([owner])));
  if (!org) {
    throw new Error(`No org found for ${owner}`);
  }
  return {
    org,
    repos: {
      _comment: "Generated from pipeline-fleet config/orgs.json. Do not edit directly.",
      repos: org.repos,
    },
    skip: {
      _comment: "Generated from pipeline-fleet config/orgs.json. Do not edit directly.",
      repos: org.skip,
    },
  };
}
