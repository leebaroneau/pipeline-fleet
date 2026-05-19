# Pipeline Fleet

Org-wide rollout management for [Pipeline Core](https://github.com/leebaroneau/pipeline-core). This repo:

- Lists every repo across our orgs that's a candidate for Pipeline Core (`config/repos.json`)
- Runs a daily cron that audits each managed repo with the install doctor (`scripts/fleet-doctor.mjs`)
- Renders the fleet status into this README and (after Phase 3) into each org's `.github/profile/README.md` dashboard so org members see their slice

## Status

<!-- pipeline-fleet:tracker-start -->
**1** repo under management · **1** OK · **0** failing · **1** with warnings

_Updated 2026-05-19T02:53:32.907Z._

| Repo | Status | Failures | Warnings |
| --- | --- | ---: | ---: |
| [`leebaroneau/lee-dashboard`](https://github.com/leebaroneau/lee-dashboard) | ⚠️ warn | 0 | 1 |
<!-- pipeline-fleet:tracker-end -->

_Updated by: `scripts/update-tracker.mjs`. Last updated: 2026-05-19T02:53:32.907Z._

## Adoption candidates

Inventoried 2026-05-19 from GitHub repo enumeration across the 4 orgs + personal.

### Tier 1 — active code repos (~19)

| Repo | Owner | Notes |
| --- | --- | --- |
| service-Haverford-Dev-API | Haverford-Brands | Most active code repo — Phase 3 pilot target |
| app-Gateway | Haverford-Brands | |
| app-Shopify-Sales | Haverford-Brands | |
| service-Auth-Gate | Haverford-Brands | |
| hwb-image-generator | Haverford-Brands | |
| Marketing-Ops | Haverford-Brands | Python |
| price-tool | Haverford-Brands | Python |
| agent-haverford-state | Haverford-Brands | Python |
| sales.koenigmachinery.com.au | Haverford-Brands | Hydrogen storefront |
| quote.koenigmachinery.com.au | Haverford-Brands | Hydrogen storefront |
| Template-Docker | Haverford-Brands | DO droplet template |
| website | ALX-Finance | |
| paperclip-hermes-gbrain | ALX-Finance | |
| service-api | Genvest-Property | |
| website | Genvest-Property | |
| agent-genvest | Genvest-Property | |
| agent-kwa | kwa-nguyen | |
| THP-Strength | leebaroneau | |
| Hobbyzenlife.com.au-HydrogenTS | leebaroneau | |
| pipeline-core | leebaroneau | Self-host (already CI'd; pipeline install is optional dogfood) |

### Tier 2 — Shopify theme repos (~28)

All under `Haverford-Brands/*.com.au` (and `.co.nz`, `.co.uk`, `.com`, `.sg`). You opted for "full pipeline on themes too" — value is unified label palette and weekly drift signal across the brand fleet. Decision is reversible: if intake/slash-command overhead is wasted noise on themes after the pilot, drop them from `repos.json` and the cron stops touching them.

Examples: `Catnets.com.au`, `Catnets.co.nz`, `Gutzbusta.com.au`, `Hardwarebox.com.au`, `Haverford.com.au`, `Koenigmachinery.com.au`, `Quatrasports.com.au`, `Shadematters.com.au`, `bmsaustralia.com.au`, `haverford-b2b`, etc.

### Tier 3 — skipped

`Haverford-Brands/.github`, `agent-haverford-data` (data mirror, not code), `Koenigmachinery.com.au-Wordpress` (stale), `app-cope` / `service-cin7Klaviyo` / `service-copeapi` (archived flows), `Birthing-Plan` / `boncharge` (personal/low-activity).

## Architecture

```
       config/repos.json (source of truth)
                  │
                  ▼
   ┌───────────────────────────────┐         daily 09:00 UTC
   │  .github/workflows/           │         workflow_dispatch
   │    fleet-doctor.yml           │ ───────► scripts/fleet-doctor.mjs
   └───────────────────────────────┘                 │
                                                     ▼
                                  For each managed repo:
                                    git clone --depth 1 --sparse
                                    node pipeline-core/scripts/doctor.mjs --json
                                    collect ok / report / result
                                                     │
                                                     ▼
                                          state/results.json
                                                     │
                          ┌──────────────────────────┴──────────────────────────┐
                          ▼                                                      ▼
              scripts/update-tracker.mjs                            scripts/update-org-dashboards.mjs
                          │                                                      │
                          ▼                                                      ▼
                this README (tracker)                            <org>/.github/profile/README.md (×4)
```

## Auth

The cron needs a Personal Access Token (Classic) with `repo`, `admin:org` (read), and `workflow` scopes against the 4 orgs (Haverford-Brands, ALX-Finance, Genvest-Property, kwa-nguyen) + personal. Stored as the repo secret `FLEET_PAT`.

## Phase status

| Phase | What | Status |
| --- | --- | --- |
| 1 | pipeline-core installer + self-CI + reusable doctor (v1.0.7) | ✅ done |
| 2 | This repo: fleet-doctor scaffolding, daily cron, tracker | ✅ in progress |
| 3 | Pilot install: `service-Haverford-Dev-API` + `Catnets.com.au` | ⏳ |
| 4 | Batch install: remaining Tier 1 + themes (~41 repos) | ⏳ |
| 5 | Per-org `.github/profile/README.md` dashboards activated | ⏳ |

## Operations

```bash
# Run the fleet doctor locally against config/repos.json (needs $FLEET_PAT):
make fleet-doctor

# Re-render the tracker section in this README from the latest state/results.json:
make tracker

# Manually trigger the GitHub-hosted cron without waiting for the schedule:
gh workflow run fleet-doctor.yml --repo leebaroneau/pipeline-fleet
```
