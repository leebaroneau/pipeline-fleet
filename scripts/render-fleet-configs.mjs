#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fleetConfigForOrg, loadOrgRegistry } from "./lib/orgs-config.mjs";

function parseArgs(argv) {
  const args = { owners: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--orgs-config") args.orgsConfigPath = argv[++i];
    else if (arg === "--out") args.outDir = argv[++i];
    else if (arg === "--owner") args.owners.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

const HELP = `Usage: render-fleet-configs.mjs --orgs-config <path> --out <dir> [--owner <name>]

Renders per-org fleet config files from pipeline-fleet's canonical
config/orgs.json registry.

Output shape:
  <out>/<canonical-owner>/config/repos.json
  <out>/<canonical-owner>/config/skip.json
`;

export function renderFleetConfigs({ orgsConfigPath, outDir, owners = [] }) {
  if (!orgsConfigPath) throw new Error("renderFleetConfigs needs orgsConfigPath.");
  if (!outDir) throw new Error("renderFleetConfigs needs outDir.");

  const registry = loadOrgRegistry(orgsConfigPath);
  const selected = owners.length ? owners : registry.orgs.map((org) => org.name);
  const rendered = [];

  for (const owner of selected) {
    const config = fleetConfigForOrg(registry, owner);
    const configDir = join(outDir, config.org.name, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "repos.json"), JSON.stringify(config.repos, null, 2) + "\n");
    writeFileSync(join(configDir, "skip.json"), JSON.stringify(config.skip, null, 2) + "\n");
    rendered.push(config.org.name);
  }

  return rendered;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/render-fleet-configs.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  try {
    const rendered = renderFleetConfigs({
      orgsConfigPath: args.orgsConfigPath,
      outDir: args.outDir,
      owners: args.owners,
    });
    for (const owner of rendered) {
      process.stdout.write(`rendered ${owner}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
