#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FNM_BIN="${HOME}/.local/share/fnm/fnm"

cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [ -x "$FNM_BIN" ]; then
    eval "$($FNM_BIN env --shell bash)"
    "$FNM_BIN" use --silent-if-unchanged >/dev/null
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'node or npm is not available in PATH, and fnm bootstrap failed\n' >&2
  exit 127
fi

npm run build
exec npm run proxy:start
