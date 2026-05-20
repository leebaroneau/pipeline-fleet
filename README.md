# Pipeline Fleet (leebaroneau)

leebaroneau's personal Pipeline Core fleet **plus** the retainer registry that governs which other orgs receive cascading patches from upstream.

This repo is one of N independent org fleets — Haverford-Brands, ALX-Finance, Genvest-Property, and kwa-nguyen each have their own under `<org>/.github`. Every fleet (this one included) consumes the same reusable workflow from [`leebaroneau/pipeline-core`](https://github.com/leebaroneau/pipeline-core)`/.github/workflows/fleet.yml@v1`.

## Status (leebaroneau repos only)

<!-- pipeline-fleet:tracker-start -->
**2** repos under management · **1** OK · **1** failing · **1** with warnings

_Updated 2026-05-20T11:44:31.803Z._

| Repo | Status | Failures | Warnings |
| --- | --- | ---: | ---: |
| [`leebaroneau/template-agent`](https://github.com/leebaroneau/template-agent) | ❌ fail | 1 | 0 |
| [`leebaroneau/lee-dashboard`](https://github.com/leebaroneau/lee-dashboard) | ⚠️ warn | 0 | 1 |
<!-- pipeline-fleet:tracker-end -->

_Updated by: `scripts/update-tracker.mjs`. Last updated: 2026-05-20T11:44:31.803Z._

## Retainer registry

`config/orgs.json` declares which orgs leebaroneau manages patches for:

| Org | Retainer status | Pinned version | Fleet repo |
| --- | --- | --- | --- |
| `leebaroneau` | self | floating `@v1` | `leebaroneau/pipeline-fleet` (this repo) |
| `Haverford-Brands` | active | floating `@v1` | `Haverford-Brands/.github` |
| `ALX-Finance` | active | floating `@v1` | `ALX-Finance/.github` |
| `Genvest-Property` | active | floating `@v1` | `Genvest-Property/.github` |
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
  └── templates/fleet/              ← skeleton for new org fleets

leebaroneau/pipeline-fleet (THIS)   ← leebaroneau's own fleet + retainer registry
  ├── config/repos.json             ← leebaroneau repos under management
  ├── config/skip.json              ← leebaroneau exclusions
  ├── config/orgs.json              ← retainer registry (all 5 orgs)
  └── .github/workflows/fleet.yml   ← caller (owner: leebaroneau)

Haverford-Brands/.github            ← HB's own fleet (independent)
  ├── config/repos.json             ← HB repos under management
  ├── config/skip.json              ← HB exclusions
  └── .github/workflows/fleet.yml   ← caller (owner: Haverford-Brands)

(same shape repeated for ALX-Finance, Genvest-Property, kwa-nguyen)
```

## Operations

```bash
# Manually trigger leebaroneau's fleet sweep:
gh workflow run "Fleet — doctor + discover" --repo leebaroneau/pipeline-fleet

# Discover-only (find new repos, don't audit existing):
gh workflow run "Fleet — doctor + discover" --repo leebaroneau/pipeline-fleet -f mode=discover
```

## Auth

`FLEET_PAT` (repo secret on this repo): Personal Access Token Classic with `repo` + `read:org`, scoped to leebaroneau. Other orgs have their own scoped PAT in their own `.github` repo.

## Phase status

| Phase | What | Status |
| --- | --- | --- |
| 1 | pipeline-core installer + self-CI + reusable fleet workflow (v1.0.10) | ✅ done |
| 2 | This repo repurposed for leebaroneau-only + retainer registry | ✅ in progress |
| 3 | Per-org `.github` fleets (Haverford-Brands, ALX-Finance, Genvest-Property, kwa-nguyen) | ⏳ |
| 4 | `scripts/push-patches.mjs` patch cascade tool | ⏳ |
| 5 | Per-org batch fan-out using the new infrastructure | ⏳ |
