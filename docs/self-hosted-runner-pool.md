# Self-Hosted Actions Runner Pool

Retainer-hosted GitHub Actions runners for a retainer org. Each retainer that has exhausted its hosted-runner minute budget can deploy this pool on their own Coolify; CI compute moves off GitHub-hosted runners while the orchestration layer (workflows, statuses, branch protection) stays on GitHub.

## Repo Map

| Repo | Role |
| --- | --- |
| `leebaroneau/pipeline-core` | Reusable workflows. Each accepts a `runner` input defaulting to `["self-hosted", "retainer"]` from v1.1.0 onwards. |
| `leebaroneau/pipeline-fleet` (this repo) | Hosts `docker-compose.actions-runner.yml` (this package) and the runbook below. |
| `<retainer>/<consumer-repo>` | Picks up the new default automatically via `@v1`. No file change required on the consumer side once v1.1.0 ships. |

## Coolify Deployment

Deploy on the retainer's Coolify server:

1. Create a new Coolify Docker Compose resource:
   - Source: this repo (`leebaroneau/pipeline-fleet`) branch `main`.
   - Compose file: `docker-compose.actions-runner.yml`.
   - Name: `actions-runner-<retainer-slug>` (e.g. `actions-runner-haverford`).
2. Set environment variables (start from `.env.actions-runner.example`):
   - `ACCESS_TOKEN`: classic PAT on a user account with `admin:org` scope on the retainer org.
   - `RUNNER_OWNER`: retainer org name.
   - `RUNNER_LABELS`: include a retainer-specific label (e.g. `self-hosted,linux,retainer,haverford`).
3. Deploy. Each service starts a long-running ephemeral runner that registers, runs one job, exits, and is restarted by Docker.

## Verification

After the first deploy, confirm:

- Two runners appear at `https://github.com/organizations/<retainer>/settings/actions/runners` named `<retainer>-runner-1` and `<retainer>-runner-2`.
- Both are `Idle` initially.
- Submitting a job that targets `runs-on: [self-hosted, retainer]` causes one runner to transition to `Active`, complete the job, and the container then auto-restarts.

## Scaling

Each runner uses ~1 CPU + ~1.5 GiB RAM during a job. To add slots, add another `runner-3` service block to the compose file (mirror `runner-1`/`runner-2`, change `RUNNER_NAME` suffix), commit, push. Coolify auto-deploys.

To remove a slot, delete the service block, commit, push. Coolify auto-deploys and the removed runner deregisters on shutdown.

## Token Rotation

The `ACCESS_TOKEN` PAT expires per its configured lifetime (default 1 year). To rotate:

1. Mint a new PAT at `https://github.com/settings/tokens/new` with `admin:org` scope. Same name + new expiry.
2. PATCH the Coolify env: `curl -X PATCH ... -d '{"key":"ACCESS_TOKEN","value":"<new>"}'`.
3. Trigger a redeploy: `curl -X POST .../api/v1/deploy?uuid=<app-uuid>`.
4. Both runners restart and re-register with the new token.
5. Revoke the old PAT at `https://github.com/settings/tokens`.

## Decommission

If the retainer no longer needs a self-hosted pool:

1. Update all consumer caller workflows to pass `runner: '["ubuntu-latest"]'` (or rely on pipeline-core's `runner` input fallback). Use `scripts/push-patches.mjs` to fan out the caller template change.
2. Stop the Coolify app (Settings → Stop).
3. Deregister both runners at `https://github.com/organizations/<retainer>/settings/actions/runners` (or run them down naturally — once stopped, GitHub eventually marks them Offline).
4. Revoke the `ACCESS_TOKEN` PAT.

## Failure Handling

| Symptom | Mitigation |
| --- | --- |
| Both runners offline | Coolify usually auto-restarts within 60s. SSH in: `docker compose -f docker-compose.actions-runner.yml up -d`. |
| One runner stuck | `docker restart <runner-container-name>`. Ephemeral mode makes restart safe. |
| PAT expired or revoked | Rotate per Token Rotation section. |
| Workflow broken on self-hosted but works on hosted | Edit the affected consumer caller to pass `runner: '["ubuntu-latest"]'`. Investigate root cause separately; ship pipeline-core fix. |
| Image (`myoung34/github-runner`) breaks unexpectedly | Pin compose to a specific tag (currently `:latest`). |
