#!/usr/bin/env bash
REPO_URL=${CCFG_REPO_URL:-https://github.com/danuseta/claude-config.git}
REPO=${CCFG_REPO:-$HOME/claude-config}
STATE=${CCFG_STATE:-$HOME/.local/state/claude-config}

if [ ! -d "$REPO/.git" ]; then
  git clone --branch "${CCFG_BRANCH:-stable}" "$REPO_URL" "$REPO" || git clone "$REPO_URL" "$REPO" || { echo "bootstrap: clone of $REPO_URL failed" >&2; exit 1; }
fi
[ -f "$REPO/linux/personalize.sh" ] || { echo "bootstrap: $REPO/linux/personalize.sh not found" >&2; exit 1; }

cp "$REPO/linux/personalize" "$HOME/personalize" && chmod 755 "$HOME/personalize" || exit 1

LOCK=$STATE/run/personalize.lock
wait_lock() {
  local i pid
  for ((i = 0; i < 600; i += 5)); do
    pid=$(cat "$LOCK" 2>/dev/null) || return 0
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 5
  done
  return 1
}

wait_lock || { echo "bootstrap: personalize.lock still held after 10 minutes" >&2; exit 1; }
rm -f "$STATE/last-run.json"
bash "$REPO/linux/personalize.sh" --stdout
if [ ! -f "$STATE/last-run.json" ]; then
  wait_lock || { echo "bootstrap: personalize.lock still held after 10 minutes" >&2; exit 1; }
  bash "$REPO/linux/personalize.sh" --stdout
fi

[ -f "$STATE/last-run.json" ] || { echo "bootstrap: personalize wrote no last-run.json" >&2; exit 1; }
. "$REPO/linux/lib.sh"
setup_path
load_template_env
command -v node >/dev/null 2>&1 || { echo "bootstrap: node not found, cannot verify steps" >&2; exit 1; }
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = j.steps.filter((s) => (s.step === "dock" || s.step === "bridge") && s.status !== "OK");
bad.forEach((s) => console.error("bootstrap: step " + s.step + " failed: " + s.note));
process.exit(bad.length ? 1 : 0);
' "$STATE/last-run.json"
