#!/usr/bin/env bash
# Installs and starts the Claude Code setup in the Linux workspace; each step is wrapped, logged and may fail alone. Use --dry-run to only print.
# shellcheck disable=SC1091
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

DRY=0
STDOUT=0
ONLY=""
STEP_NOTE=""
RESULTS=""
CCFG_TMP=${CCFG_TMP:-$HOME/.cache/claude-config}

note() { [ -z "$STEP_NOTE" ] || printf '%s' "$*" >"$STEP_NOTE"; return 0; }

step() {
  local name=$1 fn=$2 limit=${3:-$STEP_TIMEOUT_SECS} pid wd rc status text
  [ -z "$ONLY" ] || case ",$ONLY," in *",$name,"*) ;; *) return 0 ;; esac
  STEP_NOTE=$CCFG_TMP/note.$$
  : >"$STEP_NOTE"
  ( "$fn" ) &
  pid=$!
  ( sleep "$limit"; kill_tree "$pid" TERM; sleep 3; kill_tree "$pid" KILL ) >/dev/null 2>&1 &
  wd=$!
  wait "$pid"
  rc=$?
  kill_tree "$wd" TERM
  wait "$wd" 2>/dev/null
  case $rc in
    0) status=OK ;;
    10) status=SKIP ;;
    137 | 143) status=FAIL; printf 'timed out after %ss' "$limit" >"$STEP_NOTE" ;;
    *) status=FAIL ;;
  esac
  text=$(cat "$STEP_NOTE" 2>/dev/null)
  [ "$DRY" = 0 ] || text="[dry-run] $text"
  say STEP "$(printf '%-10s %-4s %s' "$name" "$status" "$text")"
  printf '%s|%s|%s\n' "$name" "$status" "$text" >>"$RESULTS"
}

s_toolchain() {
  local marker=${CCFG_TOOLCHAIN_MARKER:-/tmp/qonflo-toolchain.ready} waited=0
  [ -f "$HOME/.config/qonflo/env.sh" ] || { note "no template env.sh, nothing to wait for"; return 0; }
  [ -f "$marker" ] && { note "toolchain ready"; return 0; }
  if [ "$DRY" = 1 ]; then note "would wait up to ${TOOLCHAIN_WAIT_SECS}s for $marker"; return 0; fi
  until [ -f "$marker" ]; do
    [ "$waited" -lt "$TOOLCHAIN_WAIT_SECS" ] || { note "toolchain still not ready after ${TOOLCHAIN_WAIT_SECS}s; steps needing node will skip"; return 10; }
    sleep 5
    waited=$((waited + 5))
  done
  note "toolchain ready after ${waited}s"
}

s_link() {
  local target=$CCFG_LINUX_DIR/ccfg link=$CCFG_BIN/ccfg
  [ "$(readlink "$link" 2>/dev/null)" = "$target" ] && { note "ccfg already linked in $CCFG_BIN"; return 0; }
  if [ "$DRY" = 1 ]; then note "would link $link"; return 0; fi
  mkdir -p "$CCFG_BIN" && ln -sfn "$target" "$link" && note "linked $link"
}

s_repo() {
  local before after
  [ -d "$CCFG_REPO/.git" ] || { note "repo is not a git checkout, using it as is"; return 10; }
  if [ "$DRY" = 1 ]; then note "would run git pull --ff-only in $CCFG_REPO"; return 0; fi
  before=$(git -C "$CCFG_REPO" rev-parse HEAD 2>/dev/null)
  timeout 60 git -C "$CCFG_REPO" pull --ff-only || { note "pull failed, using the existing checkout"; return 1; }
  after=$(git -C "$CCFG_REPO" rev-parse HEAD 2>/dev/null)
  [ "$before" = "$after" ] && note "already up to date" || note "updated ${before:0:7}..${after:0:7}"
}

install_pinned() {
  local T=$1 tool ver sha url fmt bins b marker tmp got p ok=1
  tool=$(printf '%s' "$T" | tr 'A-Z' 'a-z')
  ver=$(indirect "${T}_VERSION"); sha=$(indirect "${T}_SHA256"); url=$(indirect "${T}_URL")
  fmt=$(indirect "${T}_FORMAT"); bins=$(indirect "${T}_BINS")
  if ! pin_ready "$T"; then
    say WARN "$tool: not pinned yet (set ${T}_VERSION and ${T}_SHA256 in linux/versions.env), refusing to install"
    return 10
  fi
  url=${url//%V/$ver}
  marker=$CCFG_STATE/bins/$tool.pin
  for b in ${bins//,/ }; do [ -x "$CCFG_BIN/$b" ] || ok=0; done
  if [ "$ok" = 1 ] && [ "$(cat "$marker" 2>/dev/null)" = "$ver ${sha,,}" ]; then
    say INFO "$tool $ver: already installed"
    return 11
  fi
  if [ "$DRY" = 1 ]; then say INFO "$tool $ver: would download $url, check sha256, install $bins"; return 12; fi
  mkdir -p "$CCFG_STATE/bins" "$CCFG_BIN"
  tmp=$(mktemp -d "$CCFG_STATE/tmp.XXXXXX") || return 1
  if ! timeout 600 curl -fsSL --retry 2 --connect-timeout 20 -o "$tmp/dl" "$url"; then
    say ERROR "$tool: download failed ($url)"; rm -rf "$tmp"; return 1
  fi
  got=$(sha256sum "$tmp/dl" | cut -d' ' -f1)
  if [ "$got" != "${sha,,}" ]; then
    say ERROR "$tool: sha256 mismatch (expected ${sha,,}, got $got), nothing installed"; rm -rf "$tmp"; return 1
  fi
  mkdir -p "$tmp/x"
  : >"$CCFG_STATE/bins/$tool.files"
  if [ "$fmt" = tgz ]; then
    tar -xzf "$tmp/dl" -C "$tmp/x" || { say ERROR "$tool: archive could not be extracted"; rm -rf "$tmp"; return 1; }
    for b in ${bins//,/ }; do
      p=$(find "$tmp/x" -type f -name "$b" | head -n 1)
      [ -n "$p" ] || { say ERROR "$tool: $b not found in the archive"; rm -rf "$tmp"; return 1; }
      install -m 755 "$p" "$CCFG_BIN/.$b.new" && mv -f "$CCFG_BIN/.$b.new" "$CCFG_BIN/$b" || { rm -rf "$tmp"; return 1; }
      printf '%s\n' "$CCFG_BIN/$b" >>"$CCFG_STATE/bins/$tool.files"
    done
  else
    b=${bins%%,*}
    install -m 755 "$tmp/dl" "$CCFG_BIN/.$b.new" && mv -f "$CCFG_BIN/.$b.new" "$CCFG_BIN/$b" || { rm -rf "$tmp"; return 1; }
    printf '%s\n' "$CCFG_BIN/$b" >>"$CCFG_STATE/bins/$tool.files"
  fi
  printf '%s %s\n' "$ver" "${sha,,}" >"$marker"
  rm -rf "$tmp"
  say INFO "$tool $ver: installed"
  return 0
}

s_binaries() {
  local T rc done_=0 skipped=0 failed=0 already=0 would=0
  case "$(uname -s)/$(uname -m)" in
    Linux/aarch64 | Linux/arm64) ;;
    *) note "not Linux aarch64, the pinned assets do not apply"; return 10 ;;
  esac
  for T in $PIN_TOOLS; do
    install_pinned "$T"
    rc=$?
    case $rc in 0) done_=$((done_ + 1)) ;; 10) skipped=$((skipped + 1)) ;; 11) already=$((already + 1)) ;; 12) would=$((would + 1)) ;; *) failed=$((failed + 1)) ;; esac
  done
  note "installed=$done_ already=$already would=$would unpinned=$skipped failed=$failed$([ "$skipped" -gt 0 ] && printf " (missing pins: %s)" "$(pins_missing)")"
  [ "$failed" = 0 ] || return 1
  [ "$((done_ + already + would))" -gt 0 ] || return 10
  return 0
}

s_secrets() {
  local st n
  st=$(secrets_state)
  n=$(secret_names | wc -l | tr -d ' ')
  case $st in
    ok) note "secrets file mode 600, $n names"; return 0 ;;
    missing) note "no secrets file, steps needing secrets are skipped; run ccfg secret set DOCK_INGEST_URL (and DOCK_INGEST_TOKEN, TS_AUTHKEY, TYPESAFE_API_KEY)"; return 10 ;;
    *) note "secrets file mode is $(file_mode "$CCFG_SECRETS"), not 600; steps needing secrets are skipped (fix with chmod 600)"; return 10 ;;
  esac
}

install_args() {
  local sf=$CCFG_STATE/no-secrets.env
  [ "$(secrets_state)" = ok ] && sf=$CCFG_SECRETS
  INSTALL_ARGS=(--os linux --config-dir "$(native_path "$CCFG_CLAUDE_DIR")" --secrets-file "$(native_path "$sf")")
}

s_install() {
  local inst=$CCFG_REPO/install/install.cjs out orig=$CCFG_STATE/orig f
  [ -f "$inst" ] || { note "install.cjs not found"; return 10; }
  command -v node >/dev/null 2>&1 || { note "node not found"; return 10; }
  install_args
  inst=$(native_path "$inst")
  if [ "$DRY" = 1 ]; then
    out=$(node "$inst" "${INSTALL_ARGS[@]}" --dry-run 2>&1)
    printf '%s\n' "$out" | grep -E 'settings.json:|^files:|^CLAUDE.md|^  (new|same|changed)' | head -n 12
    note "$(printf '%s\n' "$out" | tail -n 1)"
    return 0
  fi
  if node "$inst" "${INSTALL_ARGS[@]}" --check >/dev/null 2>&1; then note "already in sync with the repo"; return 0; fi
  if [ ! -f "$orig/.done" ]; then
    mkdir -p "$orig"
    for f in settings.json CLAUDE.md; do [ -f "$CCFG_CLAUDE_DIR/$f" ] && cp -p "$CCFG_CLAUDE_DIR/$f" "$orig/$f"; done
    : >"$orig/.done"
  fi
  mkdir -p "$CCFG_CLAUDE_DIR"
  out=$(node "$inst" "${INSTALL_ARGS[@]}" --apply 2>&1) || { printf '%s\n' "$out" | tail -n 5; note "install.cjs --apply failed"; return 1; }
  printf '%s\n' "$out" | grep -E 'settings.json:|^files:|applied' | head -n 6
  note "applied"
}

s_coord() {
  local created=0 dirty
  [ "$ENABLE_QONFLO_COORD" = 1 ] || { note "switch ENABLE_QONFLO_COORD is off"; return 10; }
  [ -n "$QONFLO_COORD_URL" ] || { note "QONFLO_COORD_URL is empty"; return 10; }
  [ -d "$PROJECTS_DIR" ] || { note "$PROJECTS_DIR does not exist"; return 10; }
  if [ -d "$PROJECTS_DIR/.git" ]; then
    dirty=$(git -C "$PROJECTS_DIR" status --porcelain 2>/dev/null | head -n 1)
    [ -z "$dirty" ] || { note "working tree in $PROJECTS_DIR is not clean, left alone"; return 10; }
    if [ "$DRY" = 1 ]; then note "would run git pull --ff-only in $PROJECTS_DIR"; return 0; fi
    timeout 60 git -C "$PROJECTS_DIR" pull --ff-only && note "pulled" || { note "pull failed"; return 1; }
    return 0
  fi
  if [ "$DRY" = 1 ]; then note "would git init, add origin $QONFLO_COORD_URL, fetch and check out $QONFLO_COORD_BRANCH in $PROJECTS_DIR (no force)"; return 0; fi
  git -C "$PROJECTS_DIR" init -q && created=1 || return 1
  if git -C "$PROJECTS_DIR" remote add origin "$QONFLO_COORD_URL" \
    && timeout 120 git -C "$PROJECTS_DIR" fetch -q origin \
    && git -C "$PROJECTS_DIR" checkout -t "origin/$QONFLO_COORD_BRANCH"; then
    note "checked out $QONFLO_COORD_BRANCH"
    return 0
  fi
  [ "$created" = 1 ] && rm -rf "$PROJECTS_DIR/.git"
  note "checkout failed, the .git created by this step was removed"
  return 1
}

ts_login() {
  local key dir rc
  key=$(secret_get TS_AUTHKEY) || return 1
  case $TS_AUTH_METHOD in
    file)
      dir=$(umask 077; mktemp -d "$CCFG_STATE/auth.XXXXXX") || return 1
      (umask 077; printf '%s' "$key" >"$dir/key")
      TS_CLI_TIMEOUT=90 ts_cli up --auth-key="file:$dir/key" --hostname="$TS_HOSTNAME" --accept-routes=false --accept-dns=false
      rc=$?
      rm -rf "$dir"
      ;;
    *)
      TS_AUTHKEY=$key TS_CLI_TIMEOUT=90 ts_cli up --hostname="$TS_HOSTNAME" --accept-routes=false --accept-dns=false
      rc=$?
      ;;
  esac
  return $rc
}

wait_state() {
  local want=$1 secs=$2 i st=""
  for ((i = 0; i < secs; i += 2)); do
    st=$(ts_backend_state)
    case $want in any) [ -z "$st" ] || { printf '%s' "$st"; return 0; } ;; *) [ "$st" = "$want" ] && { printf '%s' "$st"; return 0; } ;; esac
    sleep 2
  done
  printf '%s' "$st"
  return 1
}

s_tailscale() {
  local st
  if [ ! -x "$CCFG_BIN/tailscaled" ] || [ ! -x "$CCFG_BIN/tailscale" ]; then note "tailscale is not installed (binaries step)"; return 10; fi
  if [ "$DRY" = 1 ]; then
    service_pid tailscaled >/dev/null && note "daemon already running" || note "would start tailscaled under supervise.sh (userspace, SOCKS5+HTTP on 127.0.0.1:$TS_PROXY_PORT), then join as $TS_HOSTNAME if needed"
    return 0
  fi
  service_start tailscaled || { note "tailscaled did not start"; return 1; }
  st=$(wait_state any 30)
  case $st in
    Running)
      if [ "$(secrets_state)" = ok ] && secret_has TS_AUTHKEY; then secret_unset TS_AUTHKEY && say INFO "TS_AUTHKEY removed from the secrets file"; fi
      note "already joined (Running)"
      return 0
      ;;
  esac
  [ "$(secrets_state)" = ok ] || { note "backend $st; cannot join, secrets file missing or not mode 600"; return 10; }
  secret_has TS_AUTHKEY || { note "backend $st; cannot join, TS_AUTHKEY not set (ccfg secret set TS_AUTHKEY)"; return 10; }
  ts_login || { note "tailscale up failed"; return 1; }
  st=$(wait_state Running 60) || { note "joined but backend is $st, key kept"; return 1; }
  secret_unset TS_AUTHKEY && say INFO "TS_AUTHKEY removed from the secrets file"
  note "joined as $TS_HOSTNAME"
}

s_reach() {
  local url origin chk st
  [ "$(secrets_state)" = ok ] && secret_has DOCK_INGEST_URL || { note "DOCK_INGEST_URL not available"; return 10; }
  [ -f "$CCFG_CLAUDE_DIR/kit/dock-push.cjs" ] || { note "kit not installed"; return 10; }
  command -v node >/dev/null 2>&1 || { note "node not found"; return 10; }
  [ -x "$CCFG_BIN/tailscale" ] || { note "tailscale not installed"; return 10; }
  st=$(ts_backend_state)
  [ "$st" = Running ] || { note "tailnet not up (backend: ${st:-unknown})"; return 10; }
  if [ "$DRY" = 1 ]; then note "would run dock-push.cjs check and GET /health through the proxy"; return 0; fi
  url=$(secret_get DOCK_INGEST_URL)
  origin=${url%%/ingest*}
  chk=$( (load_kit_env; cd "$CCFG_CLAUDE_DIR/kit" && timeout 20 node dock-push.cjs check) 2>&1)
  printf '%s\n' "$chk" | grep -E '^(url|not configured)' | head -n 1
  printf '%s\n' "$chk" | grep -q '^token: set' || { note "dock-push.cjs check: token not set"; return 1; }
  st=$( (load_kit_env; timeout 25 node -e 'fetch(process.argv[1]).then(r=>{console.log(r.status);process.exit(r.status===200?0:1)}).catch(e=>{console.log(e.message);process.exit(1)})' "$origin/health") 2>&1)
  [ "$st" = 200 ] && { note "DOCK /health answered 200 through the proxy"; return 0; }
  note "DOCK /health failed: $st"
  return 1
}

PLUGIN_JS='
const j = require(process.argv[1]);
for (const [n, m] of Object.entries(j.marketplaces || {})) {
  if (!(m.os || []).includes("linux") || /built in/.test(m.note || "")) continue;
  console.log(["M", n, m.source === "github" ? m.repo : m.url].join("\t"));
}
for (const p of j.plugins || []) if ((p.os || []).includes("linux")) console.log(["P", p.name, p.marketplace, p.requiresSecret || ""].join("\t"));
'

MCP_JS='
const fs = require("fs");
const [mode, cfgFile, secretsFile, claudeJson, only] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")).mcpServers || {};
const secrets = {};
try { for (const l of fs.readFileSync(secretsFile, "utf8").split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l); if (m) secrets[m[1]] = m[2].replace(/^(["\x27])(.*)\1$/, "$2"); } } catch {}
if (process.env.GH_FALLBACK_TOKEN && !secrets.GITHUB_PERSONAL_ACCESS_TOKEN) secrets.GITHUB_PERSONAL_ACCESS_TOKEN = process.env.GH_FALLBACK_TOKEN;
let cj = {};
try { cj = JSON.parse(fs.readFileSync(claudeJson, "utf8")); } catch {}
const have = (n) => Boolean((cj.mcpServers || {})[n]);
const needs = (v) => { const s = JSON.stringify(v), out = []; s.replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (_, n) => { out.push(n); return ""; }); return out; };
if (mode === "list") {
  const stale = (n, v) => !needs(v).length && Object.keys(v).some((k) => JSON.stringify(cj.mcpServers[n][k]) !== JSON.stringify(v[k]));
  for (const [n, v] of Object.entries(cfg)) console.log([n, have(n) ? (stale(n, v) ? "stale" : "have") : "missing", needs(v).join(",") || "-"].join("\t"));
} else if (mode === "json") {
  console.log(JSON.stringify(cfg[only]));
} else if (mode === "write") {
  const v = cfg[only];
  const miss = needs(v).filter((n) => !secrets[n]);
  if (!v || miss.length) { console.log("missing secrets: " + miss.join(",")); process.exit(10); }
  const filled = JSON.parse(JSON.stringify(v).replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (_, n) => JSON.stringify(secrets[n]).slice(1, -1)));
  if (!fs.existsSync(claudeJson + ".bak-ccfg") && fs.existsSync(claudeJson)) fs.copyFileSync(claudeJson, claudeJson + ".bak-ccfg");
  cj.mcpServers = { ...(cj.mcpServers || {}), [only]: filled };
  const tmp = claudeJson + ".ccfg-tmp";
  fs.writeFileSync(tmp, JSON.stringify(cj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, claudeJson);
}
'

s_plugins() {
  local kind a b c names=0 added=0 failed=0 mcp_added=0 mcp_have=0 mcp_skip=0 mf=$CCFG_CLAUDE_DIR/plugins n state sec json
  command -v claude >/dev/null 2>&1 || { note "claude not found on PATH"; return 10; }
  command -v node >/dev/null 2>&1 || { note "node not found"; return 10; }
  [ "$DRY" = 1 ] || mkdir -p "$CCFG_STATE"
  while IFS=$'\t' read -r kind a b c; do
    case $kind in
      M)
        if grep -qs "\"$a\"" "$mf/known_marketplaces.json"; then say INFO "marketplace $a: already added"; continue; fi
        if [ "$DRY" = 1 ]; then say INFO "marketplace $a: would add $b"; continue; fi
        if timeout 180 claude plugin marketplace add "$b"; then printf 'marketplace:%s\n' "$a" >>"$CCFG_STATE/plugins-added.txt"; added=$((added + 1)); else say ERROR "marketplace $a: add failed"; failed=$((failed + 1)); fi
        ;;
      P)
        if grep -qs "\"$a@$b\"" "$mf/installed_plugins.json"; then say INFO "plugin $a@$b: already installed"; continue; fi
        if [ "$DRY" = 1 ]; then say INFO "plugin $a@$b: would install"; continue; fi
        [ -z "$c" ] || secret_has "$c" || say WARN "plugin $a needs $c in the settings env; set it with ccfg secret set and re-run ccfg update"
        if timeout 300 claude plugin install "$a@$b"; then printf 'plugin:%s@%s\n' "$a" "$b" >>"$CCFG_STATE/plugins-added.txt"; added=$((added + 1)); else say ERROR "plugin $a@$b: install failed"; failed=$((failed + 1)); fi
        ;;
    esac
  done < <(node -e "$PLUGIN_JS" "$(native_path "$CCFG_REPO/plugins/plugins.json")" 2>&1)
  local cfg sf=$CCFG_STATE/no-secrets.env cj=$HOME/.claude.json
  cfg=$(native_path "$CCFG_REPO/mcp/mcp.linux.json")
  [ "$(secrets_state)" = ok ] && sf=$CCFG_SECRETS
  while IFS=$'\t' read -r n state sec; do
    [ -n "$n" ] || continue
    if [ "$state" = have ]; then mcp_have=$((mcp_have + 1)); continue; fi
    if [ "$state" = stale ]; then
      if [ "$DRY" = 1 ]; then say INFO "mcp $n: would update to the repo definition"; continue; fi
      if node -e "$MCP_JS" write "$cfg" "$(native_path "$sf")" "$(native_path "$cj")" "$n" >/dev/null; then mcp_added=$((mcp_added + 1)); say INFO "mcp $n: updated; log in again with /mcp"; else say ERROR "mcp $n: update failed"; failed=$((failed + 1)); fi
      continue
    fi
    if [ "$DRY" = 1 ]; then say INFO "mcp $n: would register at user scope"; continue; fi
    if [ "$sec" = - ]; then
      json=$(node -e "$MCP_JS" json "$cfg" "$(native_path "$sf")" "$(native_path "$cj")" "$n")
      if timeout 60 claude mcp add-json "$n" "$json" --scope user; then printf '%s\n' "$n" >>"$CCFG_STATE/mcp-added.txt"; mcp_added=$((mcp_added + 1)); else say ERROR "mcp $n: add-json failed"; failed=$((failed + 1)); fi
    else
      if [ "$(secrets_state)" != ok ]; then say WARN "mcp $n: needs secrets, secrets file not ready"; mcp_skip=$((mcp_skip + 1)); continue; fi
      if [ "$n" = github ] && ! secret_has GITHUB_PERSONAL_ACCESS_TOKEN && command -v gh >/dev/null 2>&1; then GH_FALLBACK_TOKEN=$(gh auth token 2>/dev/null); export GH_FALLBACK_TOKEN; fi
      if node -e "$MCP_JS" write "$cfg" "$(native_path "$sf")" "$(native_path "$cj")" "$n" >/dev/null; then printf '%s\n' "$n" >>"$CCFG_STATE/mcp-added.txt"; mcp_added=$((mcp_added + 1)); else say WARN "mcp $n: skipped, a needed secret is not set ($sec)"; mcp_skip=$((mcp_skip + 1)); fi
      unset GH_FALLBACK_TOKEN
    fi
  done < <(node -e "$MCP_JS" list "$cfg" "$(native_path "$sf")" "$(native_path "$cj")" 2>&1)
  note "plugins/marketplaces added=$added; mcp added=$mcp_added already=$mcp_have skipped=$mcp_skip; failed=$failed"
  [ "$failed" = 0 ]
}

BRIDGE_JS='
const fs = require("fs");
const [file, cwd, mode, timeout] = process.argv.slice(1);
const want = { managedBy: "claude-config linux/personalize.sh", cwd, configDir: null, claudeBin: "claude", permissionMode: mode || null, turnTimeoutMs: Number(timeout), keepAwake: { mechanism: "off" }, passEnv: ["DOCK_INGEST_TOKEN"] };
let cur = null;
try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (cur && !cur.managedBy) { console.log("kept"); process.exit(0); }
const text = JSON.stringify(want, null, 2) + "\n";
let old = ""; try { old = fs.readFileSync(file, "utf8"); } catch {}
if (old === text) { console.log("same"); process.exit(0); }
fs.writeFileSync(file, text);
console.log("changed");
'

s_bridge() {
  local why res cfg=$CCFG_CLAUDE_DIR/kit/dock-chat.json
  [ -f "$CCFG_CLAUDE_DIR/kit/dock-chat.cjs" ] || { note "kit not installed"; return 10; }
  why=$(service_precheck bridge) || { note "$why"; return 10; }
  if [ "$DRY" = 1 ]; then
    service_pid bridge >/dev/null && note "bridge already running" || note "would write dock-chat.json (permissionMode $BRIDGE_PERMISSION_MODE, cwd $BRIDGE_CWD) and start the bridge under supervise.sh"
    return 0
  fi
  res=$(node -e "$BRIDGE_JS" "$(native_path "$cfg")" "$BRIDGE_CWD" "$BRIDGE_PERMISSION_MODE" "$BRIDGE_TURN_TIMEOUT_MS") || { note "could not write dock-chat.json"; return 1; }
  [ "$res" != changed ] || { service_pid bridge >/dev/null && service_stop bridge; }
  service_start bridge || { note "bridge did not start"; return 1; }
  note "bridge running (config $res)"
}

s_updater() {
  local why
  why=$(service_precheck updater) || { note "$why"; return 10; }
  if [ "$DRY" = 1 ]; then
    service_pid updater >/dev/null && note "updater already running" || note "would start the updater (a pass every ${AUTOUPDATE_EVERY_SECS}s)"
    return 0
  fi
  service_start updater || { note "updater did not start"; return 1; }
  note "updater running"
}

s_dock() {
  local head
  [ "$ENABLE_DOCK" = 1 ] || { note "switch ENABLE_DOCK is off"; return 10; }
  command -v gh >/dev/null 2>&1 || { note "gh not found"; return 10; }
  command -v node >/dev/null 2>&1 || { note "node not found"; return 10; }
  if [ "$DRY" = 1 ]; then note "would clone or pull $DOCK_REPO into $DOCK_APP_DIR, build it when HEAD moved and start DOCK on port $DOCK_PORT"; return 0; fi
  if [ -d "$DOCK_APP_DIR/.git" ]; then
    timeout 120 git -C "$DOCK_APP_DIR" pull --ff-only || { note "pull failed"; return 1; }
  else
    timeout 300 gh repo clone "$DOCK_REPO" "$DOCK_APP_DIR" || { note "clone failed"; return 1; }
  fi
  secret_has DOCK_ENCRYPTION_KEY || secret_write DOCK_ENCRYPTION_KEY "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" || { note "could not write DOCK_ENCRYPTION_KEY"; return 1; }
  mkdir -p "$DOCK_DATA_DIR"
  head=$(git -C "$DOCK_APP_DIR" rev-parse HEAD)
  if [ "$head" != "$(cat "$DOCK_DATA_DIR/built" 2>/dev/null)" ]; then
    (cd "$DOCK_APP_DIR" && npm ci && npm run db:generate --workspace=backend/bff-graphql && VITE_GRAPHQL_URL=/graphql npm run build:app) >"$CCFG_STATE/dock-build.log" 2>&1 \
      || { note "build failed (see $CCFG_STATE/dock-build.log)"; return 1; }
    printf '%s\n' "$head" >"$DOCK_DATA_DIR/built"
    service_pid dock >/dev/null && service_stop dock
  fi
  service_start dock || { note "dock did not start"; return 1; }
  note "DOCK ${head:0:7} on 127.0.0.1:$DOCK_PORT"
}

s_brain() {
  local dir=$HOME/brain
  [ "$ENABLE_BRAIN" = 1 ] || { note "switch ENABLE_BRAIN is off"; return 10; }
  command -v gh >/dev/null 2>&1 || { note "gh not found"; return 10; }
  if [ -d "$dir/.git" ]; then
    if [ "$DRY" = 1 ]; then note "would run git pull --ff-only in $dir"; return 0; fi
    timeout 120 git -C "$dir" pull --ff-only && note "pulled" || { note "pull failed, vault may be stale"; return 1; }
    return 0
  fi
  if [ "$DRY" = 1 ]; then note "would run gh repo clone $BRAIN_REPO $dir"; return 0; fi
  timeout 300 gh repo clone "$BRAIN_REPO" "$dir" && note "cloned" || { note "clone failed"; return 1; }
}

s_fallback() {
  local rc=$HOME/.bashrc has=0
  grep -qs 'claude-config-ensure-begin' "$rc" && has=1
  if [ "$BASHRC_FALLBACK" = 1 ]; then
    [ "$has" = 1 ] && { note "bashrc hook already present"; return 0; }
    if [ "$DRY" = 1 ]; then note "would add the ensure hook to $rc"; return 0; fi
    printf '%s\n' ': claude-config-ensure-begin' '[ -x "$HOME/.local/bin/ccfg" ] && { "$HOME/.local/bin/ccfg" ensure >/dev/null 2>&1 & }' ': claude-config-ensure-end' >>"$rc"
    note "bashrc hook added"
    return 0
  fi
  [ "$has" = 1 ] || { note "switch BASHRC_FALLBACK is off"; return 10; }
  if [ "$DRY" = 1 ]; then note "would remove the ensure hook from $rc"; return 0; fi
  sed -i '/claude-config-ensure-begin/,/claude-config-ensure-end/d' "$rc"
  note "bashrc hook removed"
}

finish() {
  local node_ok=0
  command -v node >/dev/null 2>&1 && node_ok=1
  if [ "$DRY" = 0 ] && [ "$node_ok" = 1 ]; then
    node -e '
const fs = require("fs");
const steps = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { const [step, status, ...n] = l.split("|"); return { step, status, note: n.join("|") }; });
fs.writeFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), steps }, null, 2) + "\n");
' "$(native_path "$RESULTS")" "$(native_path "$CCFG_STATE/last-run.json")"
  fi
  say DONE "personalize finished: $(cut -d'|' -f2 "$RESULTS" | sort | uniq -c | tr -s ' ' | tr '\n' ',' | sed 's/,$//')"
  rm -rf "$CCFG_TMP"
  rmdir "$(dirname "$CCFG_TMP")" 2>/dev/null
}

main() {
  local a
  for a in "$@"; do
    case $a in
      --dry-run) DRY=1 ;;
      --stdout) STDOUT=1 ;;
      --only=*) ONLY=${a#--only=} ;;
      -h | --help) echo "usage: personalize.sh [--dry-run] [--stdout] [--only=step,step]"; return 0 ;;
    esac
  done
  if [ "$(uname -s)" != Linux ]; then echo "personalize.sh: not Linux, nothing done"; return 0; fi
  mkdir -p "$CCFG_TMP"
  RESULTS=$CCFG_TMP/results.$$
  : >"$RESULTS"
  if [ "$DRY" = 0 ]; then
    bootstrap_dirs
    if ! lock_acquire "$CCFG_RUN/personalize.lock" personalize.sh; then return 0; fi
    trap 'lock_release "$CCFG_RUN/personalize.lock"' EXIT
    if [ "$STDOUT" = 0 ]; then
      rotate_log "$CCFG_STATE/personalize.log"
      exec >>"$CCFG_STATE/personalize.log" 2>&1
    fi
  fi
  say INFO "personalize start (dry-run=$DRY, repo=$CCFG_REPO)"
  setup_path
  step toolchain s_toolchain $((TOOLCHAIN_WAIT_SECS + 60))
  load_template_env
  step link s_link
  step repo s_repo 90
  step binaries s_binaries 1500
  step secrets s_secrets
  step install s_install 300
  step coord s_coord 300
  step tailscale s_tailscale 300
  step reach s_reach 90
  step plugins s_plugins 1800
  step dock s_dock 1200
  step bridge s_bridge 120
  step updater s_updater 30
  step brain s_brain 400
  step fallback s_fallback
  finish
  return 0
}

main "$@"; exit 0
