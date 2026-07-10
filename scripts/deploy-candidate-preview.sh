#!/bin/sh
set -eu

# Candidate-only deployment path. It never reads or prints .env values.
assert_clean_head() {
  expected_head="$1"
  if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$expected_head" ]; then
    echo "refusing Candidate deployment from a changed checkout" >&2
    exit 1
  fi
}

POLYMIRROR_GIT_SHA="$(git rev-parse HEAD)"
if ! printf '%s\n' "$POLYMIRROR_GIT_SHA" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then
  echo "invalid Git SHA" >&2
  exit 1
fi
export POLYMIRROR_GIT_SHA
assert_clean_head "$POLYMIRROR_GIT_SHA"

archive_dir="$(mktemp -d "${TMPDIR:-/tmp}/polymirror-build.XXXXXX")"
trap 'rm -rf "$archive_dir"' EXIT HUP INT TERM
git archive --format=tar "$POLYMIRROR_GIT_SHA" | tar -xf - -C "$archive_dir"

docker build --pull \
  --build-arg "POLYMIRROR_GIT_SHA=$POLYMIRROR_GIT_SHA" \
  --tag "polymirror:$POLYMIRROR_GIT_SHA" \
  "$archive_dir"

POLYMIRROR_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "polymirror:${POLYMIRROR_GIT_SHA}")"
if ! printf '%s\n' "$POLYMIRROR_IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
  echo "built image did not expose an immutable sha256 image ID" >&2
  exit 1
fi
export POLYMIRROR_IMAGE_DIGEST

assert_clean_head "$POLYMIRROR_GIT_SHA"
docker compose config >/dev/null
docker compose up -d --no-build polymirror
