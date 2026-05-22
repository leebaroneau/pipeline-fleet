# runner.Dockerfile
#
# Extends myoung34/github-runner:latest with the Docker CLI binary so
# self-hosted runs of `pipeline-core/pr-guard.yml` (which invokes
# `docker compose config --quiet` to validate compose syntax) succeed.
#
# Scope: CLI binary only. NOT mounting /var/run/docker.sock — that would
# give CI jobs effective root on the host. pr-guard only needs the parser.

FROM myoung34/github-runner:latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*
