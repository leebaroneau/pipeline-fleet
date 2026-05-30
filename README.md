# Pipeline Fleet (leebaroneau)

leebaroneau's personal Pipeline Core fleet **plus** the retainer registry that governs which other orgs receive cascading patches from upstream.

This repo is one of N independent org fleets — Haverford-Brands, alx-finance, genvest, and kwa-nguyen each have their own under `<org>/.github`. Every fleet (this one included) consumes the same reusable workflow from [`leebaroneau/pipeline-core`](https://github.com/leebaroneau/pipeline-core)`/.github/workflows/fleet.yml@v1`.

## Status (leebaroneau repos only)

<!-- pipeline-fleet:tracker-start -->
**2** repos under management · **1** OK · **1** failing · **1** with warnings

_Updated 2026-05-30T10:44:46.567Z._

| Repo | Status | Failures | Warnings |
| --- | --- | ---: | ---: |
| [`leebaroneau/template-agent`](https://github.com/leebaroneau/template-agent) | ❌ fail | 1 | 0 |
| [`leebaroneau/lee-dashboard`](https://github.com/leebaroneau/lee-dashboard) | ⚠️ warn | 0 | 1 |
<!-- pipeline-fleet:tracker-end -->

_Updated by: `scripts/update-tracker.mjs`. Last updated: 2026-05-30T10:44:46.567Z._

## Retainer registry

`config/orgs.json` is the canonical registry for orgs leebaroneau manages patches for. It owns canonical org names, historical aliases, managed repo allowlists, and skipped repos. Per-org `.github/config/repos.json` and `.github/config/skip.json` should be generated from this file rather than edited by hand.

| Org | Retainer status | Pinned version | Fleet repo |
| --- | --- | --- | --- |
| `leebaroneau` | self | floating `@v1` | `leebaroneau/pipeline-fleet` (this repo) |
| `Haverford-Brands` | active | floating `@v1` | `Haverford-Brands/.github` |
| `alx-finance` | active | floating `@v1` | `alx-finance/.github` |
| `genvest` | active | floating `@v1` | `genvest/.github` |
| `kwa-nguyen` | active | floating `@v1` | `kwa-nguyen/.github` |

When an org goes inactive, `pinned_version` gets set to the specific `v1.0.X` they had at handoff time and `push-patches.mjs` stops cascading new releases to it.

## How patch propagation works

```
Upstream change in pipeline-core
        │
        ▼
  cut new release (v1.0.X) — `v1` floating tag advances
        │
        ▼
  scripts/push-patches.mjs (this repo) reads config/orgs.json
        │
        ├──► for each ACTIVE org: open a PR in each consumer repo to refresh caller templates
        │
        └──► INACTIVE orgs: skip (consumers stay on pinned_version)
```

`push-patches.mjs` lives in this repo because patch propagation is the prerogative of the platform owner (leebaroneau), not the consumer orgs.

## Architecture

```
leebaroneau/pipeline-core           ← upstream framework
  ├── .github/workflows/fleet.yml   ← reusable workflow each fleet consumes
  ├── scripts/{discover,fleet-doctor,update-tracker,doctor,install}.mjs
  └── templates/pipeline-fleet/     ← skeleton for new org fleets

leebaroneau/pipeline-fleet (THIS)   ← leebaroneau's own fleet + retainer registry
  ├── config/repos.json             ← leebaroneau repos under management
  ├── config/skip.json              ← leebaroneau exclusions
  ├── config/orgs.json              ← retainer registry (all 5 orgs)
  └── .github/workflows/fleet.yml   ← caller (owner: leebaroneau)

Haverford-Brands/.github            ← HB's own fleet (independent)
  ├── config/repos.json             ← HB repos under management
  ├── config/skip.json              ← HB exclusions
  └── .github/workflows/fleet.yml   ← caller (owner: Haverford-Brands)

(same shape repeated for alx-finance, genvest, kwa-nguyen)
```

Render per-org fleet config files from the canonical registry:

```bash
node scripts/render-fleet-configs.mjs \
  --orgs-config config/orgs.json \
  --out /tmp/pipeline-fleet-configs
```

Then copy the generated `<owner>/config/repos.json` and `<owner>/config/skip.json` into that org's `.github` repo through a normal PR. The org's `.github/workflows/fleet.yml` caller should pass `with.owner` equal to the canonical `name` in `config/orgs.json`, not an alias.

## Operations

```bash
# Manually trigger leebaroneau's fleet sweep:
gh workflow run "Fleet — doctor + discover" --repo leebaroneau/pipeline-fleet

# Discover-only (find new repos, don't audit existing):
gh workflow run "Fleet — doctor + discover" --repo leebaroneau/pipeline-fleet -f mode=discover
```

### Self-hosted GitHub Actions runner pool

The runner pool now lives in **[`pipeline-core/deploy/pipeline-runner-pool/`](https://github.com/leebaroneau/pipeline-core/tree/main/deploy/pipeline-runner-pool)** (registration via the org-owned `pipeline-bot` GitHub App, not a personal PAT). Retainers whose hosted-runner minute budget is exhausted deploy it from there via Coolify, so CI compute lands locally while orchestration stays on GitHub; the daily fleet sweep then rides through the pool as a free job (self-hosted minutes don't count against the org's GH Actions quota).

See that folder's `README.md` for the Coolify settings (Base Directory + Watch Paths) and the verify/scale/rotate/decommission runbook.

## Auth

`FLEET_PAT` (repo secret on this repo): Personal Access Token Classic with `repo` + `read:org`, scoped to leebaroneau. Other orgs have their own scoped PAT in their own `.github` repo.

## Phase status

| Phase | What | Status |
| --- | --- | --- |
| 1 | pipeline-core installer + self-CI + reusable fleet workflow (v1.0.10) | ✅ done |
| 2 | This repo repurposed for leebaroneau-only + retainer registry | ✅ in progress |
| 3 | Per-org `.github` fleets (Haverford-Brands, alx-finance, genvest, kwa-nguyen) | ⏳ |
| 4 | `scripts/push-patches.mjs` patch cascade tool | ⏳ |
| 5 | Per-org batch fan-out using the new infrastructure | ⏳ |
