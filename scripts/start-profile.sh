#!/usr/bin/env bash
# Launch Freedom with an isolated, persistent profile.
#
# Each profile gets its own userData (settings, bookmarks, history,
# dapp permissions, Chromium cookies/storage) and its own identity
# directory (wallet vault). Bee, IPFS, and Radicle are NOT isolated —
# both profiles share the dev-mode <repoRoot>/{bee,ipfs,radicle}-data
# dirs, and the second instance to launch reuses the first's running
# daemons via the existing detectExistingDaemon() path.
#
# Usage: scripts/start-profile.sh <profile-name>
# Example: scripts/start-profile.sh work
#
# Profile data lives under ~/.freedom-profiles/<name>/.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <profile-name>" >&2
  exit 64
fi

profile="$1"
if [[ ! "$profile" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: profile name must match [A-Za-z0-9_-]+, got: $profile" >&2
  exit 64
fi

root="${FREEDOM_PROFILES_ROOT:-$HOME/.freedom-profiles}/$profile"
mkdir -p "$root/userData" "$root/identity"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[freedom] profile=$profile"
echo "[freedom]   userData = $root/userData"
echo "[freedom]   identity = $root/identity"
echo "[freedom]   shared   = $repo_root/{bee,ipfs,radicle}-data"

cd "$repo_root"
exec env \
  FREEDOM_TEST_USER_DATA="$root/userData" \
  FREEDOM_IDENTITY_DATA="$root/identity" \
  npm start
