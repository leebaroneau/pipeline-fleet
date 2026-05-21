import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadOrgRegistry,
  normalizeOrg,
  patchTargets,
  runnerTargets,
} from "../scripts/lib/orgs-config.mjs";

function configFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "orgs-config-"));
  const path = join(dir, "orgs.json");
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test("loadOrgRegistry normalizes active retainer defaults", () => {
  const path = configFile({
    orgs: [{
      name: "Haverford-Brands",
      retainer_status: "active",
      fleet_repo: "Haverford-Brands/.github",
    }],
  });

  const registry = loadOrgRegistry(path);

  assert.deepEqual(registry.orgs[0], {
    name: "Haverford-Brands",
    retainer_status: "active",
    deployment_mode: "retainer-coolify",
    runner_enabled: true,
    patches_enabled: true,
    pinned_version: null,
    fleet_repo: "Haverford-Brands/.github",
    notes: "",
  });
});

test("inactive org defaults patches off but can keep runner enabled", () => {
  const path = configFile({
    orgs: [{
      name: "ALX-Finance",
      retainer_status: "inactive",
      runner_enabled: true,
      pinned_version: "v1.0.11",
      fleet_repo: "ALX-Finance/.github",
    }],
  });

  const registry = loadOrgRegistry(path);

  assert.equal(patchTargets(registry).length, 0);
  assert.equal(runnerTargets(registry, { owner: "ALX-Finance" }).length, 1);
  assert.equal(runnerTargets(registry, { owner: "ALX-Finance" })[0].pinned_version, "v1.0.11");
});

test("inactive org requires pinned_version", () => {
  const path = configFile({
    orgs: [{
      name: "ALX-Finance",
      retainer_status: "inactive",
      fleet_repo: "ALX-Finance/.github",
    }],
  });

  const registry = loadOrgRegistry(path);

  assert.equal(registry.orgs.length, 0);
  assert.equal(registry.invalid.length, 1);
  assert.match(registry.invalid[0].reason, /pinned_version/);
});

test("patchTargets filters active/self orgs by owners and patches_enabled", () => {
  const registry = {
    orgs: [
      normalizeOrg({ name: "leebaroneau", retainer_status: "self", fleet_repo: "leebaroneau/pipeline-fleet" }).org,
      normalizeOrg({ name: "Haverford-Brands", retainer_status: "active", patches_enabled: false, fleet_repo: "Haverford-Brands/.github" }).org,
      normalizeOrg({ name: "ALX-Finance", retainer_status: "active", fleet_repo: "ALX-Finance/.github" }).org,
      normalizeOrg({ name: "Inactive", retainer_status: "inactive", pinned_version: "v1.0.11", fleet_repo: "Inactive/.github" }).org,
    ],
  };

  assert.deepEqual(
    patchTargets(registry).map((org) => org.name),
    ["leebaroneau", "ALX-Finance"],
  );
  assert.deepEqual(
    patchTargets(registry, { owners: ["ALX-Finance"] }).map((org) => org.name),
    ["ALX-Finance"],
  );
});

test("runnerTargets requires a single owner unless multi-org is allowed", () => {
  const registry = {
    orgs: [
      normalizeOrg({ name: "A", retainer_status: "active", fleet_repo: "A/.github" }).org,
      normalizeOrg({ name: "B", retainer_status: "active", runner_enabled: false, fleet_repo: "B/.github" }).org,
    ],
  };

  assert.throws(() => runnerTargets(registry), /owner/);
  assert.deepEqual(runnerTargets(registry, { allowMultiOrg: true }).map((org) => org.name), ["A"]);
});
