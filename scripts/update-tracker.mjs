#!/usr/bin/env node

// scripts/update-tracker.mjs
//
// Reads state/results.json (produced by scripts/fleet-doctor.mjs) and replaces
// the content between the `<!-- pipeline-fleet:tracker-start -->` and
// `<!-- pipeline-fleet:tracker-end -->` markers in README.md with a rendered
// status table. Idempotent — run any time, produces deterministic output.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const RESULTS = join(REPO_ROOT, "state", "results.json");
const README = join(REPO_ROOT, "README.md");

const START = "<!-- pipeline-fleet:tracker-start -->";
const END = "<!-- pipeline-fleet:tracker-end -->";

export function renderTracker(summary) {
  if (!summary?.results?.length) {
    return "_No repos under management yet. Add entries to `config/repos.json` and the next daily run will populate this table._";
  }

  const lines = [];
  const { totals } = summary;
  lines.push(`**${totals.managed}** repo${totals.managed === 1 ? "" : "s"} under management · **${totals.ok}** OK · **${totals.failing}** failing · **${totals.warningsOnly}** with warnings`);
  lines.push("");
  lines.push(`_Updated ${summary.generatedAt}._`);
  lines.push("");
  lines.push("| Repo | Status | Failures | Warnings |");
  lines.push("| --- | --- | ---: | ---: |");

  const sorted = [...summary.results].sort((a, b) => {
    // Failing first, then warning-only, then ok. Inside each group, owner/name.
    const score = (r) => (r.result?.ok ? (r.result.warnings?.length ? 1 : 2) : 0);
    return score(a) - score(b) || `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
  });

  for (const r of sorted) {
    const status = r.result?.ok
      ? (r.result.warnings?.length ? "⚠️ warn" : "✅ ok")
      : "❌ fail";
    const failures = r.result?.failures?.length ?? 0;
    const warnings = r.result?.warnings?.length ?? 0;
    lines.push(`| [\`${r.owner}/${r.name}\`](https://github.com/${r.owner}/${r.name}) | ${status} | ${failures} | ${warnings} |`);
  }
  return lines.join("\n");
}

export function spliceTracker({ readme, tracker, generatedAt }) {
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README is missing tracker markers (${START}, ${END})`);
  }
  const before = readme.slice(0, startIdx + START.length);
  const after = readme.slice(endIdx);
  let out = `${before}\n${tracker}\n${after}`;
  // Update the "Last updated" line below the tracker block too.
  out = out.replace(
    /_Updated by: `scripts\/update-tracker\.mjs`\. Last updated:.*?\._/,
    `_Updated by: \`scripts/update-tracker.mjs\`. Last updated: ${generatedAt}._`,
  );
  return out;
}

export function updateTracker({ resultsPath = RESULTS, readmePath = README } = {}) {
  const summary = JSON.parse(readFileSync(resultsPath, "utf8"));
  const tracker = renderTracker(summary);
  const readme = readFileSync(readmePath, "utf8");
  const next = spliceTracker({ readme, tracker, generatedAt: summary.generatedAt });
  if (next !== readme) {
    writeFileSync(readmePath, next);
    process.stdout.write(`Updated ${readmePath}\n`);
  } else {
    process.stdout.write(`${readmePath} already up to date\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/update-tracker.mjs")) {
  try {
    updateTracker();
  } catch (err) {
    process.stderr.write(`update-tracker.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
