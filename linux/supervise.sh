#!/usr/bin/env bash
# Keeps one service running (tailscaled or the DOCK chat bridge): one instance via lock, restart with backoff, size-rotated log.
# Usage: supervise.sh <tailscaled|bridge>            known service
#        supervise.sh <name> -- <command> [args...]   any command (used for tests)
# shellcheck disable=SC1091
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

SUP_NAME=""
SUP_CHILD=""
SUP_STOP=0
SUP_LOG=""
SUP_SLEEP=""
SUP_KILLER=""

sup_log() { log_line "[supervise] $*"; }

log_line() {
  printf '%s %s\n' "$(now_iso)" "$1" >>"$SUP_LOG"
  [ "$(file_size "$SUP_LOG")" -gt "$LOG_MAX_BYTES" ] && rotate_log "$SUP_LOG"
  return 0
}

log_sink() {
  local line n=0 base
  base=$(file_size "$SUP_LOG")
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >>"$SUP_LOG"
    base=$((base + ${#line} + 1))
    if [ "$base" -gt "$LOG_MAX_BYTES" ]; then rotate_log "$SUP_LOG"; base=$(file_size "$SUP_LOG"); fi
    n=$((n + 1))
  done
}

on_signal() {
  SUP_STOP=1
  if is_alive "$SUP_CHILD"; then
    kill_tree "$SUP_CHILD" TERM
    (sleep 5; kill_tree "$SUP_CHILD" KILL) >/dev/null 2>&1 &
    SUP_KILLER=$!
  fi
  [ -z "$SUP_SLEEP" ] || kill "$SUP_SLEEP" 2>/dev/null
}

sup_cleanup() {
  [ -z "$SUP_KILLER" ] || kill_tree "$SUP_KILLER" TERM
  lock_release "$CCFG_RUN/$SUP_NAME.lock"
  rm -f "$CCFG_RUN/$SUP_NAME.child"
}

sup_main() {
  SUP_NAME=${1:-}
  [ -n "$SUP_NAME" ] || { echo "usage: supervise.sh <tailscaled|bridge> | <name> -- <command...>"; return 2; }
  shift
  local custom=()
  if [ "${1:-}" = "--" ]; then shift; custom=("$@"); else
    SUP_NAME=$(service_unit "$SUP_NAME") || { echo "unknown service: $SUP_NAME"; return 2; }
  fi
  mkdir -p "$CCFG_RUN" "$CCFG_STATE"
  SUP_LOG=$CCFG_STATE/$SUP_NAME.log
  if ! lock_acquire "$CCFG_RUN/$SUP_NAME.lock" supervise.sh; then
    echo "supervise $SUP_NAME: already running (pid $(cat "$CCFG_RUN/$SUP_NAME.lock" 2>/dev/null))"
    return 4
  fi
  trap on_signal TERM INT HUP
  trap sup_cleanup EXIT
  local backoff=$SUPERVISE_BACKOFF_MIN started rc why
  sup_log "$SUP_NAME: supervisor pid $$ started"
  while [ "$SUP_STOP" = 0 ]; do
    if [ ${#custom[@]} -eq 0 ] && ! why=$(service_precheck "$SUP_NAME"); then
      sup_log "$SUP_NAME: not starting: $why"
      return 3
    fi
    started=$SECONDS
    if [ ${#custom[@]} -gt 0 ]; then
      ( exec "${custom[@]}" ) > >(log_sink) 2>&1 &
    else
      ( service_prepare "$SUP_NAME" && service_exec "$SUP_NAME" ) > >(log_sink) 2>&1 &
    fi
    SUP_CHILD=$!
    printf '%s\n' "$SUP_CHILD" >"$CCFG_RUN/$SUP_NAME.child"
    sup_log "$SUP_NAME: child pid $SUP_CHILD started"
    wait "$SUP_CHILD"
    rc=$?
    if [ "$SUP_STOP" = 1 ]; then wait "$SUP_CHILD" 2>/dev/null; break; fi
    if [ $((SECONDS - started)) -ge "$SUPERVISE_STABLE_SECS" ]; then backoff=$SUPERVISE_BACKOFF_MIN; fi
    sup_log "$SUP_NAME: child exited with $rc after $((SECONDS - started))s, restarting in ${backoff}s"
    sleep "$backoff" &
    SUP_SLEEP=$!
    wait "$SUP_SLEEP" 2>/dev/null
    SUP_SLEEP=""
    backoff=$((backoff * 2))
    [ "$backoff" -le "$SUPERVISE_BACKOFF_MAX" ] || backoff=$SUPERVISE_BACKOFF_MAX
  done
  sup_log "$SUP_NAME: supervisor stopping"
  return 0
}

sup_main "$@"; exit $?
