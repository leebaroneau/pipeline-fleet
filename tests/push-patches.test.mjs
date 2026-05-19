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

import { listConsumerRepos } from "../scripts/push-patches.mjs";

function fakeFetch(map) {
  // map: { "<url>": { status, json } }
  return async (url) => {
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, statusText: "Not Found" };
    return {
      ok: entry.status === 200,
      status: entry.status,
      statusText: entry.status === 200 ? "OK" : "Error",
      async json() { return entry.json; },
      async text() { return JSON.stringify(entry.json); },
    };
  };
}

test("listConsumerRepos: returns owner+name pairs from repos.json", async () => {
  const url = "https://api.github.com/repos/Haverford-Brands/.github/contents/config/repos.json";
  const fetch = fakeFetch({
    [url]: {
      status: 200,
      json: {
        content: Buffer.from(JSON.stringify({
          repos: [
            { owner: "Haverford-Brands", name: "service-Auth-Gate", branch: "main", tier: 1 },
            { owner: "Haverford-Brands", name: "Catnets.com.au",    branch: "main", tier: 2 },
          ],
        })).toString("base64"),
      },
    },
  });
  const r = await listConsumerRepos({ owner: "Haverford-Brands", fleetRepo: "Haverford-Brands/.github", token: "fake", fetch });
  assert.equal(r.length, 2);
  assert.equal(r[0].name, "service-Auth-Gate");
  assert.equal(r[1].branch, "main");
});

test("listConsumerRepos: empty repos list returns []", async () => {
  const url = "https://api.github.com/repos/Empty/.github/contents/config/repos.json";
  const fetch = fakeFetch({
    [url]: { status: 200, json: { content: Buffer.from(JSON.stringify({ repos: [] })).toString("base64") } },
  });
  const r = await listConsumerRepos({ owner: "Empty", fleetRepo: "Empty/.github", token: "fake", fetch });
  assert.deepEqual(r, []);
});

test("listConsumerRepos: missing config/repos.json throws with a clear message", async () => {
  const fetch = fakeFetch({});
  await assert.rejects(
    () => listConsumerRepos({ owner: "X", fleetRepo: "X/.github", token: "fake", fetch }),
    /config\/repos\.json.*404/i,
  );
});
