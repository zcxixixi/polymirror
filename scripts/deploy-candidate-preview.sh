#!/bin/sh
set -eu

# Candidate-only deployment path. It never reads or prints .env values.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing Candidate deployment from a dirty checkout" >&2
  exit 1
fi

POLYMIRROR_GIT_SHA="$(git rev-parse HEAD)"
if ! printf '%s\n' "$POLYMIRROR_GIT_SHA" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then
  echo "invalid Git SHA" >&2
  exit 1
fi
export POLYMIRROR_GIT_SHA

# Compose expands required runtime variables while building. This sentinel is
# used only for interpolation; it is never embedded in the image or run.
POLYMIRROR_IMAGE_DIGEST="sha256:$(printf '%064d' 0)" docker compose build --pull polymirror

POLYMIRROR_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "polymirror:${POLYMIRROR_GIT_SHA}")"
if ! printf '%s\n' "$POLYMIRROR_IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
  echo "built image did not expose an immutable sha256 image ID" >&2
  exit 1
fi
export POLYMIRROR_IMAGE_DIGEST

docker compose config >/dev/null
docker compose up -d --no-build polymirror
