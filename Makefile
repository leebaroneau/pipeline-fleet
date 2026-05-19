.PHONY: fleet-doctor tracker check

# Run the fleet doctor against config/repos.json. Requires FLEET_PAT (or
# GITHUB_TOKEN) in the environment and a sibling pipeline-core checkout
# (either as .pipeline-core/ or ../pipeline-core/).
fleet-doctor:
	node scripts/fleet-doctor.mjs

# Re-render the tracker section in README.md from the latest state/results.json.
tracker:
	node scripts/update-tracker.mjs

# Sanity check before commit: run both, fail if README would change but
# you haven't committed the update.
check: fleet-doctor tracker
	@if ! git diff --quiet README.md state/; then \
	  echo "README.md or state/ has uncommitted updates:"; \
	  git diff --stat README.md state/; \
	  exit 1; \
	fi
