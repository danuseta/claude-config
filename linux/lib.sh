# Shared helpers of the Linux runtime (paths, logging, locks, secrets, services); sourced by personalize.sh, supervise.sh and ccfg.

CCFG_LINUX_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
CCFG_REPO=${CCFG_REPO:-$(dirname "$CCFG_LINUX_DIR")}
CCFG_STATE=${CCFG_STATE:-$HOME/.local/state/claude-config}
CCFG_RUN=$CCFG_STATE/run
CCFG_SECRETS=${CCFG_SECRETS:-$HOME/.config/claude-config/secrets.env}
CCFG_CLAUDE_DIR=${CCFG_CLAUDE_DIR:-$HOME/.claude}
CCFG_BIN=${CCFG_BIN:-$HOME/.local/bin}
TS_SOCK=${TS_SOCK:-$HOME/.local/run/tailscale/tailscaled.sock}
TS_STATE=${TS_STATE:-$HOME/.local/state/tailscale}
PROJECTS_DIR=${PROJECTS_DIR:-$HOME/projects}

# shellcheck disable=SC1091
. "$CCFG_LINUX_DIR/versions.env"
# shellcheck disable=SC1090
[ -n "${CCFG_VERSIONS_FILE:-}" ] && [ -f "$CCFG_VERSIONS_FILE" ] && . "$CCFG_VERSIONS_FILE"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '%s %-5s %s\n' "$(now_iso)" "$1" "$2"; }
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
indirect() { local v=${!1:-}; printf '%s' "$v"; }
file_size() { local n; n=$(wc -c <"$1" 2>/dev/null | tr -d ' '); printf '%s' "${n:-0}"; }
file_mode() { stat -c %a "$1" 2>/dev/null; }
is_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

setup_path() {
  case ":$PATH:" in *":$CCFG_BIN:"*) ;; *) PATH="$CCFG_BIN:$PATH" ;; esac
  export PATH
}

load_template_env() {
  local envsh=$HOME/.config/qonflo/env.sh
  [ -f "$envsh" ] || return 0
  set +u
  # shellcheck disable=SC1090
  . "$envsh" >/dev/null 2>&1 || true
  setup_path
}

rotate_log() {
  local f=$1 max=${2:-$LOG_MAX_BYTES} keep=${3:-$LOG_KEEP} i
  [ -f "$f" ] || return 0
  [ "$(file_size "$f")" -gt "$max" ] || return 0
  rm -f "$f.$keep"
  for ((i = keep - 1; i >= 1; i--)); do [ -f "$f.$i" ] && mv -f "$f.$i" "$f.$((i + 1))"; done
  mv -f "$f" "$f.1"
}

# A child that started its own session (spawn detached, setsid) is left out with its subtree: a dev server
# started from DOCK has to outlive a DOCK restart. Without a session column every child counts, as before.
descendants() {
  local pid=$1 table
  table=$(ps -eo pid=,ppid=,sid= 2>/dev/null)
  [ -n "$table" ] || table=$(ps -e 2>/dev/null | awk 'NR==1{ok=($2=="PPID")} ok&&NR>1{print $1, $2}')
  printf '%s\n' "$table" | awk -v root="$pid" '
    NF >= 2 { k[$2] = k[$2] " " $1; if (NF >= 3) sid[$1] = $3 }
    END { head = 1; tail = 1; q[1] = root
      while (head <= tail) { c = split(k[q[head]], a, " ")
        for (i = 1; i <= c; i++) { if ((a[i] in sid) && (root in sid) && sid[a[i]] != sid[root]) continue; q[++tail] = a[i]; print a[i] }
        head++ } }'
}

kill_tree() {
  local pid=$1 sig=${2:-TERM} d
  [ -n "$pid" ] || return 0
  for d in $(descendants "$pid") "$pid"; do kill "-$sig" "$d" 2>/dev/null; done
  return 0
}

lock_holder() {
  local f=$1 pat=${2:-} pid cmd
  pid=$(cat "$f" 2>/dev/null) || return 1
  is_alive "$pid" || return 1
  if [ -n "$pat" ] && [ -r "/proc/$pid/cmdline" ]; then
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)
    [ -z "$cmd" ] || case $cmd in *"$pat"*) ;; *) return 1 ;; esac
  fi
  printf '%s' "$pid"
}

lock_acquire() {
  local f=$1 pat=${2:-} try
  mkdir -p "$(dirname "$f")"
  for try in 1 2 3; do
    if (set -o noclobber; printf '%s\n' "$$" >"$f") 2>/dev/null; then return 0; fi
    lock_holder "$f" "$pat" >/dev/null && return 1
    rm -f "$f"
  done
  return 1
}

lock_release() { [ "$(cat "$1" 2>/dev/null)" = "$$" ] && rm -f "$1"; return 0; }

secrets_state() {
  [ -f "$CCFG_SECRETS" ] || { printf 'missing'; return 0; }
  [ "$(file_mode "$CCFG_SECRETS")" = 600 ] && printf 'ok' || printf 'badmode'
}

secret_get() {
  [ -f "$CCFG_SECRETS" ] || return 1
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case $line in "$1="*) v=${line#*=}; k=${v:0:1}
      case $k in '"' | "'") [ "${v: -1}" = "$k" ] && [ ${#v} -ge 2 ] && v=${v:1:${#v}-2} ;; esac
      printf '%s' "$v"; return 0 ;;
    esac
  done <"$CCFG_SECRETS"
  return 1
}

secret_names() {
  [ -f "$CCFG_SECRETS" ] || return 0
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in [A-Za-z_]*=*) printf '%s\n' "${line%%=*}" ;; esac
  done <"$CCFG_SECRETS"
}

secret_has() { local v; v=$(secret_get "$1") && [ -n "$v" ]; }

secret_write() {
  local name=$1 val=${2-} del=${3:-0} dir tmp line found=0
  dir=$(dirname "$CCFG_SECRETS")
  mkdir -p "$dir" && chmod 700 "$dir" 2>/dev/null
  tmp=$(umask 077; mktemp "$CCFG_SECRETS.XXXXXX") || return 1
  if [ -f "$CCFG_SECRETS" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        "$name="*) found=1; [ "$del" = 1 ] || printf '%s=%s\n' "$name" "$val" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done <"$CCFG_SECRETS" >"$tmp"
  fi
  [ "$del" = 1 ] || [ "$found" = 1 ] || printf '%s=%s\n' "$name" "$val" >>"$tmp"
  chmod 600 "$tmp" && mv -f "$tmp" "$CCFG_SECRETS"
}

secret_unset() { secret_write "$1" "" 1; }

json_get() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];if(v!=null)console.log(typeof v==="object"?JSON.stringify(v):v)}catch{}})' "$1"
}

coder_host() {
  local u=${CODER_AGENT_URL:-}
  u=${u#*://}; u=${u%%/*}; u=${u%%:*}
  printf '%s' "$u"
}

apply_proxy_env() {
  local url="http://127.0.0.1:$TS_PROXY_PORT" np="localhost,127.0.0.1,::1" h
  h=$(coder_host)
  [ -z "$h" ] || np="$np,$h"
  case $PROXY_MODE in
    env) export NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$url" HTTP_PROXY="$url" NO_PROXY="$np" ;;
    connect) export DOCK_PROXY="$url" NO_PROXY="$np" ;;
  esac
}

load_kit_env() {
  setup_path
  local n v
  for n in $BRIDGE_SECRET_NAMES; do
    v=$(secret_get "$n") || continue
    [ -z "$v" ] || export "$n=$v"
  done
  apply_proxy_env
}

detach() {
  local out=$1; shift
  if [ "$DETACH_MODE" = setsid ] && command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" </dev/null >>"$out" 2>&1 &
  else
    nohup "$@" </dev/null >>"$out" 2>&1 &
  fi
  disown 2>/dev/null
  return 0
}

pin_ready() {
  local T=$1 v s
  v=$(indirect "${T}_VERSION"); s=$(indirect "${T}_SHA256")
  [ -n "$v" ] && [[ $s =~ ^[0-9a-fA-F]{64}$ ]]
}

pins_missing() {
  local T out=""
  for T in $PIN_TOOLS; do pin_ready "$T" || out="$out $T"; done
  printf '%s' "${out# }"
}

service_unit() {
  case $1 in
    tailscale | tailscaled) printf 'tailscaled' ;;
    bridge | chat) printf 'bridge' ;;
    dock) printf 'dock' ;;
    updater) printf 'updater' ;;
    *) return 1 ;;
  esac
}

service_precheck() {
  case $1 in
    tailscaled)
      [ -x "$CCFG_BIN/tailscaled" ] || { echo "tailscaled is not installed (pin missing or install failed)"; return 3; }
      ;;
    bridge)
      command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; return 3; }
      [ -f "$CCFG_CLAUDE_DIR/kit/dock-chat.cjs" ] || { echo "kit is not installed in $CCFG_CLAUDE_DIR/kit"; return 3; }
      [ "$(secrets_state)" = ok ] || { echo "secrets file missing or not mode 600"; return 3; }
      secret_has DOCK_INGEST_URL && secret_has DOCK_INGEST_TOKEN || { echo "DOCK_INGEST_URL or DOCK_INGEST_TOKEN not set (ccfg secret set)"; return 3; }
      ;;
    dock)
      command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; return 3; }
      [ -f "$DOCK_APP_DIR/backend/bff-graphql/dist/index.js" ] || { echo "DOCK is not built in $DOCK_APP_DIR (personalize --only=dock)"; return 3; }
      secret_has DOCK_ENCRYPTION_KEY || { echo "DOCK_ENCRYPTION_KEY not set (personalize --only=dock makes one)"; return 3; }
      ;;
    updater)
      [ "$ENABLE_AUTOUPDATE" = 1 ] || { echo "switch ENABLE_AUTOUPDATE is off"; return 3; }
      command -v git >/dev/null 2>&1 || { echo "git not found on PATH"; return 3; }
      ;;
  esac
  return 0
}

service_prepare() {
  case $1 in
    bridge) load_kit_env; cd "$CCFG_CLAUDE_DIR/kit" || return 1 ;;
    tailscaled) setup_path ;;
    dock)
      setup_path
      mkdir -p "$DOCK_DATA_DIR"
      cd "$DOCK_APP_DIR" || return 1
      export DOCK_MODE=workspace NODE_ENV=production PORT="$DOCK_PORT" TRUST_PROXY=true DOCK_PIN_MODE=always \
        FRONTEND_DIST_PATH="$DOCK_APP_DIR/frontend/dist" DATABASE_URL="file:$DOCK_DATA_DIR/jidis.db" JIDIS_DATA_DIR="$DOCK_DATA_DIR" \
        ENCRYPTION_KEY="$(secret_get DOCK_ENCRYPTION_KEY)"
      # The laptop DOCK on the VPS is the ledger peer, reached over the tailnet through tailscaled.
      # Only the peer uses that proxy: Jira and GitHub keep going out directly.
      local n v
      for n in DOCK_LEDGER_PEER_URL DOCK_LEDGER_PEER_TOKEN; do
        v=$(secret_get "$n") || continue
        [ -z "$v" ] || export "$n=$v"
      done
      export DOCK_LEDGER_PEER_PROXY="http://127.0.0.1:$TS_PROXY_PORT"
      ;;
    updater) setup_path; command -v node >/dev/null 2>&1 || load_template_env ;;
  esac
}

service_exec() {
  case $1 in
    tailscaled)
      mkdir -p "$TS_STATE" "$(dirname "$TS_SOCK")"
      exec "$CCFG_BIN/tailscaled" --tun=userspace-networking --statedir="$TS_STATE" --socket="$TS_SOCK" \
        --socks5-server="127.0.0.1:$TS_PROXY_PORT" --outbound-http-proxy-listen="127.0.0.1:$TS_PROXY_PORT"
      ;;
    bridge) exec node "$CCFG_CLAUDE_DIR/kit/dock-chat.cjs" run ;;
    dock)
      npx prisma db push --skip-generate --schema backend/bff-graphql/prisma/schema.prisma || return 1
      exec node backend/bff-graphql/dist/index.js
      ;;
    # Each pass is a new bash, so a pull that rewrites autoupdate.sh never changes a script while it runs.
    updater) while :; do bash "$CCFG_LINUX_DIR/autoupdate.sh"; sleep "$AUTOUPDATE_EVERY_SECS"; done ;;
  esac
}

service_pid() { lock_holder "$CCFG_RUN/$1.lock" supervise.sh; }

service_start() {
  local u=$1 why
  if service_pid "$u" >/dev/null; then echo "$u: already running (supervisor pid $(service_pid "$u"))"; return 0; fi
  why=$(service_precheck "$u") || { echo "$u: not started: $why"; return 3; }
  mkdir -p "$CCFG_RUN"
  detach "$CCFG_STATE/supervise-$u.out" bash "$CCFG_LINUX_DIR/supervise.sh" "$u"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do service_pid "$u" >/dev/null && { echo "$u: started (supervisor pid $(service_pid "$u"))"; return 0; }; sleep 0.5; done
  echo "$u: supervisor did not come up (see $CCFG_STATE/$u.log)"
  return 1
}

service_stop() {
  local u=$1 sp cp i
  sp=$(service_pid "$u") || sp=""
  cp=$(cat "$CCFG_RUN/$u.child" 2>/dev/null)
  if [ -z "$sp" ] && ! is_alive "$cp"; then echo "$u: not running"; rm -f "$CCFG_RUN/$u.lock" "$CCFG_RUN/$u.child"; return 0; fi
  [ -z "$sp" ] || kill -TERM "$sp" 2>/dev/null
  for i in $(seq 1 40); do is_alive "$sp" || break; sleep 0.25; done
  if is_alive "$sp"; then kill_tree "$sp" KILL; fi
  if is_alive "$cp"; then kill_tree "$cp" TERM; sleep 1; is_alive "$cp" && kill_tree "$cp" KILL; fi
  rm -f "$CCFG_RUN/$u.lock" "$CCFG_RUN/$u.child"
  echo "$u: stopped"
}

ts_cli() { timeout "${TS_CLI_TIMEOUT:-15}" "$CCFG_BIN/tailscale" --socket="$TS_SOCK" "$@"; }
ts_backend_state() { ts_cli status --json 2>/dev/null | json_get BackendState; }

bootstrap_dirs() {
  mkdir -p "$CCFG_STATE" "$CCFG_RUN" "$CCFG_BIN" "$(dirname "$TS_SOCK")"
}
