#!/usr/bin/env bash
# One pass of the workspace auto-update, run every AUTOUPDATE_EVERY_SECS by the updater service.
# Pulls claude-config and DOCK when their branch moved; the bridge and DOCK restart only while no chat turn runs.
# Usage: autoupdate.sh [--dry-run]   --dry-run prints what the pass would do and changes nothing but git fetch
# shellcheck disable=SC1091
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

AU_DRY=0
AU_PENDING=$CCFG_RUN/bridge.restart-pending

# A chat turn is a claude process the bridge started with --output-format stream-json; the bridge's other child is its log sink.
turn_running() {
  local cp p
  cp=$(cat "$CCFG_RUN/bridge.child" 2>/dev/null)
  is_alive "$cp" || return 1
  for p in $(descendants "$cp"); do
    tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- '--output-format stream-json' && return 0
  done
  return 1
}

# True when origin has commits the checkout lacks and a fast-forward can take them.
behind() {
  local head up
  timeout 60 git -C "$1" fetch -q origin 2>/dev/null || { say WARN "git fetch failed in $1"; return 1; }
  head=$(git -C "$1" rev-parse HEAD 2>/dev/null) || return 1
  up=$(git -C "$1" rev-parse '@{u}' 2>/dev/null) || return 1
  [ "$head" != "$up" ] && git -C "$1" merge-base --is-ancestor "$head" "$up"
}

dock_stale() {
  [ "$ENABLE_DOCK" = 1 ] && [ -d "$DOCK_APP_DIR/.git" ] || return 1
  behind "$DOCK_APP_DIR" && return 0
  [ "$(git -C "$DOCK_APP_DIR" rev-parse HEAD 2>/dev/null)" != "$(cat "$DOCK_DATA_DIR/built" 2>/dev/null)" ]
}

au_pass() {
  if [ -d "$CCFG_REPO/.git" ] && behind "$CCFG_REPO"; then
    if [ "$AU_DRY" = 1 ]; then say DRY "would pull claude-config, apply install and plugins, and mark the bridge for a restart"
    else
      say INFO "claude-config moved, updating"
      bash "$CCFG_LINUX_DIR/personalize.sh" --stdout --only=repo,install,plugins
      : >"$AU_PENDING"
    fi
  fi

  if dock_stale; then
    if turn_running; then say INFO "DOCK update waits: a chat turn is running"
    elif [ "$AU_DRY" = 1 ]; then say DRY "would pull, build and restart DOCK"
    else
      say INFO "DOCK moved, updating"
      bash "$CCFG_LINUX_DIR/personalize.sh" --stdout --only=dock
    fi
  fi

  [ -f "$AU_PENDING" ] || return 0
  if ! service_pid bridge >/dev/null; then rm -f "$AU_PENDING"
  elif turn_running; then say INFO "bridge restart waits: a chat turn is running"
  elif [ "$AU_DRY" = 1 ]; then say DRY "would restart the bridge"
  else
    say INFO "restarting the bridge on the new kit"
    service_stop bridge && service_start bridge && rm -f "$AU_PENDING"
  fi
}

[ "${1:-}" != --dry-run ] || AU_DRY=1
setup_path
command -v node >/dev/null 2>&1 || load_template_env
mkdir -p "$CCFG_RUN"
if [ "$AU_DRY" = 1 ]; then
  au_pass
  say DRY "turn running: $(turn_running && echo yes || echo no), bridge restart pending: $([ -f "$AU_PENDING" ] && echo yes || echo no)"
  exit 0
fi
lock_acquire "$CCFG_RUN/autoupdate.lock" autoupdate.sh || exit 0
trap 'lock_release "$CCFG_RUN/autoupdate.lock"' EXIT
au_pass
exit 0
