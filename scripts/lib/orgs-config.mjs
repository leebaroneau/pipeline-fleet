import { readFileSync } from "node:fs";

const ACTIVE_STATUSES = new Set(["self", "active"]);
const KNOWN_STATUSES = new Set(["self", "active", "inactive"]);

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

  return {
    org: {
      name: entry.name,
      retainer_status: entry.retainer_status,
      deployment_mode: entry.deployment_mode ?? "retainer-coolify",
      runner_enabled: entry.runner_enabled ?? true,
      patches_enabled: entry.patches_enabled ?? !inactive,
      pinned_version: pinnedVersion,
      fleet_repo: entry.fleet_repo,
      notes: entry.notes ?? "",
    },
  };
}

export function patchTargets(registry, { owners = [] } = {}) {
  const ownerSet = new Set(owners);
  return registry.orgs.filter((org) => {
    if (ownerSet.size && !ownerSet.has(org.name)) return false;
    return ACTIVE_STATUSES.has(org.retainer_status) && org.patches_enabled;
  });
}

export function runnerTargets(registry, { owner, allowMultiOrg = false } = {}) {
  if (!owner && !allowMultiOrg) {
    throw new Error("runnerTargets needs owner unless allowMultiOrg=true");
  }
  return registry.orgs.filter((org) => {
    if (owner && org.name !== owner) return false;
    return org.runner_enabled;
  });
}
