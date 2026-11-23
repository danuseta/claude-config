#!/usr/bin/env bash
# Installs qonflo-qa-local from the kit: links ~/.local/bin/qonflo-qa-local to the kit wrapper and installs @playwright/test
# in ~/.claude/kit/qa-local when neither ~/qa nor the kit folder has one. The data (~/qa-local/tests, runs) is not touched.
# Env (tests): QA_LOCAL_BIN_DIR, QA_LOCAL_PW_HOME, QA_LOCAL_SKIP_NPM=1.
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
BIN_DIR="${QA_LOCAL_BIN_DIR:-$HOME/.local/bin}"
PW_HOME="${QA_LOCAL_PW_HOME:-$HOME/qa}"
mkdir -p "$BIN_DIR"
chmod +x "$HERE/bin/qonflo-qa-local" 2>/dev/null
ln -sfn "$HERE/bin/qonflo-qa-local" "$BIN_DIR/qonflo-qa-local"
if [ ! -f "$PW_HOME/node_modules/@playwright/test/cli.js" ] && [ ! -f "$HERE/node_modules/@playwright/test/cli.js" ] && [ "${QA_LOCAL_SKIP_NPM:-0}" != 1 ]; then
  (cd "$HERE" && npm install --no-audit --no-fund >/dev/null 2>&1) \
    || echo "qa-local: npm install in $HERE failed; qonflo-qa-local stops with exit 2 until @playwright/test is there"
fi
echo "qa-local: linked $BIN_DIR/qonflo-qa-local -> $HERE/bin/qonflo-qa-local"
