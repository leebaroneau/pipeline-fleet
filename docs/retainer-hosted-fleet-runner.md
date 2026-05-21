# Retainer-Hosted Fleet Runner

Retainer-hosted mode runs the daily Pipeline Core fleet sweep on each retainer's Coolify server. Lee controls template releases and patch pushes from `leebaroneau/pipeline-fleet`, but runtime execution and org-scoped tokens live with the retainer.

## Repo Map

The fleet runner crosses several repos, but each repo has a narrow job:

| Repo | Purpose | Change in this plan |
| --- | --- | --- |
| `leebaroneau/pipeline-core` | Upstream framework. Owns reusable workflows, installer doctor, fleet doctor, discovery, tracker renderer, and templates. | Template and docs updates prefer retainer-hosted Coolify. |
| `leebaroneau/pipeline-fleet` | Fleet control plane. Owns the retainer registry, patch cascade, Lee's own fleet state, and the Coolify runner package. | Adds lifecycle flags, runner package, patch docs, and offboarding docs. |
| `Haverford-Brands/.github` | Haverford's retainer fleet repo. Owns `config/repos.json`, `config/skip.json`, state files, and tracker README. | Changes later after the pilot disables the old schedule. |
| `ALX-Finance/.github`, `Genvest-Property/.github`, `kwa-nguyen/.github` | Retainer fleet repos with the same shape as Haverford's fleet repo. | Same retainer-hosted runner model, rolled out after Haverford. |
| Consumer repos | Actual product, theme, and service repos using `.github/workflows/pipeline-*.yml`. | No runner code. They may receive final caller pin PRs during offboarding. |
| `leebaroneau/notion-github-sync` | Separate Notion and GitHub Project mirror. | No change. |
| `leebaroneau/lee-dashboard` | Workspace and brain control repo. | No product code change. |

## Coolify Deployment

Deploy the runner from `leebaroneau/pipeline-fleet` on the retainer's Coolify server:

1. Create a new Coolify Docker Compose resource that points at this repo and branch.
2. Use `docker-compose.coolify.yml` as the compose file.
3. Set the environment variables in Coolify. Start from `.env.example`, then replace placeholders with the retainer's scoped values.
4. Deploy the resource. The image runs `node scripts/fleet-runner.mjs --once`, performs one sweep, and exits.
5. Schedule the resource from Coolify or an external scheduler. Each scheduled invocation should start a fresh one-shot run.
6. Check the retainer fleet repo after a run. State files and the tracker README should update when the runner finds changes.

The runner clones the retainer fleet repo, clones `leebaroneau/pipeline-core`, runs the selected fleet mode, commits state and tracker changes when enabled, then pushes back to the retainer fleet repo.

## Environment Variables

Required:

- `FLEET_OWNER`: the retainer org name, for example `Haverford-Brands`.
- `FLEET_PAT`: org-scoped token for the retainer fleet repo. It must be able to clone, commit, and push to the retainer `.github` fleet repo, and read the org repos needed by discovery and doctor checks.

Defaults and optional values:

- `ORGS_CONFIG_PATH`: defaults to `config/orgs.json`.
- `MODE`: defaults to `both`. Supported values are `doctor`, `discover`, and `both`.
- `COMMIT_CHANGES`: defaults to `1`. Set to `0` for dry-run behavior.
- `PIPELINE_CORE_REF`: defaults to `v1`.
- `PIPELINE_CORE_TOKEN`: optional. Set this only if `pipeline-core` needs an authenticated clone.

## Manual Test

Run the one-shot runner locally without committing changes. Set the owner and token in the command so the example is executable as written:

```bash
FLEET_OWNER=Haverford-Brands FLEET_PAT="$(gh auth token)" npm run fleet:dry-run
```

This sets `COMMIT_CHANGES=0` and runs `node scripts/fleet-runner.mjs --once`.

## Verification Checklist

Before handing a retainer-hosted runner over:

- The Coolify resource deploys from `docker-compose.coolify.yml`.
- `FLEET_OWNER` matches exactly one retainer entry in `config/orgs.json`.
- `FLEET_PAT` is scoped to the retainer and is not shared across retainers.
- `PIPELINE_CORE_REF` is set intentionally. Use `v1` only while the retainer is active and supported.
- A manual `npm run fleet:dry-run` completes.
- A scheduled one-shot run starts, exits cleanly, and does not restart-loop.
- The retainer fleet repo receives state and tracker updates when `COMMIT_CHANGES=1`.
- Consumer repos still contain only caller workflows under `.github/workflows/pipeline-*.yml`.

## Offboarding Checklist

When a retainer leaves support:

1. Always stop Lee-side updates in `config/orgs.json`: set `retainer_status` to `inactive`, set `patches_enabled` to `false`, and set `pinned_version` to the exact supported Pipeline Core release, for example `v1.0.X`.
2. If support or runtime should stop entirely, or Lee must prevent this org from being selected by future runner invocations, set `runner_enabled` to `false` and stop or remove the Coolify schedule.
3. If the retainer keeps self-hosted monitoring after handoff, `runner_enabled` may remain `true`, but `PIPELINE_CORE_REF` and consumer callers must be pinned to `v1.0.X`. Lee no longer pushes fresh template updates.
4. Open one-time caller pin PRs so consumer repos stop floating on `@v1`:

```bash
node scripts/push-patches.mjs \
  --orgs-config config/orgs.json \
  --templates ../pipeline-core/templates/caller-workflows \
  --owner Haverford-Brands \
  --include-inactive \
  --caller-ref v1.0.X \
  --new-version v1.0.X
```

The important handoff flags are `--include-inactive --caller-ref v1.0.X --new-version v1.0.X`. Use the departing retainer as `--owner`.

## Caller Pinning Warning

Consumer callers must be pinned from `@v1` to an exact `@v1.0.X` before support stops. Leaving inactive consumers on `@v1` means they can keep receiving future reusable workflow changes without the retainer runner, token, or support process that should validate those changes.
