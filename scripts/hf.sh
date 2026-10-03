#!/usr/bin/env bash
# hf - HexForge Gateway CLI launcher.
#
# The CLI itself is scripts/hf/cli.mjs (Node, zero dependencies); this file
# only keeps `./scripts/hf.sh ...` and `alias hf=./scripts/hf.sh` working.
# It was a curl+jq script before - see docs/CLI.md for what changed.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "hf needs Node.js - the same Node the Gateway runs on (Termux: pkg install nodejs)." >&2
  exit 127
fi

src="${BASH_SOURCE[0]}"
# Resolve symlinks, so `ln -s /path/to/scripts/hf.sh ~/bin/hf` still finds scripts/hf/cli.mjs.
if command -v readlink >/dev/null 2>&1; then
  src="$(readlink -f "$src" 2>/dev/null || printf '%s' "$src")"
fi
dir="$(cd "$(dirname "$src")" && pwd)"

exec node "$dir/hf/cli.mjs" "$@"
