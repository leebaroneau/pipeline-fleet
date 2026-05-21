# Retainer-Hosted Fleet Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Pipeline Core fleet sweeps from GitHub Actions to a retainer-hosted Coolify runner while keeping Lee in control of templates, patch pushes, and offboarding.

**Architecture:** `pipeline-core` remains the reusable framework. `pipeline-fleet` becomes the runner package and retainer control plane. Each retainer's own Coolify server runs a scheduled container that audits only that retainer's GitHub org and writes state back to that org's `.github` repo.

**Tech Stack:** Node 22, GitHub REST via PAT, `git` CLI, Docker/Coolify, existing Pipeline Core scripts, Node test runner.

---

## Repository Map

| Repo | Owner | Purpose | Change in this plan |
| --- | --- | --- | --- |
| `leebaroneau/pipeline-core` | Lee | Source framework: reusable workflows, install doctor, fleet doctor, discovery, tracker renderer, templates. | Keep as upstream framework. Add docs/template adjustments so new org fleets can run via retainer-hosted Coolify instead of scheduled GitHub Actions. |
| `leebaroneau/pipeline-fleet` | Lee | Fleet control plane: retainer registry, patch cascade, Lee's own fleet state. | Add the Coolify runner, Docker packaging, lifecycle flags, offboarding pin support, and operator docs. |
| `Haverford-Brands/.github` | Haverford | Haverford fleet repo: `config/repos.json`, `config/skip.json`, `state/results.json`, `state/discovery.json`, tracker README. | Coolify runner on Haverford's server writes here. Old Actions cron is disabled after runner proves stable. |
| `ALX-Finance/.github` | ALX | ALX fleet repo with the same config/state/tracker shape. | Same retainer-hosted runner model. |
| `Genvest-Property/.github` | Genvest | Genvest fleet repo with the same config/state/tracker shape. | Same retainer-hosted runner model. |
| `kwa-nguyen/.github` | KWA | KWA fleet repo with the same config/state/tracker shape. | Same retainer-hosted runner model. |
| Consumer repos | Each org | Actual product/theme/service repos using `.github/workflows/pipeline-*.yml`. | No runner code goes here. Offboarding may open one final PR to pin callers from `@v1` to `@v1.0.X`. |
| `leebaroneau/notion-github-sync` | Lee | Notion/GitHub issue and Project mirror. | No change. It is not part of fleet health; only reuse its deployment pattern conceptually. |
| `leebaroneau/lee-dashboard` | Lee | Workspace control/index repo and GBrain source. | No product code change. This plan is saved under `pipeline-fleet`, the owning repo. |

## Desired Control Model

`config/orgs.json` becomes the source of truth for retainer lifecycle:

```json
{
  "name": "Haverford-Brands",
  "retainer_status": "active",
  "deployment_mode": "retainer-coolify",
  "runner_enabled": true,
  "patches_enabled": true,
  "pinned_version": null,
  "fleet_repo": "Haverford-Brands/.github",
  "notes": "Primary commercial org. Runner hosted on Haverford Coolify."
}
```

Offboarding freezes updates without breaking local monitoring:

```json
{
  "name": "Haverford-Brands",
  "retainer_status": "inactive",
  "deployment_mode": "retainer-coolify",
  "runner_enabled": true,
  "patches_enabled": false,
  "pinned_version": "v1.0.11",
  "fleet_repo": "Haverford-Brands/.github",
  "notes": "Inactive. Runner may continue on retainer server, pinned to v1.0.11."
}
```

Rules:

- `runner_enabled: false` stops scheduled health/discovery sweeps for that org.
- `patches_enabled: false` stops Lee from opening caller-refresh PRs for that org.
- `pinned_version` controls the Pipeline Core ref used by the runner and by final handoff PRs.
- `retainer_status: inactive` defaults `patches_enabled` to false.
- Consumers must be pinned from `@v1` to `@v1.0.X` during handoff, otherwise they keep receiving upstream `v1` behavior changes.

## File Structure

### `pipeline-fleet`

- Create `scripts/lib/orgs-config.mjs`: parse, normalize, and validate `config/orgs.json`.
- Create `scripts/lib/git-runner.mjs`: wrapper around `spawnSync` for testable git/node command execution.
- Create `scripts/fleet-runner.mjs`: one-shot Coolify runner entry point.
- Modify `scripts/push-patches.mjs`: honor `patches_enabled`, support caller ref rendering, support one-time inactive handoff pinning.
- Create `tests/orgs-config.test.mjs`: lifecycle config tests.
- Create `tests/fleet-runner.test.mjs`: runner selection and command orchestration tests.
- Modify `tests/push-patches.test.mjs`: patch targeting and pinned caller tests.
- Create `Dockerfile`: Node 22 image with `git`, `CMD ["node", "scripts/fleet-runner.mjs", "--once"]`.
- Create `docker-compose.coolify.yml`: Coolify-friendly service definition with required env vars.
- Create `.env.example`: runtime env reference for retainer deployments.
- Create `docs/retainer-hosted-fleet-runner.md`: operator guide.
- Modify `README.md`: short architecture note and links to the operator guide.

### `pipeline-core`

- Modify `templates/fleet/fleet.yml`: remove the daily `schedule` from new fleet templates, leaving `workflow_dispatch` as the manual fallback.
- Modify `templates/fleet/README.md`: explain retainer-hosted Coolify as the preferred sweep runner.
- Update tests only if an existing snapshot or fixture asserts the scheduled cron.

### Org `.github` repos

- After a retainer Coolify runner passes verification, open a PR in that org's `.github` repo to disable the old scheduled Actions cron. Leave manual `workflow_dispatch` available.

---

### Task 1: Normalize Retainer Lifecycle Config

**Files:**
- Create: `00_repos/pipeline-fleet/scripts/lib/orgs-config.mjs`
- Create: `00_repos/pipeline-fleet/tests/orgs-config.test.mjs`
- Modify: `00_repos/pipeline-fleet/scripts/push-patches.mjs`
- Modify: `00_repos/pipeline-fleet/tests/push-patches.test.mjs`

- [ ] **Step 1: Write failing config tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrgRegistry, patchTargets, runnerTargets } from "../scripts/lib/orgs-config.mjs";

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
      fleet_repo: "Haverford-Brands/.github"
    }]
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
    notes: ""
  });
});

test("inactive org defaults patches off but can keep runner enabled", () => {
  const path = configFile({
    orgs: [{
      name: "ALX-Finance",
      retainer_status: "inactive",
      runner_enabled: true,
      pinned_version: "v1.0.11",
      fleet_repo: "ALX-Finance/.github"
    }]
  });
  const registry = loadOrgRegistry(path);
  assert.equal(patchTargets(registry).length, 0);
  assert.equal(runnerTargets(registry, { owner: "ALX-Finance" }).length, 1);
  assert.equal(runnerTargets(registry, { owner: "ALX-Finance" })[0].pinned_version, "v1.0.11");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd 00_repos/pipeline-fleet && npm test -- tests/orgs-config.test.mjs`

Expected: FAIL with a module-not-found error for `scripts/lib/orgs-config.mjs`.

- [ ] **Step 3: Implement org registry loader**

```js
import { readFileSync } from "node:fs";

const KNOWN_STATUSES = new Set(["self", "active", "inactive"]);

export function loadOrgRegistry(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.orgs ?? [];
  const orgs = [];
  const invalid = [];

  for (const entry of entries) {
    const normalized = normalizeOrg(entry);
    if (normalized.error) invalid.push({ entry, reason: normalized.error });
    else orgs.push(normalized.org);
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
  const pinned = entry.pinned_version ?? null;
  if (inactive && !pinned) return { error: `inactive org ${entry.name} needs pinned_version` };

  return {
    org: {
      name: entry.name,
      retainer_status: entry.retainer_status,
      deployment_mode: entry.deployment_mode ?? "retainer-coolify",
      runner_enabled: entry.runner_enabled ?? true,
      patches_enabled: entry.patches_enabled ?? !inactive,
      pinned_version: pinned,
      fleet_repo: entry.fleet_repo,
      notes: entry.notes ?? ""
    }
  };
}

export function patchTargets(registry, { owners = [] } = {}) {
  const ownerSet = new Set(owners);
  return registry.orgs.filter((org) => {
    if (ownerSet.size && !ownerSet.has(org.name)) return false;
    return (org.retainer_status === "self" || org.retainer_status === "active") && org.patches_enabled;
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
```

- [ ] **Step 4: Update `push-patches.mjs` to use patch targets**

Change `runPushPatches()` so it loads the registry with `loadOrgRegistry()`, uses `patchTargets(registry, { owners })`, and returns skipped orgs as every normalized org not selected for patching.

- [ ] **Step 5: Verify tests pass**

Run: `cd 00_repos/pipeline-fleet && npm test`

Expected: all pipeline-fleet tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
cd 00_repos/pipeline-fleet
git add scripts/lib/orgs-config.mjs scripts/push-patches.mjs tests/orgs-config.test.mjs tests/push-patches.test.mjs
git commit -m "feat: model retainer fleet lifecycle"
```

---

### Task 2: Add Handoff Pinning For Inactive Retainers

**Files:**
- Modify: `00_repos/pipeline-fleet/scripts/push-patches.mjs`
- Modify: `00_repos/pipeline-fleet/tests/push-patches.test.mjs`

- [ ] **Step 1: Write failing template render tests**

```js
test("renderCallerTemplate rewrites pipeline-core caller ref", () => {
  const input = "uses: leebaroneau/pipeline-core/.github/workflows/merge-gate.yml@v1\n";
  const output = renderCallerTemplate(input, { callerRef: "v1.0.11" });
  assert.equal(output, "uses: leebaroneau/pipeline-core/.github/workflows/merge-gate.yml@v1.0.11\n");
});

test("runPushPatches can handoff-pin one inactive org", async () => {
  const orgsPath = withTempConfig({ orgs: [{
    name: "Haverford-Brands",
    retainer_status: "inactive",
    patches_enabled: false,
    pinned_version: "v1.0.11",
    fleet_repo: "Haverford-Brands/.github"
  }] });
  const summary = await runPushPatches({
    orgsConfigPath: orgsPath,
    callerTemplatesDir: templatesDir,
    owners: ["Haverford-Brands"],
    includeInactive: true,
    callerRef: "v1.0.11",
    dryRun: true,
    listConsumerRepos: async () => [{ owner: "Haverford-Brands", name: "website", branch: "main" }],
    cloneConsumer: async () => consumerDir
  });
  assert.equal(summary.orgs.length, 1);
  assert.equal(summary.orgs[0].name, "Haverford-Brands");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd 00_repos/pipeline-fleet && npm test -- tests/push-patches.test.mjs`

Expected: FAIL because `renderCallerTemplate`, `includeInactive`, and `callerRef` do not exist.

- [ ] **Step 3: Implement caller ref rendering**

```js
export function renderCallerTemplate(text, { callerRef = "v1" } = {}) {
  return text.replace(
    /(leebaroneau\/pipeline-core\/\.github\/workflows\/[^@\s]+@)v[0-9][0-9A-Za-z.-]*/g,
    `$1${callerRef}`
  );
}
```

Use `renderCallerTemplate()` inside `applyRefresh()` and `planRefresh()` before comparing template text to consumer workflow text.

- [ ] **Step 4: Implement inactive handoff selection**

Extend `runPushPatches()` parameters:

```js
includeInactive = false,
callerRef = "v1"
```

When `includeInactive` is true and `owners` contains a specific org, select that org even if `patches_enabled` is false. Refuse `includeInactive` without an explicit owner filter.

- [ ] **Step 5: Verify tests pass**

Run: `cd 00_repos/pipeline-fleet && npm test`

Expected: all pipeline-fleet tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
cd 00_repos/pipeline-fleet
git add scripts/push-patches.mjs tests/push-patches.test.mjs
git commit -m "feat: support inactive org handoff pinning"
```

---

### Task 3: Build The One-Shot Coolify Fleet Runner

**Files:**
- Create: `00_repos/pipeline-fleet/scripts/lib/git-runner.mjs`
- Create: `00_repos/pipeline-fleet/scripts/fleet-runner.mjs`
- Create: `00_repos/pipeline-fleet/tests/fleet-runner.test.mjs`
- Modify: `00_repos/pipeline-fleet/package.json`

- [ ] **Step 1: Write failing runner orchestration tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { planFleetRun } from "../scripts/fleet-runner.mjs";

test("planFleetRun selects one retainer and uses pinned core ref", () => {
  const plan = planFleetRun({
    org: {
      name: "Haverford-Brands",
      fleet_repo: "Haverford-Brands/.github",
      pinned_version: "v1.0.11"
    },
    mode: "both",
    commitChanges: true,
    workDir: "/tmp/work"
  });

  assert.deepEqual(plan.core, {
    repo: "https://github.com/leebaroneau/pipeline-core.git",
    ref: "v1.0.11",
    path: "/tmp/work/pipeline-core"
  });
  assert.equal(plan.fleet.repo, "https://x-access-token:${FLEET_PAT}@github.com/Haverford-Brands/.github.git");
  assert.equal(plan.commands.some((cmd) => cmd.args.includes("scripts/fleet-doctor.mjs")), true);
  assert.equal(plan.commands.some((cmd) => cmd.args.includes("scripts/discover.mjs")), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd 00_repos/pipeline-fleet && npm test -- tests/fleet-runner.test.mjs`

Expected: FAIL because `scripts/fleet-runner.mjs` does not exist.

- [ ] **Step 3: Implement command runner wrapper**

```js
import { spawnSync } from "node:child_process";

export function runCommand(cmd, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    const stderr = result.stderr || result.stdout || "";
    throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return result;
}
```

- [ ] **Step 4: Implement `planFleetRun()` and `runFleetOnce()`**

`runFleetOnce()` should:

1. Load `config/orgs.json`.
2. Select exactly `FLEET_OWNER` unless `ALLOW_MULTI_ORG=1`.
3. Clone the selected org's `fleet_repo`.
4. Clone `leebaroneau/pipeline-core` at `org.pinned_version || PIPELINE_CORE_REF || "v1"`.
5. Run `npm ci` in the cloned `pipeline-core`.
6. Run `scripts/fleet-doctor.mjs`, `scripts/discover.mjs`, and `scripts/update-tracker.mjs` based on `MODE`.
7. Commit and push state changes when `COMMIT_CHANGES=1`.
8. Print a JSON summary to stdout.

- [ ] **Step 5: Add package scripts**

```json
{
  "scripts": {
    "test": "node --test 'tests/**/*.test.mjs'",
    "fleet:run": "node scripts/fleet-runner.mjs --once",
    "fleet:dry-run": "COMMIT_CHANGES=0 node scripts/fleet-runner.mjs --once"
  }
}
```

- [ ] **Step 6: Verify tests pass**

Run: `cd 00_repos/pipeline-fleet && npm test`

Expected: all pipeline-fleet tests pass.

- [ ] **Step 7: Commit Task 3**

```bash
cd 00_repos/pipeline-fleet
git add package.json scripts/fleet-runner.mjs scripts/lib/git-runner.mjs tests/fleet-runner.test.mjs
git commit -m "feat: add retainer-hosted fleet runner"
```

---

### Task 4: Package The Runner For Coolify

**Files:**
- Create: `00_repos/pipeline-fleet/Dockerfile`
- Create: `00_repos/pipeline-fleet/docker-compose.coolify.yml`
- Create: `00_repos/pipeline-fleet/.env.example`
- Modify: `00_repos/pipeline-fleet/README.md`

- [ ] **Step 1: Add Dockerfile with baked command**

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "scripts/fleet-runner.mjs", "--once"]
```

The `CMD` is baked into the image because Coolify Dockerfile deployments do not reliably inject `start_command` at runtime in Lee's current Coolify setup.

- [ ] **Step 2: Add Coolify compose template**

```yaml
services:
  pipeline-fleet-runner:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      FLEET_OWNER: ${FLEET_OWNER:?Set the GitHub org name}
      FLEET_PAT: ${FLEET_PAT:?Set a repo/read:org token scoped to this retainer}
      ORGS_CONFIG_PATH: ${ORGS_CONFIG_PATH:-config/orgs.json}
      MODE: ${MODE:-both}
      COMMIT_CHANGES: ${COMMIT_CHANGES:-1}
      PIPELINE_CORE_REF: ${PIPELINE_CORE_REF:-v1}
    restart: "no"
```

- [ ] **Step 3: Add `.env.example`**

```env
FLEET_OWNER=Haverford-Brands
FLEET_PAT=ghp_replace_me
ORGS_CONFIG_PATH=config/orgs.json
MODE=both
COMMIT_CHANGES=1
PIPELINE_CORE_REF=v1
```

- [ ] **Step 4: Build smoke test**

Run: `cd 00_repos/pipeline-fleet && docker build -t pipeline-fleet-runner:test .`

Expected: image builds successfully.

- [ ] **Step 5: Commit Task 4**

```bash
cd 00_repos/pipeline-fleet
git add Dockerfile docker-compose.coolify.yml .env.example README.md
git commit -m "feat: package fleet runner for Coolify"
```

---

### Task 5: Adjust Pipeline Core Fleet Template For Retainer Hosting

**Files:**
- Modify: `00_repos/pipeline-core/templates/fleet/fleet.yml`
- Modify: `00_repos/pipeline-core/templates/fleet/README.md`

- [ ] **Step 1: Change new fleet template to manual fallback only**

Replace:

```yaml
on:
  schedule:
    - cron: "0 9 * * *"
  workflow_dispatch:
```

With:

```yaml
on:
  workflow_dispatch:
```

- [ ] **Step 2: Update template README**

Add this wording to `templates/fleet/README.md`:

```md
Preferred runtime: deploy `leebaroneau/pipeline-fleet` as a retainer-hosted Coolify runner. This `.github` workflow remains as a manual fallback only, so scheduled sweeps do not run in both GitHub Actions and Coolify.
```

- [ ] **Step 3: Run Pipeline Core tests**

Run: `cd 00_repos/pipeline-core && npm test`

Expected: all pipeline-core tests pass.

- [ ] **Step 4: Commit Task 5**

```bash
cd 00_repos/pipeline-core
git add templates/fleet/fleet.yml templates/fleet/README.md
git commit -m "feat: prefer retainer-hosted fleet sweeps"
```

---

### Task 6: Write Operator Docs And Repo Boundary Explanation

**Files:**
- Create: `00_repos/pipeline-fleet/docs/retainer-hosted-fleet-runner.md`
- Modify: `00_repos/pipeline-fleet/README.md`

- [ ] **Step 1: Add operator guide**

The guide must include:

- Repo map from this plan.
- Coolify deployment steps.
- Required env vars.
- Manual test command: `npm run fleet:dry-run`.
- Verification checklist.
- Offboarding checklist.
- Warning that consumer callers must be pinned from `@v1` to `@v1.0.X` before support stops.

- [ ] **Step 2: Add README summary**

Add a short section linking to `docs/retainer-hosted-fleet-runner.md` and stating:

```md
Retainer-hosted mode runs the daily fleet sweep on each retainer's Coolify server. Lee controls template releases and patch pushes from this repo, but runtime execution and org-scoped tokens live with the retainer.
```

- [ ] **Step 3: Commit Task 6**

```bash
cd 00_repos/pipeline-fleet
git add README.md docs/retainer-hosted-fleet-runner.md
git commit -m "docs: explain retainer-hosted fleet runner"
```

---

### Task 7: Verify With A Safe Haverford Pilot

**Files:**
- Modify only after verification: `Haverford-Brands/.github/.github/workflows/fleet.yml`

- [ ] **Step 1: Run local dry-run for Haverford**

Run:

```bash
cd 00_repos/pipeline-fleet
FLEET_OWNER=Haverford-Brands \
FLEET_PAT="$(gh auth token)" \
COMMIT_CHANGES=0 \
MODE=both \
npm run fleet:dry-run
```

Expected: JSON summary shows Haverford selected, `pipeline-core` ref `v1`, and no push.

- [ ] **Step 2: Deploy to Haverford Coolify**

Set runtime-only environment variables:

```env
FLEET_OWNER=Haverford-Brands
FLEET_PAT=<Haverford-scoped PAT>
MODE=both
COMMIT_CHANGES=1
PIPELINE_CORE_REF=v1
```

Schedule the Coolify job with the same cadence as the old workflow after confirming Coolify's cron field accepts the desired syntax.

- [ ] **Step 3: Run one manual Coolify execution**

Expected:

- `Haverford-Brands/.github/state/results.json` updates.
- `Haverford-Brands/.github/state/discovery.json` updates.
- `Haverford-Brands/.github/README.md` tracker updates.
- No consumer repo files are changed.

- [ ] **Step 4: Disable old GitHub Actions schedule**

Open a PR in `Haverford-Brands/.github` that removes only the `schedule:` block from `.github/workflows/fleet.yml`. Keep `workflow_dispatch`.

- [ ] **Step 5: Repeat for other retainers**

Rollout order:

1. `Haverford-Brands`
2. `ALX-Finance`
3. `Genvest-Property`
4. `kwa-nguyen`
5. `leebaroneau` self fleet, if Lee wants his own server-hosted runner too

---

### Task 8: Offboarding Procedure

**Files:**
- Modify: `00_repos/pipeline-fleet/config/orgs.json`
- Consumer repos in the offboarded org, via generated PRs from `push-patches.mjs`

- [ ] **Step 1: Freeze org in registry**

Example:

```json
{
  "name": "Haverford-Brands",
  "retainer_status": "inactive",
  "deployment_mode": "retainer-coolify",
  "runner_enabled": true,
  "patches_enabled": false,
  "pinned_version": "v1.0.11",
  "fleet_repo": "Haverford-Brands/.github",
  "notes": "Inactive. Runner may continue on retainer server, pinned to v1.0.11."
}
```

- [ ] **Step 2: Open final caller pin PRs**

Run:

```bash
cd 00_repos/pipeline-fleet
FLEET_PAT="$(gh auth token)" node scripts/push-patches.mjs \
  --orgs-config config/orgs.json \
  --templates ../pipeline-core/templates/caller-workflows \
  --owner Haverford-Brands \
  --include-inactive \
  --caller-ref v1.0.11 \
  --new-version v1.0.11
```

Expected: PRs in Haverford consumer repos change caller workflows from `@v1` to `@v1.0.11`.

- [ ] **Step 3: Update retainer Coolify env**

Set:

```env
PIPELINE_CORE_REF=v1.0.11
```

- [ ] **Step 4: Stop Lee-side patch pushes**

Verify:

```bash
cd 00_repos/pipeline-fleet
FLEET_PAT="$(gh auth token)" node scripts/push-patches.mjs \
  --orgs-config config/orgs.json \
  --templates ../pipeline-core/templates/caller-workflows \
  --dry-run
```

Expected: inactive org appears in skipped output and no consumer repo work is planned.

---

## Final Verification

- [ ] `cd 00_repos/pipeline-fleet && npm test`
- [ ] `cd 00_repos/pipeline-core && npm test`
- [ ] `cd 00_repos/pipeline-fleet && docker build -t pipeline-fleet-runner:test .`
- [ ] Haverford Coolify manual run updates only `Haverford-Brands/.github`.
- [ ] Old Haverford GitHub Actions schedule is removed after Coolify succeeds.
- [ ] Dry-run patch cascade skips inactive orgs by default.
- [ ] One-time handoff pin command can target an inactive org explicitly.

## Self-Review

- Spec coverage: covers repo ownership, retainer-hosted Coolify runtime, no extra GitHub repo, patch-stop controls, runner-stop controls, and offboarding pin behavior.
- Placeholder scan: no unresolved placeholder language or unspecified implementation steps remain.
- Type consistency: lifecycle fields are consistently named `deployment_mode`, `runner_enabled`, `patches_enabled`, and `pinned_version`.
