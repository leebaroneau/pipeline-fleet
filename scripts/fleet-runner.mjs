#!/usr/bin/env node

import { mkdirSync, mkdtempSync as fsMkdtempSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOrgRegistry, runnerTargets } from "./lib/orgs-config.mjs";
import { runCommand as defaultRunCommand } from "./lib/git-runner.mjs";

const DEFAULT_CORE_REF = "v1";
const DEFAULT_MODE = "both";
const DEFAULT_ORGS_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "orgs.json");
const DEFAULT_GIT_USER_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const DEFAULT_GIT_USER_NAME = "github-actions[bot]";
const SAFE_NPM_ENV_KEYS = new Set(["CI", "HOME", "LOGNAME", "NODE_ENV", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"]);
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|(^|_)PAT($|_))/i;
const VALID_MODES = new Set(["doctor", "discover", "both"]);

function gitHubTokenUrl(repo, token) {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

function publicGitHubUrl(repo) {
  return `https://github.com/${repo}.git`;
}

function pipelineCoreCloneUrl(env) {
  return env.PIPELINE_CORE_TOKEN
    ? gitHubTokenUrl("leebaroneau/pipeline-core", env.PIPELINE_CORE_TOKEN)
    : publicGitHubUrl("leebaroneau/pipeline-core");
}

function sanitizedRuntimeEnv(env) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SECRET_ENV_KEY.test(key)) continue;
    if (SAFE_NPM_ENV_KEYS.has(key) || /^npm_config_/i.test(key)) {
      next[key] = value;
    }
  }
  return next;
}

function boolEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === "1" || value === "true";
}

function command(name, cmd, args, { cwd, env } = {}) {
  return {
    name,
    cmd,
    args,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
  };
}

export function planFleetRun({ org, mode = DEFAULT_MODE, commitChanges = true, workDir, coreRef = DEFAULT_CORE_REF }) {
  if (!org?.name) throw new Error("planFleetRun needs org.name.");
  if (!org?.fleet_repo) throw new Error(`planFleetRun needs fleet_repo for ${org.name}.`);
  if (!workDir) throw new Error("planFleetRun needs workDir.");
  if (!VALID_MODES.has(mode)) throw new Error(`Unsupported MODE: ${mode}`);

  const fleetDir = join(workDir, "fleet");
  const coreDir = join(workDir, "pipeline-core");
  const effectiveCoreRef = org.pinned_version || coreRef;
  const configPath = join(fleetDir, "config", "repos.json");
  const stateDir = join(fleetDir, "state");
  const resultsPath = join(stateDir, "results.json");
  const readmePath = join(fleetDir, "README.md");

  const commands = [
    command("fleet:clone", "git", ["clone", publicGitHubUrl(org.fleet_repo), fleetDir]),
    command("core:clone", "git", ["clone", publicGitHubUrl("leebaroneau/pipeline-core"), coreDir]),
    command("core:checkout", "git", ["-C", coreDir, "checkout", effectiveCoreRef]),
    command("core:npm-ci", "npm", ["ci"], { cwd: coreDir }),
  ];

  if (mode === "doctor" || mode === "both") {
    commands.push(command("core:fleet-doctor", "node", ["scripts/fleet-doctor.mjs"], {
      cwd: coreDir,
      env: {
        CONFIG_PATH: configPath,
        RESULTS_PATH: resultsPath,
      },
    }));
  }

  if (mode === "discover" || mode === "both") {
    commands.push(command("core:discover", "node", ["scripts/discover.mjs"], {
      cwd: coreDir,
      env: {
        OWNER: org.name,
        CONFIG_DIR: join(fleetDir, "config"),
        STATE_DIR: stateDir,
      },
    }));
  }

  if (mode === "doctor" || mode === "both") {
    commands.push(command("core:update-tracker", "node", ["scripts/update-tracker.mjs"], {
      cwd: coreDir,
      env: {
        RESULTS_PATH: resultsPath,
        README_PATH: readmePath,
      },
    }));
  }

  if (commitChanges) {
    commands.push(
      command("fleet:status", "git", ["-C", fleetDir, "status", "--porcelain", "--", "state", "README.md"]),
      command("fleet:add", "git", ["-C", fleetDir, "add", "state", "README.md"]),
      command("fleet:commit", "git", ["-C", fleetDir, "commit", "-m", `chore: update ${org.name} fleet state`]),
      command("fleet:push", "git", ["-C", fleetDir, "push"]),
    );
  }

  return {
    org: org.name,
    mode,
    commitChanges,
    workDir,
    fleet: {
      repo: org.fleet_repo,
      dir: fleetDir,
      configPath,
      stateDir,
      resultsPath,
      readmePath,
    },
    core: {
      repo: "leebaroneau/pipeline-core",
      ref: effectiveCoreRef,
      dir: coreDir,
    },
    commands,
  };
}

function runPlannedCommand(runCommand, item, env) {
  return runCommand(item.cmd, item.args, {
    cwd: item.cwd,
    env: {
      ...env,
      ...(item.env ?? {}),
    },
  });
}

function executeCommitIfChanged({ plan, runCommand, env }) {
  const status = runCommand("git", ["-C", plan.fleet.dir, "status", "--porcelain", "--", "state", "README.md"], { env });
  if (!status.stdout?.trim()) {
    return { committed: false, pushed: false, reason: "no changes" };
  }

  runCommand("git", ["-C", plan.fleet.dir, "config", "user.name", DEFAULT_GIT_USER_NAME], { env });
  runCommand("git", ["-C", plan.fleet.dir, "config", "user.email", DEFAULT_GIT_USER_EMAIL], { env });
  runCommand("git", ["-C", plan.fleet.dir, "add", "state", "README.md"], { env });
  runCommand("git", ["-C", plan.fleet.dir, "commit", "-m", `chore: update ${plan.org} fleet state`], { env });
  runCommand("git", ["-C", plan.fleet.dir, "push"], { env });
  return { committed: true, pushed: true, reason: "changes pushed" };
}

export async function runFleetOnce({
  env = process.env,
  runCommand = defaultRunCommand,
  mkdtempSync = fsMkdtempSync,
  tmpdir = osTmpdir,
} = {}) {
  const orgsConfigPath = env.ORGS_CONFIG_PATH || DEFAULT_ORGS_CONFIG_PATH;
  const registry = loadOrgRegistry(orgsConfigPath);
  const allowMultiOrg = env.ALLOW_MULTI_ORG === "1";
  const targets = runnerTargets(registry, { owner: env.FLEET_OWNER, allowMultiOrg });

  if (!allowMultiOrg && targets.length !== 1) {
    throw new Error(`Fleet runner needs exactly one FLEET_OWNER target; found ${targets.length}.`);
  }
  if (allowMultiOrg && targets.length < 1) {
    throw new Error("Fleet runner found no runner-enabled orgs.");
  }

  const token = env.FLEET_PAT || env.GITHUB_TOKEN;
  if (!token) throw new Error("Fleet runner needs FLEET_PAT or GITHUB_TOKEN.");

  const mode = env.MODE || DEFAULT_MODE;
  const commitChanges = boolEnv(env.COMMIT_CHANGES, true);
  const workDir = env.WORK_DIR || mkdtempSync(join(tmpdir(), "fleet-runner-"));
  const orgSummaries = [];
  let lastPlan = null;

  for (const org of targets) {
    const orgWorkDir = targets.length > 1 ? join(workDir, org.name) : workDir;
    mkdirSync(orgWorkDir, { recursive: true });

    const plan = planFleetRun({
      org,
      mode,
      commitChanges,
      workDir: orgWorkDir,
      coreRef: env.PIPELINE_CORE_REF || DEFAULT_CORE_REF,
    });
    lastPlan = plan;

    runCommand("git", ["clone", gitHubTokenUrl(org.fleet_repo, token), plan.fleet.dir], { env });
    runCommand("git", ["clone", pipelineCoreCloneUrl(env), plan.core.dir], { env: sanitizedRuntimeEnv(env) });
    runCommand("git", ["-C", plan.core.dir, "checkout", plan.core.ref], { env });
    runCommand("npm", ["ci"], { cwd: plan.core.dir, env: sanitizedRuntimeEnv(env) });

    for (const item of plan.commands) {
      if (["fleet:clone", "core:clone", "core:checkout", "core:npm-ci"].includes(item.name)) continue;
      if (item.name.startsWith("fleet:")) continue;
      runPlannedCommand(runCommand, item, env);
    }

    const git = commitChanges
      ? executeCommitIfChanged({ plan, runCommand, env })
      : { committed: false, pushed: false, reason: "commit disabled" };

    orgSummaries.push({
      name: org.name,
      fleetRepo: org.fleet_repo,
      coreRef: plan.core.ref,
      mode,
      git,
    });
  }

  const summary = {
    ok: true,
    orgs: orgSummaries,
    invalidOrgs: registry.invalid,
    plan: lastPlan,
  };

  if (env.QUIET !== "1") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary;
}

async function main() {
  if (!process.argv.includes("--once")) {
    throw new Error("Usage: node scripts/fleet-runner.mjs --once");
  }
  await runFleetOnce();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
