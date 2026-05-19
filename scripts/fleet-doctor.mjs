#!/usr/bin/env node

// scripts/fleet-doctor.mjs
//
// Drives the Pipeline Core install doctor across every repo listed in
// config/repos.json. For each entry:
//   1. Shallow-clones the repo into a temp dir using FLEET_PAT
//   2. Runs `pipeline-core/scripts/doctor.mjs --json --owner ... --repo-name ...`
//   3. Collects { ok, failures, warnings } into state/results.json
//
// The result file is the canonical input for:
//   - scripts/update-tracker.mjs    (renders this repo's README)
//   - scripts/update-org-dashboards.mjs  (Phase 3+; writes per-org dashboards)
//
// Designed to run nightly from .github/workflows/fleet-doctor.yml. Also runs
// fine locally for an operator: `FLEET_PAT=$(gh auth token) make fleet-doctor`.

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const REPOS_CONFIG = join(REPO_ROOT, "config", "repos.json");
const RESULTS_FILE = join(REPO_ROOT, "state", "results.json");

// pipeline-core is expected to be available locally — the workflow checks it
// out under .pipeline-core/, and for local runs the operator runs from a
// sibling checkout (00_repos/pipeline-core in our setup).
const DEFAULT_PIPELINE_CORE = process.env.PIPELINE_CORE_PATH
  ?? (existsSync(join(REPO_ROOT, ".pipeline-core")) ? join(REPO_ROOT, ".pipeline-core") : null)
  ?? (existsSync(join(REPO_ROOT, "..", "pipeline-core")) ? join(REPO_ROOT, "..", "pipeline-core") : null);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  if (r.status !== 0 && !opts.allowFailure) {
    const err = new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr || r.stdout}`);
    err.status = r.status;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return r;
}

function loadRepos(configPath = REPOS_CONFIG) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.repos ?? [];
  for (const e of entries) {
    if (!e.owner || !e.name) throw new Error(`config entry missing owner/name: ${JSON.stringify(e)}`);
    e.branch ??= "main";
    e.tier ??= 1;
  }
  return entries;
}

function cloneShallow({ owner, name, branch, token, into }) {
  // Auth via token in URL is fine for `git clone`; not stored on disk.
  const url = `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
  run("git", [
    "clone",
    "--depth", "1",
    "--single-branch",
    "--branch", branch,
    "--filter=blob:none",
    "--sparse",
    url,
    into,
  ]);
  run("git", ["-C", into, "sparse-checkout", "set", ".github"]);
}

function runDoctor({ doctorPath, repoDir, owner, name, branch, token }) {
  const env = { ...process.env, GITHUB_TOKEN: token };
  const r = run("node", [
    doctorPath,
    "--repo", repoDir,
    "--owner", owner,
    "--repo-name", name,
    "--branch", branch,
    "--json",
  ], { env, allowFailure: true });
  try {
    return { result: JSON.parse(r.stdout), exitCode: r.status };
  } catch {
    return {
      result: { ok: false, failures: [{ check: "fleet", message: `doctor produced non-JSON output: ${r.stderr || r.stdout}`.slice(0, 500) }], warnings: [] },
      exitCode: r.status ?? -1,
    };
  }
}

export async function runFleetDoctor({
  configPath = REPOS_CONFIG,
  pipelineCorePath = DEFAULT_PIPELINE_CORE,
  resultsPath = RESULTS_FILE,
  token = process.env.FLEET_PAT ?? process.env.GITHUB_TOKEN,
} = {}) {
  if (!pipelineCorePath) {
    throw new Error("Cannot find pipeline-core. Set PIPELINE_CORE_PATH or check out pipeline-core into .pipeline-core/ or ../pipeline-core/");
  }
  if (!token) {
    throw new Error("Cannot run without an auth token. Set FLEET_PAT (preferred) or GITHUB_TOKEN.");
  }

  const doctorPath = join(pipelineCorePath, "scripts", "doctor.mjs");
  if (!existsSync(doctorPath)) {
    throw new Error(`doctor.mjs not found at ${doctorPath}`);
  }

  const repos = loadRepos(configPath);
  const results = [];
  const startedAt = new Date().toISOString();

  for (const entry of repos) {
    const slug = `${entry.owner}/${entry.name}`;
    process.stdout.write(`[fleet-doctor] ${slug}@${entry.branch} ... `);
    const cloneDir = mkdtempSync(join(tmpdir(), `fleet-doctor-${entry.name}-`));
    try {
      cloneShallow({ owner: entry.owner, name: entry.name, branch: entry.branch, token, into: cloneDir });
      const { result, exitCode } = runDoctor({
        doctorPath,
        repoDir: cloneDir,
        owner: entry.owner,
        name: entry.name,
        branch: entry.branch,
        token,
      });
      results.push({ ...entry, result, exitCode, error: null });
      process.stdout.write(result.ok ? "OK\n" : `FAIL (${result.failures?.length ?? "?"} failure(s))\n`);
    } catch (err) {
      results.push({
        ...entry,
        result: { ok: false, failures: [{ check: "fleet", message: err.message.slice(0, 500) }], warnings: [] },
        exitCode: -1,
        error: err.message.slice(0, 500),
      });
      process.stdout.write(`ERROR (${err.status ?? "?"})\n`);
    } finally {
      try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    startedAt,
    pipelineCorePath: pipelineCorePath.replace(process.env.HOME ?? "", "~"),
    totals: {
      managed: results.length,
      ok: results.filter((r) => r.result?.ok).length,
      failing: results.filter((r) => !r.result?.ok).length,
      warningsOnly: results.filter((r) => r.result?.ok && (r.result.warnings?.length ?? 0) > 0).length,
    },
    results,
  };

  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`\nWrote ${resultsPath}\nManaged: ${summary.totals.managed}, OK: ${summary.totals.ok}, Failing: ${summary.totals.failing}\n`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/fleet-doctor.mjs")) {
  runFleetDoctor().catch((err) => {
    process.stderr.write(`fleet-doctor.mjs failed: ${err.message}\n`);
    process.exit(1);
  });
}
