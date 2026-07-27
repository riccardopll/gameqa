#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ARTIFACTS="$ROOT/artifacts"
FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/gameqa-package-smoke.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT

rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"
pnpm --filter gameqa pack --pack-destination "$ARTIFACTS" >/dev/null

TARBALL=$(find "$ARTIFACTS" -maxdepth 1 -name 'gameqa-*.tgz' -print -quit)
VERSION=$(cd "$ROOT" && node -p "require('./packages/cli/package.json').version")
test -n "$TARBALL"

npm install --ignore-scripts --prefix "$FIXTURE" "$TARBALL" >/dev/null
CLI="$FIXTURE/node_modules/.bin/gameqa"
test "$("$CLI" --version)" = "$VERSION"
(cd "$FIXTURE" && "$CLI" init >/dev/null)
(cd "$FIXTURE" && node --input-type=module --eval 'import("gameqa/sdk").then(({ client }) => { if (!client) process.exit(1) })')

printf 'Package smoke test passed: %s\n' "$TARBALL"
