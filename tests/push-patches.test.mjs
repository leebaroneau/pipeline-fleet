import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrgs } from "../scripts/push-patches.mjs";

function withTempConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), "push-patches-"));
  const path = join(dir, "orgs.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

test("loadOrgs: partitions active+skipped+invalid", () => {
  const path = withTempConfig({
    orgs: [
      { name: "leebaroneau", retainer_status: "self",     pinned_version: null, fleet_repo: "leebaroneau/pipeline-fleet" },
      { name: "Haverford-Brands", retainer_status: "active",   pinned_version: null, fleet_repo: "Haverford-Brands/.github" },
      { name: "ALX-Finance",      retainer_status: "inactive", pinned_version: "v1.0.5", fleet_repo: "ALX-Finance/.github" },
      { /* missing name */         retainer_status: "active",   fleet_repo: "Bad/.github" },
    ],
  });
  const r = loadOrgs(path);
  assert.equal(r.active.length, 2,   "self + active count as cascade targets");
  assert.equal(r.skipped.length, 1,  "inactive is skipped");
  assert.equal(r.invalid.length, 1,  "row missing name lands in invalid");
  assert.deepEqual(r.active.map((o) => o.name).sort(), ["Haverford-Brands", "leebaroneau"]);
});

test("loadOrgs: 'self' status counts as active (the patch source cascades to itself)", () => {
  const path = withTempConfig({ orgs: [{ name: "leebaroneau", retainer_status: "self", fleet_repo: "leebaroneau/pipeline-fleet" }] });
  const r = loadOrgs(path);
  assert.equal(r.active.length, 1);
  assert.equal(r.active[0].name, "leebaroneau");
});

test("loadOrgs: unknown retainer_status lands in invalid, not silently in active", () => {
  const path = withTempConfig({ orgs: [{ name: "Mystery", retainer_status: "weirdo", fleet_repo: "x/y" }] });
  const r = loadOrgs(path);
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].reason, /retainer_status/);
});
