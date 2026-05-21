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

import { mkdtempSync as mkdir, writeFileSync as writef, mkdirSync as mkd } from "node:fs";
import { planRefresh, renderCallerTemplate } from "../scripts/push-patches.mjs";

function fakeTemplatesDir(files) {
  const dir = mkdir(join(tmpdir(), "tpl-"));
  for (const [name, body] of Object.entries(files)) {
    writef(join(dir, name), body);
  }
  return dir;
}

function fakeConsumer(files) {
  const dir = mkdir(join(tmpdir(), "cns-"));
  mkd(join(dir, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writef(join(dir, ".github", "workflows", name), body);
  }
  return dir;
}

test("planRefresh: empty consumer.github/workflows ⇒ every template is `added`", () => {
  const tpl = fakeTemplatesDir({
    "pipeline-branch-name.yml": "name: Pipeline — branch-name caller\n",
    "pipeline-doctor.yml":      "name: Pipeline — doctor caller\n",
  });
  const repo = fakeConsumer({});
  const r = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  assert.deepEqual(r.added.sort(),     ["pipeline-branch-name.yml", "pipeline-doctor.yml"]);
  assert.deepEqual(r.updated,          []);
  assert.deepEqual(r.unchanged,        []);
  assert.deepEqual(r.removed,          []);
});

test("planRefresh: byte-equal existing caller ⇒ `unchanged`", () => {
  const body = "name: Pipeline — branch-name caller\n";
  const tpl = fakeTemplatesDir({ "pipeline-branch-name.yml": body });
  const repo = fakeConsumer({ "pipeline-branch-name.yml": body });
  const r = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  assert.deepEqual(r.unchanged, ["pipeline-branch-name.yml"]);
  assert.deepEqual(r.updated,   []);
  assert.deepEqual(r.added,     []);
});

test("planRefresh: byte-different existing caller ⇒ `updated`", () => {
  const tpl  = fakeTemplatesDir({ "pipeline-pr-labels.yml": "with:\n  labeler-config: .github/labeler.yml\n" });
  const repo = fakeConsumer({ "pipeline-pr-labels.yml": "with:\n  config-path: .github/labeler.yml\n" });
  const r = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  assert.deepEqual(r.updated, ["pipeline-pr-labels.yml"]);
  assert.deepEqual(r.added,   []);
});

test("planRefresh: caller exists in repo but NOT in templates ⇒ `removed` (informational; not auto-deleted)", () => {
  const tpl  = fakeTemplatesDir({ "pipeline-branch-name.yml": "v1\n" });
  const repo = fakeConsumer({ "pipeline-branch-name.yml": "v1\n", "pipeline-legacy-thing.yml": "old\n" });
  const r = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  assert.deepEqual(r.removed, ["pipeline-legacy-thing.yml"]);
  assert.deepEqual(r.updated, []);
});

test("planRefresh: non-pipeline YAMLs in workflows/ are ignored", () => {
  const tpl  = fakeTemplatesDir({ "pipeline-branch-name.yml": "v1\n" });
  const repo = fakeConsumer({ "pipeline-branch-name.yml": "v1\n", "custom-deploy.yml": "non-pipeline\n" });
  const r = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  assert.deepEqual(r.unchanged, ["pipeline-branch-name.yml"]);
  assert.deepEqual(r.removed,   []);
  assert.deepEqual(r.updated,   []);
});

test("renderCallerTemplate: pins Pipeline Core reusable workflow refs only", () => {
  const body = [
    "jobs:",
    "  branch:",
    "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
    "  labels:",
    "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-pr-labels.yaml@v1",
    "  checkout:",
    "    uses: actions/checkout@v4",
    "  other:",
    "    uses: other/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
    "",
  ].join("\n");

  assert.equal(
    renderCallerTemplate(body, { callerRef: "v1.0.11" }),
    [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1.0.11",
      "  labels:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-pr-labels.yaml@v1.0.11",
      "  checkout:",
      "    uses: actions/checkout@v4",
      "  other:",
      "    uses: other/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  );
});

import { applyRefresh } from "../scripts/push-patches.mjs";
import { readFileSync, existsSync } from "node:fs";

test("applyRefresh: writes added files and overwrites updated ones; leaves unchanged alone", () => {
  const tpl = fakeTemplatesDir({
    "pipeline-branch-name.yml": "name: branch-name v2\n",
    "pipeline-doctor.yml":      "name: doctor v1\n",
  });
  const repo = fakeConsumer({
    "pipeline-branch-name.yml": "name: branch-name v1\n", // updated case
    // pipeline-doctor.yml missing — added case
  });
  const plan = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  const written = applyRefresh({ plan, callerTemplatesDir: tpl, repoDir: repo });
  assert.equal(written.length, 2, "added + updated written");
  assert.equal(
    readFileSync(join(repo, ".github/workflows/pipeline-branch-name.yml"), "utf8"),
    "name: branch-name v2\n",
  );
  assert.ok(existsSync(join(repo, ".github/workflows/pipeline-doctor.yml")));
});

test("applyRefresh: no-op when plan is all-unchanged", () => {
  const body = "name: caller\n";
  const tpl  = fakeTemplatesDir({ "pipeline-branch-name.yml": body });
  const repo = fakeConsumer({ "pipeline-branch-name.yml": body });
  const plan = planRefresh({ repoDir: repo, callerTemplatesDir: tpl });
  const written = applyRefresh({ plan, callerTemplatesDir: tpl, repoDir: repo });
  assert.deepEqual(written, []);
});

import { redactToken } from "../scripts/push-patches.mjs";

test("redactToken: scrubs x-access-token:TOKEN@ patterns from error strings", () => {
  const dirty = "git clone https://x-access-token:ghs_AAAAbbbb1234@github.com/Org/repo.git failed: ...";
  const clean = redactToken(dirty);
  assert.equal(clean, "git clone https://x-access-token:***@github.com/Org/repo.git failed: ...");
});

test("redactToken: handles null/undefined gracefully", () => {
  assert.equal(redactToken(null), "");
  assert.equal(redactToken(undefined), "");
});

import { execSync } from "node:child_process";
import { preflightAutoPR } from "../scripts/push-patches.mjs";

function gitInit(dir) {
  execSync(`git init -q -b main`, { cwd: dir });
  execSync(`git config user.email test@example.com`, { cwd: dir });
  execSync(`git config user.name Test`, { cwd: dir });
  execSync(`git remote add origin https://example.com/x/y.git`, { cwd: dir });
  writef(join(dir, ".keep"), "");
  execSync(`git add .keep`, { cwd: dir });
  execSync(`git commit -q -m initial`, { cwd: dir });
}

function gitInitAll(dir) {
  execSync(`git init -q -b main`, { cwd: dir });
  execSync(`git config user.email test@example.com`, { cwd: dir });
  execSync(`git config user.name Test`, { cwd: dir });
  execSync(`git remote add origin https://example.com/x/y.git`, { cwd: dir });
  execSync(`git add .`, { cwd: dir });
  execSync(`git commit -q -m initial`, { cwd: dir });
}

test("preflightAutoPR: clean working tree, branch absent ⇒ passes", () => {
  const repo = mkdir(join(tmpdir(), "preflight-clean-"));
  gitInit(repo);
  assert.doesNotThrow(() => preflightAutoPR({ repoDir: repo, branch: "chore/refresh" }));
});

test("preflightAutoPR: dirty working tree ⇒ throws", () => {
  const repo = mkdir(join(tmpdir(), "preflight-dirty-"));
  gitInit(repo);
  writef(join(repo, "dirty.txt"), "uncommitted");
  assert.throws(
    () => preflightAutoPR({ repoDir: repo, branch: "chore/refresh" }),
    /clean working tree/i,
  );
});

test("preflightAutoPR: existing local branch ⇒ throws", () => {
  const repo = mkdir(join(tmpdir(), "preflight-branch-"));
  gitInit(repo);
  execSync(`git branch chore/refresh`, { cwd: repo });
  assert.throws(
    () => preflightAutoPR({ repoDir: repo, branch: "chore/refresh" }),
    /already exists/i,
  );
});

import { cloneConsumer } from "../scripts/push-patches.mjs";

function makeBareRemote() {
  // Create a working repo with content, then clone --bare to act as a "remote"
  const work = mkdir(join(tmpdir(), "work-"));
  execSync(`git init -q -b main`, { cwd: work });
  execSync(`git config user.email a@b`, { cwd: work });
  execSync(`git config user.name a`, { cwd: work });
  mkd(join(work, ".github/workflows"), { recursive: true });
  writef(join(work, ".github/workflows/pipeline-branch-name.yml"), "v1\n");
  execSync(`git add .`, { cwd: work });
  execSync(`git commit -q -m initial`, { cwd: work });
  const bare = mkdir(join(tmpdir(), "bare-")) + ".git";
  execSync(`git clone --bare ${work} ${bare}`);
  return bare;
}

test("cloneConsumer: shallow-clones the remote, returns the dir, .github/workflows intact", async () => {
  const bare = makeBareRemote();
  // cloneConsumer uses fileURLToHttp via `--url-override` (test seam) so we
  // don't actually hit github.com.
  const dir = await cloneConsumer({
    owner: "x", name: "y", branch: "main", token: "fake",
    urlOverride: `file://${bare}`,
  });
  assert.ok(existsSync(join(dir, ".github/workflows/pipeline-branch-name.yml")));
});

import { runPushPatches } from "../scripts/push-patches.mjs";

test("runPushPatches --dry-run: returns plan without mutating filesystem or opening PRs", async () => {
  // 1 fake org config + 1 fake consumer (in-tree clone, no remote)
  const orgsPath = withTempConfig({ orgs: [
    { name: "leebaroneau", retainer_status: "self", fleet_repo: "leebaroneau/pipeline-fleet" },
  ]});
  // 2 templates in a fake "pipeline-core" templates dir
  const tpl = fakeTemplatesDir({
    "pipeline-branch-name.yml": "name: branch-name v2\n",
    "pipeline-doctor.yml":      "name: doctor v1\n",
  });
  // The consumer has pipeline-branch-name.yml at v1 and is missing pipeline-doctor
  const consumerDir = fakeConsumer({ "pipeline-branch-name.yml": "name: branch-name v1\n" });
  // listConsumerRepos is injected; cloneConsumer also injected to return the prepared dir
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: tpl,
    dryRun: true,
    token: "fake",
    listConsumerRepos: async () => [{ owner: "leebaroneau", name: "lee-dashboard", branch: "main", tier: 1 }],
    cloneConsumer: async () => consumerDir,
  });
  assert.equal(summary.orgs.length, 1);
  assert.equal(summary.orgs[0].repos.length, 1);
  assert.deepEqual(summary.orgs[0].repos[0].plan.added,   ["pipeline-doctor.yml"]);
  assert.deepEqual(summary.orgs[0].repos[0].plan.updated, ["pipeline-branch-name.yml"]);
  assert.equal(summary.orgs[0].repos[0].prUrl, null, "dry-run does NOT open a PR");
  // Confirm filesystem was NOT mutated
  assert.equal(
    readFileSync(join(consumerDir, ".github/workflows/pipeline-branch-name.yml"), "utf8"),
    "name: branch-name v1\n",
    "dry-run leaves consumer untouched",
  );
});

test("runPushPatches: inactive org is skipped", async () => {
  const orgsPath = withTempConfig({ orgs: [
    { name: "ALX-Finance", retainer_status: "inactive", pinned_version: "v1.0.5", fleet_repo: "ALX-Finance/.github" },
  ]});
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: fakeTemplatesDir({}),
    dryRun: true,
    token: "fake",
    listConsumerRepos: async () => { throw new Error("should not be called for inactive orgs"); },
    cloneConsumer:     async () => { throw new Error("should not be called for inactive orgs"); },
  });
  assert.equal(summary.orgs.length, 0, "no org-level work for inactive orgs");
  assert.equal(summary.skippedOrgs.length, 1);
});

test("runPushPatches: includeInactive can dry-run one inactive org with explicit callerRef", async () => {
  const orgsPath = withTempConfig({ orgs: [
    {
      name: "ALX-Finance",
      retainer_status: "inactive",
      patches_enabled: false,
      pinned_version: "v1.0.11",
      fleet_repo: "ALX-Finance/.github",
    },
  ]});
  const tpl = fakeTemplatesDir({
    "pipeline-branch-name.yml": [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  });
  const consumerDir = fakeConsumer({
    "pipeline-branch-name.yml": [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  });
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: tpl,
    includeInactive: true,
    owners: ["ALX-Finance"],
    callerRef: "v1.0.11",
    dryRun: true,
    token: "fake",
    listConsumerRepos: async ({ owner }) => {
      assert.equal(owner, "ALX-Finance");
      return [{ owner: "ALX-Finance", name: "alx-site", branch: "main", tier: 1 }];
    },
    cloneConsumer: async () => consumerDir,
  });

  assert.equal(summary.orgs.length, 1);
  assert.equal(summary.orgs[0].name, "ALX-Finance");
  assert.equal(summary.orgs[0].repos[0].action, "dry-run");
  assert.deepEqual(summary.orgs[0].repos[0].plan.updated, ["pipeline-branch-name.yml"]);
  assert.equal(
    readFileSync(join(consumerDir, ".github/workflows/pipeline-branch-name.yml"), "utf8"),
    [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
    "dry-run leaves inactive consumer untouched",
  );
});

test("runPushPatches: includeInactive defaults callerRef and metadata to pinned_version", async () => {
  const orgsPath = withTempConfig({ orgs: [
    {
      name: "ALX-Finance",
      retainer_status: "inactive",
      patches_enabled: false,
      pinned_version: "v1.0.11",
      fleet_repo: "ALX-Finance/.github",
    },
  ]});
  const tpl = fakeTemplatesDir({
    "pipeline-branch-name.yml": [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  });
  const consumerDir = fakeConsumer({
    "pipeline-branch-name.yml": [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  });
  gitInitAll(consumerDir);
  let prArgs;

  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: tpl,
    includeInactive: true,
    owners: ["ALX-Finance"],
    token: "fake",
    listConsumerRepos: async () => [{ owner: "ALX-Finance", name: "alx-site", branch: "main", tier: 1 }],
    cloneConsumer: async () => consumerDir,
    openPR: async (args) => {
      prArgs = args;
      return "https://example.com/pr/1";
    },
  });

  assert.equal(summary.orgs[0].repos[0].action, "pr-opened");
  assert.equal(prArgs.newVersion, "v1.0.11");
  assert.equal(prArgs.branch, "chore/refresh-pipeline-core-v1.0.11");
  assert.equal(
    readFileSync(join(consumerDir, ".github/workflows/pipeline-branch-name.yml"), "utf8"),
    [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1.0.11",
      "",
    ].join("\n"),
  );
});

test("runPushPatches: includeInactive accepts explicit callerRef when inactive org has no pinned_version", async () => {
  const orgsPath = withTempConfig({ orgs: [
    {
      name: "ALX-Finance",
      retainer_status: "inactive",
      fleet_repo: "ALX-Finance/.github",
    },
  ]});
  const tpl = fakeTemplatesDir({
    "pipeline-branch-name.yml": [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  });
  const consumerDir = fakeConsumer({
    "pipeline-branch-name.yml": [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1",
      "",
    ].join("\n"),
  });
  gitInitAll(consumerDir);
  let prArgs;

  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: tpl,
    includeInactive: true,
    owners: ["ALX-Finance"],
    callerRef: "v1.0.11",
    token: "fake",
    listConsumerRepos: async ({ owner, fleetRepo }) => {
      assert.equal(owner, "ALX-Finance");
      assert.equal(fleetRepo, "ALX-Finance/.github");
      return [{ owner: "ALX-Finance", name: "alx-site", branch: "main", tier: 1 }];
    },
    cloneConsumer: async () => consumerDir,
    openPR: async (args) => {
      prArgs = args;
      return "https://example.com/pr/2";
    },
  });

  assert.equal(summary.orgs[0].name, "ALX-Finance");
  assert.equal(summary.orgs[0].repos[0].action, "pr-opened");
  assert.equal(prArgs.newVersion, "v1.0.11");
  assert.equal(prArgs.branch, "chore/refresh-pipeline-core-v1.0.11");
  assert.deepEqual(summary.orgs[0].repos[0].plan.updated, ["pipeline-branch-name.yml"]);
  assert.equal(
    readFileSync(join(consumerDir, ".github/workflows/pipeline-branch-name.yml"), "utf8"),
    [
      "jobs:",
      "  branch:",
      "    uses: leebaroneau/pipeline-core/.github/workflows/pipeline-branch-name.yml@v1.0.11",
      "",
    ].join("\n"),
  );
  assert.equal(summary.invalidOrgs.length, 1, "normal registry invalid row is preserved");
});

test("runPushPatches: includeInactive does not bypass patches_enabled for active orgs", async () => {
  const orgsPath = withTempConfig({ orgs: [
    {
      name: "ActiveOff",
      retainer_status: "active",
      patches_enabled: false,
      fleet_repo: "ActiveOff/.github",
    },
  ]});

  await assert.rejects(
    () => runPushPatches({
      orgsConfigPath: orgsPath,
      callerTemplatesDir: fakeTemplatesDir({}),
      includeInactive: true,
      owners: ["ActiveOff"],
      token: "fake",
      listConsumerRepos: async () => { throw new Error("should not bypass inactive-only handoff"); },
      cloneConsumer: async () => { throw new Error("should not bypass inactive-only handoff"); },
    }),
    /inactive org/i,
  );
});

test("runPushPatches: --owner filter restricts to a single active org", async () => {
  const orgsPath = withTempConfig({ orgs: [
    { name: "leebaroneau",     retainer_status: "self",   fleet_repo: "leebaroneau/pipeline-fleet" },
    { name: "Haverford-Brands", retainer_status: "active", fleet_repo: "Haverford-Brands/.github" },
  ]});
  let calledFor = [];
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: fakeTemplatesDir({}),
    owners: ["Haverford-Brands"],
    dryRun: true,
    token: "fake",
    listConsumerRepos: async ({ owner }) => { calledFor.push(owner); return []; },
    cloneConsumer:     async () => { throw new Error("should not be called when consumer list is empty"); },
  });
  assert.deepEqual(calledFor, ["Haverford-Brands"]);
  assert.equal(summary.orgs.length, 1);
  assert.equal(summary.orgs[0].name, "Haverford-Brands");
  assert.deepEqual(summary.skippedOrgs.map((org) => org.name), ["leebaroneau"]);
});

test("runPushPatches: skippedOrgs are normalized separately from invalidOrgs", async () => {
  const orgsPath = withTempConfig({ orgs: [
    { name: "Active", retainer_status: "active", fleet_repo: "Active/.github" },
    { name: "PatchesOff", retainer_status: "active", patches_enabled: false, fleet_repo: "PatchesOff/.github" },
    { name: "Inactive", retainer_status: "inactive", pinned_version: "v1.0.11", fleet_repo: "Inactive/.github" },
    { name: "InvalidInactive", retainer_status: "inactive", fleet_repo: "InvalidInactive/.github" },
  ]});
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: fakeTemplatesDir({}),
    owners: ["Active"],
    dryRun: true,
    token: "fake",
    listConsumerRepos: async () => [],
    cloneConsumer:     async () => { throw new Error("should not be called when consumer list is empty"); },
  });
  assert.deepEqual(summary.orgs.map((org) => org.name), ["Active"]);
  assert.deepEqual(summary.skippedOrgs.map((org) => org.name), ["PatchesOff", "Inactive"]);
  assert.equal(summary.skippedOrgs[0].deployment_mode, "retainer-coolify");
  assert.equal(summary.invalidOrgs.length, 1);
  assert.match(summary.invalidOrgs[0].reason, /pinned_version/);
});

test("integration: dry-run against 2 fake consumers reports 1 noop + 1 with adds", async () => {
  const orgsPath = withTempConfig({ orgs: [
    { name: "FakeOrg", retainer_status: "active", fleet_repo: "FakeOrg/.github" },
  ]});
  // Templates: 1 caller
  const tpl = fakeTemplatesDir({ "pipeline-branch-name.yml": "v2\n" });
  // Consumer A: already at v2 (noop). Consumer B: missing the caller (add).
  const consumerA = fakeConsumer({ "pipeline-branch-name.yml": "v2\n" });
  const consumerB = fakeConsumer({});
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: tpl,
    dryRun: true,
    token: "fake",
    listConsumerRepos: async () => [
      { owner: "FakeOrg", name: "A", branch: "main", tier: 1 },
      { owner: "FakeOrg", name: "B", branch: "main", tier: 1 },
    ],
    cloneConsumer: async ({ name }) => name === "A" ? consumerA : consumerB,
  });
  const actions = summary.orgs[0].repos.map((r) => r.action).sort();
  assert.deepEqual(actions, ["dry-run", "noop"]);
});
