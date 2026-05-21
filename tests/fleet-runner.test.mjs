import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { planFleetRun, runFleetOnce } from "../scripts/fleet-runner.mjs";

function tempConfig(body) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-runner-config-"));
  const path = join(dir, "orgs.json");
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test("planFleetRun pins pipeline-core clone to org pinned_version", () => {
  const plan = planFleetRun({
    org: {
      name: "ALX-Finance",
      fleet_repo: "ALX-Finance/.github",
      pinned_version: "v1.0.11",
    },
    workDir: "/tmp/fleet-runner-test",
  });

  assert.deepEqual(plan.core, {
    repo: "leebaroneau/pipeline-core",
    ref: "v1.0.11",
    dir: "/tmp/fleet-runner-test/pipeline-core",
  });
  assert.equal(plan.commands.find((cmd) => cmd.name === "core:checkout").args.at(-1), "v1.0.11");
});

test("runFleetOnce selects exactly FLEET_OWNER and uses pinned core ref", async () => {
  const orgsConfigPath = tempConfig({
    orgs: [
      {
        name: "Haverford-Brands",
        retainer_status: "active",
        fleet_repo: "Haverford-Brands/.github",
      },
      {
        name: "ALX-Finance",
        retainer_status: "active",
        pinned_version: "v1.0.11",
        fleet_repo: "ALX-Finance/.github",
      },
    ],
  });
  const workDir = mkdtempSync(join(tmpdir(), "fleet-runner-work-"));
  const calls = [];

  const summary = await runFleetOnce({
    env: {
      ORGS_CONFIG_PATH: orgsConfigPath,
      FLEET_OWNER: "ALX-Finance",
      FLEET_PAT: "token",
      MODE: "doctor",
      COMMIT_CHANGES: "0",
      WORK_DIR: workDir,
      QUIET: "1",
    },
    mkdtempSync: () => workDir,
    tmpdir: () => tmpdir(),
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd, env: options?.env });
      if (cmd === "git" && args[0] === "-C" && args[2] === "status") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(summary.orgs.length, 1);
  assert.equal(summary.orgs[0].name, "ALX-Finance");
  assert.equal(summary.plan.core.ref, "v1.0.11");
  assert.ok(calls.some((call) => call.args.some((arg) => arg.includes("ALX-Finance/.github.git"))));
  assert.ok(calls.some((call) => call.args[0] === "-C" && call.args.at(-1) === "v1.0.11"));
  assert.ok(calls.some((call) => call.args.some((arg) => arg.includes("fleet-doctor.mjs"))));
  assert.ok(calls.some((call) => call.args.some((arg) => arg.includes("update-tracker.mjs"))));
  assert.ok(!calls.some((call) => call.args.some((arg) => arg.includes("discover.mjs"))));
});
