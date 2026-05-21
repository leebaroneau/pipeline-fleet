import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { planFleetRun, runFleetOnce } from "../scripts/fleet-runner.mjs";
import { runCommand } from "../scripts/lib/git-runner.mjs";

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

test("runFleetOnce clones pipeline-core without retainer token and sanitizes npm ci env", async () => {
  const orgsConfigPath = tempConfig({
    orgs: [{
      name: "Haverford-Brands",
      retainer_status: "active",
      fleet_repo: "Haverford-Brands/.github",
    }],
  });
  const calls = [];

  await runFleetOnce({
    env: {
      ORGS_CONFIG_PATH: orgsConfigPath,
      FLEET_OWNER: "Haverford-Brands",
      FLEET_PAT: "fleet-secret",
      GITHUB_TOKEN: "github-secret",
      MODE: "doctor",
      COMMIT_CHANGES: "0",
      WORK_DIR: mkdtempSync(join(tmpdir(), "fleet-runner-tokens-")),
      QUIET: "1",
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      npm_config_cache: "/tmp/npm-cache",
      SOME_API_TOKEN: "other-secret",
    },
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd, env: options?.env });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const cloneCalls = calls.filter((call) => call.cmd === "git" && call.args[0] === "clone");
  const fleetClone = cloneCalls.find((call) => call.args.some((arg) => arg.includes("Haverford-Brands/.github.git")));
  const coreClone = cloneCalls.find((call) => call.args.some((arg) => arg.includes("leebaroneau/pipeline-core.git")));
  const npmCi = calls.find((call) => call.cmd === "npm" && call.args[0] === "ci");

  assert.ok(fleetClone.args.some((arg) => arg.includes("fleet-secret")));
  assert.deepEqual(coreClone.args, [
    "clone",
    "https://github.com/leebaroneau/pipeline-core.git",
    coreClone.args[2],
  ]);
  assert.equal(coreClone.env.FLEET_PAT, undefined);
  assert.equal(coreClone.env.GITHUB_TOKEN, undefined);
  assert.equal(npmCi.env.PATH, "/usr/bin");
  assert.equal(npmCi.env.HOME, "/tmp/home");
  assert.equal(npmCi.env.npm_config_cache, "/tmp/npm-cache");
  assert.equal(npmCi.env.FLEET_PAT, undefined);
  assert.equal(npmCi.env.GITHUB_TOKEN, undefined);
  assert.equal(npmCi.env.PIPELINE_CORE_TOKEN, undefined);
  assert.equal(npmCi.env.SOME_API_TOKEN, undefined);
});

test("runFleetOnce keeps PIPELINE_CORE_TOKEN out of npm ci env when private core clone is requested", async () => {
  const orgsConfigPath = tempConfig({
    orgs: [{
      name: "Haverford-Brands",
      retainer_status: "active",
      fleet_repo: "Haverford-Brands/.github",
    }],
  });
  const calls = [];

  await runFleetOnce({
    env: {
      ORGS_CONFIG_PATH: orgsConfigPath,
      FLEET_OWNER: "Haverford-Brands",
      FLEET_PAT: "fleet-secret",
      PIPELINE_CORE_TOKEN: "core-secret",
      MODE: "doctor",
      COMMIT_CHANGES: "0",
      WORK_DIR: mkdtempSync(join(tmpdir(), "fleet-runner-core-token-")),
      QUIET: "1",
      PATH: "/usr/bin",
      HOME: "/tmp/home",
    },
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd, env: options?.env });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const coreClone = calls.find((call) => (
    call.cmd === "git"
    && call.args[0] === "clone"
    && call.args.some((arg) => arg.includes("leebaroneau/pipeline-core.git"))
  ));
  const npmCi = calls.find((call) => call.cmd === "npm" && call.args[0] === "ci");

  assert.ok(coreClone.args.some((arg) => arg.includes("core-secret")));
  assert.ok(!coreClone.args.some((arg) => arg.includes("fleet-secret")));
  assert.equal(coreClone.env.FLEET_PAT, undefined);
  assert.equal(coreClone.env.PIPELINE_CORE_TOKEN, undefined);
  assert.equal(npmCi.env.PIPELINE_CORE_TOKEN, undefined);
});

test("planFleetRun orders both mode as doctor, discover, update-tracker", () => {
  const plan = planFleetRun({
    org: {
      name: "Haverford-Brands",
      fleet_repo: "Haverford-Brands/.github",
    },
    mode: "both",
    workDir: "/tmp/fleet-runner-test",
  });

  assert.deepEqual(
    plan.commands
      .filter((cmd) => cmd.name.startsWith("core:"))
      .map((cmd) => cmd.name),
    [
      "core:clone",
      "core:checkout",
      "core:npm-ci",
      "core:fleet-doctor",
      "core:discover",
      "core:update-tracker",
    ],
  );
});

test("runFleetOnce configures git identity before committing changed state", async () => {
  const orgsConfigPath = tempConfig({
    orgs: [{
      name: "Haverford-Brands",
      retainer_status: "active",
      fleet_repo: "Haverford-Brands/.github",
    }],
  });
  const calls = [];

  const summary = await runFleetOnce({
    env: {
      ORGS_CONFIG_PATH: orgsConfigPath,
      FLEET_OWNER: "Haverford-Brands",
      FLEET_PAT: "token",
      MODE: "doctor",
      COMMIT_CHANGES: "1",
      WORK_DIR: mkdtempSync(join(tmpdir(), "fleet-runner-commit-")),
      QUIET: "1",
    },
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd, env: options?.env });
      if (cmd === "git" && args.includes("status")) {
        return { status: 0, stdout: " M state/results.json\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const gitArgs = calls.filter((call) => call.cmd === "git").map((call) => call.args);
  const nameIndex = gitArgs.findIndex((args) => args.includes("user.name"));
  const emailIndex = gitArgs.findIndex((args) => args.includes("user.email"));
  const commitIndex = gitArgs.findIndex((args) => args.includes("commit"));

  assert.equal(summary.orgs[0].git.committed, true);
  assert.ok(nameIndex >= 0, "configures user.name");
  assert.ok(emailIndex >= 0, "configures user.email");
  assert.ok(commitIndex >= 0, "runs git commit");
  assert.ok(nameIndex < commitIndex, "configures user.name before commit");
  assert.ok(emailIndex < commitIndex, "configures user.email before commit");
  assert.deepEqual(gitArgs[nameIndex].slice(-2), ["user.name", "github-actions[bot]"]);
  assert.deepEqual(gitArgs[emailIndex].slice(-2), [
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
});

test("runFleetOnce skips git config and commit when scoped state is unchanged", async () => {
  const orgsConfigPath = tempConfig({
    orgs: [{
      name: "Haverford-Brands",
      retainer_status: "active",
      fleet_repo: "Haverford-Brands/.github",
    }],
  });
  const calls = [];

  const summary = await runFleetOnce({
    env: {
      ORGS_CONFIG_PATH: orgsConfigPath,
      FLEET_OWNER: "Haverford-Brands",
      FLEET_PAT: "token",
      MODE: "doctor",
      COMMIT_CHANGES: "1",
      WORK_DIR: mkdtempSync(join(tmpdir(), "fleet-runner-noop-")),
      QUIET: "1",
    },
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd, env: options?.env });
      if (cmd === "git" && args.includes("status")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const gitArgs = calls.filter((call) => call.cmd === "git").map((call) => call.args);

  assert.equal(summary.orgs[0].git.committed, false);
  assert.ok(!gitArgs.some((args) => args.includes("user.name")));
  assert.ok(!gitArgs.some((args) => args.includes("user.email")));
  assert.ok(!gitArgs.some((args) => args.includes("commit")));
});

test("runCommand reports spawn failures clearly", () => {
  assert.throws(
    () => runCommand("__pipeline_fleet_missing_binary__", []),
    /failed to start.*ENOENT/i,
  );
});

test("runCommand redacts explicit token env values from thrown errors", () => {
  let err;
  try {
    runCommand(
      process.execPath,
      ["-e", "console.log(process.env.FLEET_PAT); console.error(process.env.GITHUB_TOKEN); process.exit(7)"],
      {
        env: {
          PATH: process.env.PATH,
          FLEET_PAT: "fleet-secret",
          GITHUB_TOKEN: "github-secret",
          PIPELINE_CORE_TOKEN: "core-secret",
        },
      },
    );
  } catch (caught) {
    err = caught;
  }

  assert.ok(err);
  assert.match(err.message, /\*\*\*/);
  assert.match(err.stdout, /\*\*\*/);
  assert.match(err.stderr, /\*\*\*/);
  assert.doesNotMatch(err.message, /fleet-secret|github-secret|core-secret/);
  assert.doesNotMatch(err.stdout, /fleet-secret|github-secret|core-secret/);
  assert.doesNotMatch(err.stderr, /fleet-secret|github-secret|core-secret/);
});
