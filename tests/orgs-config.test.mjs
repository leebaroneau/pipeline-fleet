import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fleetConfigForOrg,
  loadOrgRegistry,
  normalizeOrg,
  patchTargets,
  runnerTargets,
} from "../scripts/lib/orgs-config.mjs";
import { renderFleetConfigs } from "../scripts/render-fleet-configs.mjs";

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
    aliases: [],
    retainer_status: "active",
    deployment_mode: "retainer-coolify",
    runner_enabled: true,
    patches_enabled: true,
    pinned_version: null,
    fleet_repo: "Haverford-Brands/.github",
    repos: [],
    skip: [],
    notes: "",
  });
});

test("loadOrgRegistry canonicalizes aliases and nested repo ownership", () => {
  const path = configFile({
    orgs: [{
      name: "genvest",
      aliases: ["Genvest-Property"],
      retainer_status: "active",
      fleet_repo: "genvest/.github",
      repos: [
        { owner: "Genvest-Property", name: "agent-genvest", tier: 1 },
        { name: "gateway-genvest", branch: "main", tier: 1 },
      ],
      skip: [
        { owner: "Genvest-Property", name: "service-api", reason: "Archived" },
      ],
    }],
  });

  const registry = loadOrgRegistry(path);
  const org = registry.orgs[0];

  assert.equal(org.name, "genvest");
  assert.deepEqual(org.aliases, ["Genvest-Property"]);
  assert.deepEqual(org.repos.map(({ owner, name }) => `${owner}/${name}`), [
    "genvest/agent-genvest",
    "genvest/gateway-genvest",
  ]);
  assert.deepEqual(org.skip.map(({ owner, name }) => `${owner}/${name}`), [
    "genvest/service-api",
  ]);
});

test("fleetConfigForOrg renders repos.json and skip.json from the canonical registry", () => {
  const registry = {
    orgs: [
      normalizeOrg({
        name: "alx-finance",
        aliases: ["ALX-Finance"],
        retainer_status: "active",
        fleet_repo: "alx-finance/.github",
        repos: [
          { owner: "ALX-Finance", name: "website", branch: "main", tier: 1 },
          { name: "paperclip-hermes-gbrain", tier: 1 },
        ],
        skip: [
          { owner: "ALX-Finance", name: ".github", reason: "Fleet manager" },
          { name: "agent-alx", reason: "Pipeline Core not installed yet" },
        ],
      }).org,
    ],
  };

  const rendered = fleetConfigForOrg(registry, "ALX-Finance");

  assert.deepEqual(rendered.repos.repos.map(({ owner, name }) => `${owner}/${name}`), [
    "alx-finance/website",
    "alx-finance/paperclip-hermes-gbrain",
  ]);
  assert.deepEqual(rendered.skip.repos.map(({ owner, name }) => `${owner}/${name}`), [
    "alx-finance/.github",
    "alx-finance/agent-alx",
  ]);
});

test("renderFleetConfigs writes per-org repos and skip files from canonical registry", () => {
  const path = configFile({
    orgs: [{
      name: "genvest",
      aliases: ["Genvest-Property"],
      retainer_status: "active",
      fleet_repo: "genvest/.github",
      repos: [{ owner: "Genvest-Property", name: "website" }],
      skip: [{ name: ".github", reason: "Fleet manager" }],
    }],
  });
  const outDir = mkdtempSync(join(tmpdir(), "fleet-config-render-"));

  const rendered = renderFleetConfigs({ orgsConfigPath: path, outDir, owners: ["Genvest-Property"] });

  assert.deepEqual(rendered, ["genvest"]);
  assert.ok(existsSync(join(outDir, "genvest", "config", "repos.json")));
  assert.ok(existsSync(join(outDir, "genvest", "config", "skip.json")));
  const repos = JSON.parse(readFileSync(join(outDir, "genvest", "config", "repos.json"), "utf8"));
  assert.deepEqual(repos.repos.map(({ owner, name }) => `${owner}/${name}`), ["genvest/website"]);
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
      normalizeOrg({ name: "alx-finance", aliases: ["ALX-Finance"], retainer_status: "active", fleet_repo: "alx-finance/.github" }).org,
      normalizeOrg({ name: "Inactive", retainer_status: "inactive", pinned_version: "v1.0.11", fleet_repo: "Inactive/.github" }).org,
    ],
  };

  assert.deepEqual(
    patchTargets(registry).map((org) => org.name),
    ["leebaroneau", "alx-finance"],
  );
  assert.deepEqual(
    patchTargets(registry, { owners: ["ALX-Finance"] }).map((org) => org.name),
    ["alx-finance"],
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
