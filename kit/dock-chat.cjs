// Laptop bridge for DOCK chat: claims queued browser messages, runs them through Claude Code, streams the answer back.
//   node dock-chat.cjs run      loop forever: claim -> one turn -> deltas -> next
//   node dock-chat.cjs once     handle at most one message and exit  [--wait seconds, default 5]
//   node dock-chat.cjs check    show the configuration (never the token)
//   node dock-chat.cjs label "<command>"   print the activity label a Bash command gets (rules: activity-labels.json)
// Config: dock-chat.json next to this file, all optional:
//   { "cwd": "E:/qonflo", "configDir": "C:/Users/danus/.claude-kantor", "permissionMode": null, "maxTurns": null, "extraArgs": [],
//     "claudeBin": "claude", "turnTimeoutMs": 1800000, "retryBaseMs": 1000,
//     "interactive": true, "askTtlSeconds": 600,   interactive: false keeps every turn on the one-shot path; askTtlSeconds is how long a phone prompt waits (30..1800)
//     "keepAwake": { "mechanism": "off | app-status | server", "appSlug": null },
//     "activity": { "enabled": true, "hooks": true, "subagentText": true } }   "activity": false (or enabled: false) switches the activity feed off
// Defaults come from paths.cjs. On Linux configDir is unset, so Claude Code keeps its own ~/.claude.
// The DOCK url and token come from dock-push.cjs (dock.json or env).
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { maskString, config, send, toolLine, cut } = require("./dock-push.cjs");
const activityLib = require("./activity.cjs");
const interact = require("./dock-chat-interact.cjs");
const session = require("./dock-chat-session.cjs");
const catalogLib = require("./dock-chat-catalog.cjs");
const { pruneFiles } = require("./dock-chat-files.cjs");
const guardLib = require("./guard.cjs");
const procLib = require("./dock-chat-proc.cjs");
const preflight = require("./dock-chat-preflight.cjs");
const PATHS = require("./paths.cjs").resolvePaths();

const STATE_DIR = process.env.DOCK_KIT_STATE_DIR || __dirname;
const SESSIONS_FILE = path.join(STATE_DIR, "dock-chat-sessions.json");
const ALLOW_FILE = path.join(STATE_DIR, "dock-chat-allow.json");
const KIT_ID = "dock-kit-2";
const OLD_SERVER_MS = 10 * 60 * 1000;
const CATALOG_EVERY_MS = 6 * 60 * 60 * 1000;
const CATALOG_RETRY_MS = 10 * 60 * 1000;
const TERMINAL_COMMANDS = ["doctor", "color", "focus", "reload-plugins"];
const DELTA_INTERVAL_MS = 1000;
const CLAIM_WAIT_S = 25;
const MAX_BACKOFF_MS = 30000;
const KEEP_AWAKE_EVERY_MS = 10 * 60 * 1000;
const BRIDGE_SECRET = /^(DOCK_INGEST_TOKEN|DOCK_MASK_EXTRA|BRAIN_TOKEN|CODER_AGENT_TOKEN|CODER_SESSION_TOKEN|(DOCK|BRAIN|CODER)_[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|KEY|PIN))$/;
const PROXY_VARS = /^(https?_proxy|all_proxy|node_use_env_proxy|dock_proxy)$/i;
const ACTIVITY_INTERVAL_MS = DELTA_INTERVAL_MS;
const ACTIVITY_TIMEOUT_MS = 5000;
const ACTIVITY_FINAL_WAIT_MS = 1000;
const ACTIVITY_SILENCE_MS = 10 * 60 * 1000;
const ACTIVITY_PAUSE_MS = 60 * 1000;
const HELP_TIMEOUT_MS = 5000;
// Thinking text never reaches the stream, so the skill choice is made visible by having Claude write it in the reply DOCK shows.
const SKILL_LINE_PROMPT = "This turn runs from DOCK chat, where the person follows your steps on a phone and cannot see your thinking. Before your first tool call of each task, write one plain line in your reply: Skills: <2-4 keywords from the task> / candidates: <matching skills from the available-skills list, or none> / using: <the skill you invoke, or none>. Then work as usual.";

const log = (msg) => console.log(`${new Date().toISOString()} ${String(msg).replace(/[\u0000-\u001f\u007f]+/g, " ")}`);
const safeId = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 64);
const within = (ms, promise) => new Promise((resolve) => { const t = setTimeout(resolve, ms); promise.then(() => { clearTimeout(t); resolve(); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timing(askTtlSeconds, env = process.env) {
	let t = {};
	try { t = JSON.parse(env.DOCK_CHAT_TUNING || "{}"); } catch {}
	const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
	return {
		askTtlMs: num(t.askTtlMs, askTtlSeconds * 1000), waitBudgetMs: num(t.waitBudgetMs, 30 * 60 * 1000), waitSeconds: num(t.waitSeconds, 25), waitGapMs: num(t.waitGapMs, 1000),
		interruptGraceMs: num(t.interruptGraceMs, 10000), closeGraceMs: num(t.closeGraceMs, 5000), exitGraceMs: num(t.exitGraceMs, 10000), drainMs: num(t.drainMs, 1500),
	};
}

function settings({ platform = process.platform, paths = PATHS, file: given } = {}) {
	let file = {};
	if (given) file = given;
	else try { file = JSON.parse(fs.readFileSync(process.env.DOCK_CHAT_CONFIG || path.join(__dirname, "dock-chat.json"), "utf8")); } catch {}
	const ka = file.keepAwake || {};
	const askTtlSeconds = Math.min(1800, Math.max(30, Number(file.askTtlSeconds) || 600));
	return {
		interactive: file.interactive !== false,
		askTtlSeconds,
		timing: timing(askTtlSeconds),
		cwd: file.cwd || paths.root,
		configDir: file.configDir || (platform === "win32" ? paths.configDir : null),
		permissionMode: file.permissionMode || null,
		maxTurns: file.maxTurns || null,
		extraArgs: Array.isArray(file.extraArgs) ? file.extraArgs.map(String) : [],
		appendSystemPrompt: typeof file.appendSystemPrompt === "string" ? file.appendSystemPrompt : SKILL_LINE_PROMPT,
			passEnv: Array.isArray(file.passEnv) ? file.passEnv.map(String).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) : [],
		claudeBin: file.claudeBin || "claude",
		turnTimeoutMs: file.turnTimeoutMs || 30 * 60 * 1000,
		retryBaseMs: file.retryBaseMs || 1000,
		keepAwake: { mechanism: ["app-status", "server"].includes(ka.mechanism) ? ka.mechanism : "off", appSlug: ka.appSlug || null },
		activity: { enabled: file.activity !== false && !(file.activity && file.activity.enabled === false), hooks: !(file.activity && file.activity.hooks === false), subagentText: !(file.activity && file.activity.subagentText === false), labelsDir: (file.activity && file.activity.labelsDir) || null },
	};
}

// The environment claude runs in. DOCK_CHAT_TURN=1 switches guard.cjs to its unattended profile; CAVEMAN_DEFAULT_MODE switches caveman on,
// which stays off in a headless session without it; CLAUDE_CONFIG_DIR is set only when configDir is; the proxy variables kit-node sets to
// reach DOCK are removed so Anthropic traffic does not go through tailscaled.
function childEnv(opts, base = process.env) {
	const env = { ...base, DOCK_CHAT_TURN: "1", CAVEMAN_DEFAULT_MODE: "caveman" };
	const keep = new Set(Array.isArray(opts.passEnv) ? opts.passEnv : []);
	for (const k of Object.keys(env)) if (BRIDGE_SECRET.test(k) && !keep.has(k)) delete env[k];
	if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
	else delete env.CLAUDE_CONFIG_DIR;
	if (base.NODE_USE_ENV_PROXY === "1" || base.DOCK_PROXY) for (const k of Object.keys(env)) if (PROXY_VARS.test(k)) delete env[k];
	return env;
}

// Keeps the Coder workspace awake while a chat turn runs. This is the only place that knows how; it never throws and never blocks a turn.
//   app-status  reports the agent as "working" through the Coder agent API (needs CODER_AGENT_URL, CODER_AGENT_TOKEN and keepAwake.appSlug)
//   server      DOCK extends the deadline itself, nothing to do here (keepAwakeServerSide)
// Resolves "sent" | "throttled" | "off" | "not-configured" | "failed".
const keepAwakeState = { last: 0, failLoggedAt: 0 };
const keepAwakeServerSide = async () => "not-configured";
async function keepAwake(state, cfg = {}, { force = false, env = process.env, fetchImpl = fetch, now = Date.now, memo = keepAwakeState } = {}) {
	const ka = cfg.keepAwake || { mechanism: "off" };
	if (ka.mechanism === "off") return "off";
	if (ka.mechanism === "server") return keepAwakeServerSide();
	if (!env.CODER_AGENT_URL || !env.CODER_AGENT_TOKEN || !ka.appSlug) return "not-configured";
	if (state === "working" && !force && now() - memo.last < KEEP_AWAKE_EVERY_MS) return "throttled";
	memo.last = now();
	try {
		const res = await fetchImpl(`${env.CODER_AGENT_URL.replace(/\/+$/, "")}/api/v2/workspaceagents/me/app-status`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "Coder-Session-Token": env.CODER_AGENT_TOKEN },
			body: JSON.stringify({ app_slug: ka.appSlug, state, message: "DOCK chat turn", uri: "" }),
			signal: AbortSignal.timeout(10000),
		});
		if (res.ok) return "sent";
		throw new Error(`Coder answered ${res.status}`);
	} catch (e) {
		if (now() - memo.failLoggedAt > 60 * 60 * 1000) { memo.failLoggedAt = now(); log(`keep-awake failed: ${e.message}`); }
		return "failed";
	}
}

// spawn with shell:false cannot start a .cmd shim, and shell:true would run the user's text through cmd.exe.
// So find what the shim launches: a real .exe is spawned directly, a node script through process.execPath.
function resolveClaude(bin) {
	if (/\.(c|m)?js$/i.test(bin)) return { cmd: process.execPath, prefix: [path.resolve(bin)] };
	if (/[\\/]/.test(bin) && fs.existsSync(bin) && !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, prefix: [] };
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
	for (const dir of dirs) for (const n of names) {
		const full = path.join(dir, n);
		if (!fs.existsSync(full)) continue;
		if (!/\.cmd$/i.test(full)) return { cmd: full, prefix: [] };
		const shim = fs.readFileSync(full, "utf8");
		const target = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(shim) || /"%~dp0\\([^"]+\.(?:c|m)?js)"/i.exec(shim);
		if (target) return { cmd: process.execPath, prefix: [path.join(dir, target[1])] };
		const exe = /"%dp0%\\([^"]+\.exe)"/i.exec(shim) || /"%~dp0\\([^"]+\.exe)"/i.exec(shim);
		if (exe) return { cmd: path.join(dir, exe[1]), prefix: [] };
	}
	return null;
}

function rememberSession(id) {
	try {
		let ids = []; try { ids = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch {}
		if (!ids.includes(id)) { ids.push(id); fs.writeFileSync(SESSIONS_FILE, JSON.stringify(ids)); }
	} catch (e) { log(`could not record session id: ${e.message}`); }
}

// claude puts each tool shell in its own process group, so a group kill misses them: walk the children from `ps` instead.
// A tracked child also keeps the descendants seen while it was alive: once the parent is gone nothing links them to it any more.
const liveChildren = new Set();
const seenBelow = new Map();
let cleanupOn = false;

function snapshotTree(child, { platform = process.platform, run = spawnSync } = {}) {
	const seen = seenBelow.get(child);
	if (!seen || !child || !child.pid) return;
	for (const pid of procLib.descendants(child.pid, procLib.processTable({ platform, run }))) seen.add(pid);
}

function killPid(pid, { platform = process.platform, run = spawnSync, kill = (p, sig) => process.kill(p, sig) } = {}) {
	try {
		if (platform === "win32") run("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		else kill(pid, "SIGKILL");
	} catch {}
}

function killTree(child, { platform = process.platform, run = spawnSync, kill = (p, sig) => process.kill(p, sig) } = {}) {
	const below = seenBelow.get(child);
	try {
		if (below) snapshotTree(child, { platform, run });
		if (platform === "win32") run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		else {
			const found = procLib.descendants(child.pid, String(run("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout || ""));
			child.kill("SIGKILL");
			for (const pid of found) { try { kill(pid, "SIGKILL"); } catch {} }
		}
	} catch {}
	if (below) for (const pid of below) killPid(pid, { platform, run, kill });
}

function reap(child) {
	const below = seenBelow.get(child);
	if (below) for (const pid of below) killPid(pid);
}

function killAllSync() {
	for (const child of [...liveChildren]) killTree(child);
}

function track(child) {
	liveChildren.add(child);
	seenBelow.set(child, new Set());
	if (!cleanupOn) {
		cleanupOn = true;
		process.on("exit", killAllSync);
		process.on("uncaughtException", (e) => { log(`bridge crashed: ${e && e.message}`); killAllSync(); process.exit(1); });
	}
	return () => { liveChildren.delete(child); seenBelow.delete(child); };
}

let authLogged = false;
// 401 is logged once; the caller keeps trying slowly.
async function call(route, body, timeoutMs, signal) {
	const r = await send(route, body, timeoutMs, signal);
	if (r.status === 401) { if (!authLogged) { authLogged = true; log("DOCK rejected the token (401); still trying, slowly"); } }
	else authLogged = false;
	return r;
}

// Sends one delta, retrying network failures and 5xx 5 times with backoff. Returns false when it gave up.
async function sendDelta(body, retryBaseMs, attempts = 6) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const r = await call("/chat/delta", body, 15000);
			if (r.skipped) return true;
			if (r.status < 500 && r.status !== 401) {
				if (r.status >= 400) log(`delta refused: ${r.status}${r.error ? " " + r.error : ""}`);
				return true;
			}
			log(`delta failed: ${r.status}`);
		} catch (e) { log(`delta failed: ${e.message}`); }
		if (attempt < attempts - 1) await sleep(Math.min(retryBaseMs * 2 ** attempt, MAX_BACKOFF_MS));
	}
	return false;
}

// ---------- activity: best effort, never allowed to touch the turn ----------
const activityMemo = { silencedUntil: 0, labels: null, helpFlags: new Map() };
const bridgeMemo = { legacyUntil: 0, interrupt: null, catalog: null, catalogAt: 0, catalogRun: null, terminal: TERMINAL_COMMANDS, claudeVersion: "", caps: null, guard: null, waitAt: 0 };

function activityLabels(opts) {
	const dir = opts.activity.labelsDir || __dirname;
	if (!activityMemo.labels || activityMemo.labels.dir !== dir) activityMemo.labels = activityLib.loadLabels(dir, (m) => log(`activity labels: ${m}`));
	else activityMemo.labels.refresh();
	return activityMemo.labels;
}

// Which of the two stream flags this claude lists in --help; asked once per process, and a claude that does not answer in time gets neither.
function supportedFlags(claude, opts) {
	const key = [claude.cmd, ...claude.prefix].join(" ");
	if (!activityMemo.helpFlags.has(key)) {
		activityMemo.helpFlags.set(key, new Promise((resolve) => {
			let text = "";
			const done = () => resolve({ hooks: text.includes("--include-hook-events"), subagentText: text.includes("--forward-subagent-text"), inputFormat: text.includes("--input-format"), permissionPrompts: text.includes("--permission-prompts") });
			try {
				const child = spawn(claude.cmd, [...claude.prefix, "--help"], { cwd: opts.cwd, env: childEnv(opts), shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
				const timer = setTimeout(() => { killTree(child); done(); }, HELP_TIMEOUT_MS);
				child.stdout.on("data", (c) => { if (text.length < 400000) text += c; });
				child.on("error", () => { clearTimeout(timer); done(); });
				child.on("close", () => { clearTimeout(timer); done(); });
			} catch { done(); }
		}));
	}
	return activityMemo.helpFlags.get(key);
}

// Feeds the stream into the tracker and posts what changed to /chat/activity on its own chain, once a second.
// A failure is swallowed (logged once per turn); a 404 without "Unknown ticket" means an older DOCK and silences activity for 10 minutes.
function startActivity(msg, mask, opts) {
	const tracker = activityLib.createTracker({ mask, labels: activityLabels(opts), hooks: opts.activity.hooks });
	const st = { chain: Promise.resolve(), timer: null, last: 0, closed: false, done: false, abandoned: false, failures: 0, pausedUntil: 0, logged: false };
	const warn = (m) => { if (!st.logged) { st.logged = true; log(`activity: ${m}`); } };
	const post = async (events) => {
		const body = { v: 1, sessionId: msg.sessionId, replyTo: msg.id, events };
		for (let attempt = 0; attempt < 2 && !st.abandoned; attempt++) {
			try {
				const r = await call("/chat/activity", body, ACTIVITY_TIMEOUT_MS);
				if (r.skipped) return "ok";
				if (r.status === 404) return r.error && /Unknown ticket/i.test(r.error) ? "gone" : "old";
				if (r.status >= 200 && r.status < 300) return r.result && r.result.closed ? "closed" : "ok";
				if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) { warn(`refused: ${r.status}${r.error ? " " + r.error : ""}`); return "refused"; }
				warn(`answered ${r.status}`);
			} catch (e) { warn(e.message); }
		}
		return "failed";
	};
	const step = async (final) => {
		if (st.closed || st.abandoned || Date.now() < activityMemo.silencedUntil) return;
		if (!final && Date.now() < st.pausedUntil) return;
		const events = tracker.drain(50, 100 * 1024);
		if (!events.length) return;
		st.last = Date.now();
		const res = await post(events);
		if (res === "ok") st.failures = 0;
		else if (res === "closed" || res === "gone") st.closed = true;
		else if (res === "old") { st.closed = true; activityMemo.silencedUntil = Date.now() + ACTIVITY_SILENCE_MS; log("activity: DOCK has no /chat/activity route (older server); activity is off for 10 minutes"); }
		else if (res === "failed") { tracker.requeue(events); if (++st.failures >= 3) { st.failures = 0; st.pausedUntil = Date.now() + ACTIVITY_PAUSE_MS; } }
	};
	const schedule = () => {
		if (st.timer || st.closed || st.done) return;
		st.timer = setTimeout(() => {
			st.timer = null;
			st.chain = st.chain.then(() => step(false)).catch(() => {}).then(() => { if (tracker.stats().pending) schedule(); });
		}, Math.max(0, st.last + ACTIVITY_INTERVAL_MS - Date.now()));
	};
	return {
		feed(o) { try { tracker.feed(o); if (tracker.stats().pending) schedule(); } catch {} },
		// Closes every running row as stopped and sends what is left, waiting at most ACTIVITY_FINAL_WAIT_MS; anything slower is abandoned.
		async settle(wait = ACTIVITY_FINAL_WAIT_MS) {
			st.done = true;
			if (st.timer) { clearTimeout(st.timer); st.timer = null; }
			tracker.closeAll("stopped");
			st.chain = st.chain.then(async () => { for (let i = 0; i < 10 && tracker.stats().pending && !st.closed; i++) await step(true); }).catch(() => {});
			let t;
			await Promise.race([st.chain, new Promise((r) => { t = setTimeout(r, wait); })]);
			clearTimeout(t);
			st.abandoned = true;
		},
	};
}

// The 5 hour and 7 day windows of a rate_limit_event, in the shape of the status line snapshot DOCK accepts on /chat/status.
// A headless turn has no status line, so this is the only way DOCK learns the usage of a chat turn.
function limitsOf(event) {
	const windows = (event.rate_limit_info || {}).unifiedWindows || {};
	const limit = (w) => (w && typeof w.utilization === "number" ? { usedPercentage: w.utilization * 100, resetsAt: w.resetsAt } : undefined);
	return { fiveHour: limit(windows.five_hour), sevenDay: limit(windows.seven_day) };
}

function turnCore(msg, cfg, opts, onAbort) {
	const mask = (s) => maskString(String(s), { masked: 0, blobs: 0 }, cfg.extra);
	const out = (text) => cut(mask(text));
	const state = { claudeSessionId: interact.uuidOf(msg.claudeSessionId), pending: [], detail: null, lastSent: 0, aborted: false };
	let chain = Promise.resolve();
	let timer = null, child, result = null, act = null;

	const post = (extra, attempts) => {
		const items = state.pending; state.pending = [];
		const body = { sessionId: msg.sessionId, replyTo: msg.id, items, ...extra };
		if (state.claudeSessionId) body.claudeSessionId = state.claudeSessionId;
		if (state.detail) body.detail = state.detail;
		state.lastSent = Date.now();
		chain = chain.then(async () => {
			if (state.aborted) return;
			if (!(await sendDelta(body, opts.retryBaseMs, attempts))) { state.aborted = true; log(`dropping turn for message ${msg.id}: DOCK unreachable`); onAbort(child); }
		});
		return chain;
	};
	const schedule = () => {
		if (timer || state.aborted) return;
		const wait = Math.max(0, state.lastSent + DELTA_INTERVAL_MS - Date.now());
		timer = setTimeout(() => { timer = null; if (state.pending.length || state.detail) post({ done: false, error: null }); }, wait);
	};
	const learn = (id) => {
		if (typeof id !== "string" || !id || id === state.claudeSessionId) return;
		state.claudeSessionId = id;
		rememberSession(id);
	};
	const onEvent = (o) => {
		if (o.type === "system" && o.subtype === "init") learn(o.session_id);
		else if (o.type === "rate_limit_event") {
			const limits = limitsOf(o);
			if (limits.fiveHour || limits.sevenDay) call("/chat/status", { sessionId: msg.sessionId, ...limits }, 5000).catch(() => {});
		}
		else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
			learn(o.session_id);
			const at = new Date().toISOString();
			for (const b of o.message.content) {
				if (!b) continue;
				if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !(act && o.parent_tool_use_id)) state.pending.push({ role: "assistant", text: out(b.text), at });
				else if (b.type === "tool_use") { state.pending.push({ role: "tool", text: out(toolLine(b.name, b.input)), at }); state.detail = mask(String(b.name)); }
			}
			schedule();
		} else if (o.type === "result") { learn(o.session_id); result = o; }
	};
	return {
		mask, out, state, post, schedule, onEvent,
		result: () => result,
		chain: () => chain,
		setChild(c) { child = c; },
		setActivity(a) { act = a; },
		stopTimer() { if (timer) { clearTimeout(timer); timer = null; } },
	};
}

const guardCheck = (cwd) => (command) => {
	if (!bridgeMemo.guard) bridgeMemo.guard = guardLib.createGuard({ env: { ...process.env, DOCK_CHAT_TURN: "1" } });
	return bridgeMemo.guard.check(command, cwd);
};

function adoptCatalog(response, initEvent, extra = []) {
	try {
		if (initEvent && Array.isArray(initEvent.terminal_slash_commands)) bridgeMemo.terminal = initEvent.terminal_slash_commands.map(String);
		const before = bridgeMemo.catalog;
		const raw = before ? { ...response, fast_mode_state: before.fast.available ? "on" : "off", fast_mode_disabled_reason: before.fast.reason } : response;
		bridgeMemo.catalog = catalogLib.compactCatalog(raw, bridgeMemo.terminal, { extra });
		bridgeMemo.catalogAt = Date.now();
		if (typeof response.claude_code_version === "string") bridgeMemo.claudeVersion = response.claude_code_version.slice(0, 40);
	} catch (e) { log(`catalogue not updated: ${e.message}`); }
}

async function ensureCatalog(claude, opts, flags) {
	if (!claude || !opts.interactive || !flags.inputFormat || !flags.permissionPrompts) return;
	if (bridgeMemo.catalogRun) return bridgeMemo.catalogRun;
	if (Date.now() - bridgeMemo.catalogAt < CATALOG_EVERY_MS) return;
	bridgeMemo.catalogRun = (async () => {
		try {
			const env = childEnv(opts);
			const base = await catalogLib.probeCatalog(claude, { cwd: opts.cwd }, { env });
			if (!base) { bridgeMemo.catalogAt = Date.now() - CATALOG_EVERY_MS + CATALOG_RETRY_MS; log("catalogue probe got no answer; trying again later"); return; }
			const fast = await catalogLib.probeCatalog(claude, { cwd: opts.cwd, fast: true }, { env });
			bridgeMemo.catalog = null;
			adoptCatalog(fast ? { ...base, fast_mode_state: fast.fast_mode_state, fast_mode_disabled_reason: fast.fast_mode_disabled_reason } : base, null, config() ? config().extra : []);
		} catch (e) { log(`catalogue probe failed: ${e.message}`); }
		finally { bridgeMemo.catalogRun = null; }
	})();
	return bridgeMemo.catalogRun;
}

function legacyOnly(opts) { return !opts.interactive || Date.now() < bridgeMemo.legacyUntil; }

function buildCaps(opts, flags) {
	const cat = bridgeMemo.catalog;
	const features = [];
	if (flags && !legacyOnly(opts) && flags.inputFormat && flags.permissionPrompts) {
		features.push("interactive", "questions", "plan");
		if (bridgeMemo.interrupt !== false) features.push("stop");
		features.push("attachments");
		if (cat && cat.commands.length) features.push("commands");
		if (cat && cat.models.length) features.push("model", "effort");
		if (cat && cat.fast.available) features.push("fast");
	}
	return { v: 2, kit: KIT_ID, claude: bridgeMemo.claudeVersion, features, modes: features.length ? [...interact.MODES] : [], catalogHash: cat ? cat.hash : null };
}

async function precheckWait(msg, caps, gapMs) {
	let r;
	const early = bridgeMemo.waitAt + gapMs - Date.now();
	if (early > 0) await sleep(early);
	bridgeMemo.waitAt = Date.now();
	try { r = await call("/chat/wait", { sessionId: msg.sessionId, replyTo: msg.id, wait: 0, ack: [], caps }, 10000); } catch (e) { log(`wait check failed: ${e.message}`); return "legacy"; }
	if (r.skipped) return "go";
	if (r.status === 404) {
		if (!(r.error && /Unknown ticket/i.test(r.error))) return "old";
		return "go";
	}
	if (r.status < 200 || r.status >= 300) { log(`wait check answered ${r.status}; this turn runs the one-shot way`); return "legacy"; }
	const res = r.result && typeof r.result === "object" ? r.result : {};
	if (res.closed === true) return "closed";
	if (res.stop === true) return "stop";
	return "go";
}

// A turn without rtk or caveman is refused: the answer in DOCK says what is missing on this machine. DOCK_CHAT_PREFLIGHT=off is for the tests.
async function runTurn(msg, cfg, opts) {
	const missing = process.env.DOCK_CHAT_PREFLIGHT === "off" ? [] : preflight.problems(childEnv(opts));
	if (missing.length) {
		const core = turnCore(msg, cfg, opts, () => {});
		log(`turn refused: ${missing.join("; ")}`);
		await core.post({ done: false, error: core.out(`This machine is not ready for a chat turn: ${missing.join("; ")}`) });
		return;
	}
	const claude = resolveClaude(opts.claudeBin);
	if (claude && !legacyOnly(opts)) {
		const flags = await supportedFlags(claude, opts);
		if (flags.inputFormat && flags.permissionPrompts) {
			const caps = bridgeMemo.caps || buildCaps(opts, flags);
			const verdict = await precheckWait(msg, caps, opts.timing.waitGapMs);
			if (verdict === "old") {
				bridgeMemo.legacyUntil = Date.now() + OLD_SERVER_MS;
				log("DOCK has no /chat/wait route (older server); one-shot turns for 10 minutes");
			} else if (verdict === "legacy") log("DOCK could not be checked for phone requests; this turn runs the one-shot way");
				else if (verdict === "closed") return;
			else if (verdict === "stop") {
				await sendDelta({ sessionId: msg.sessionId, replyTo: msg.id, items: [], done: true, error: null, stopped: true }, opts.retryBaseMs);
				return;
			} else return runInteractive(msg, cfg, opts, claude, flags);
		}
	}
	return runLegacy(msg, cfg, opts, claude);
}

async function runInteractive(msg, cfg, opts, claude, flags) {
	const core = turnCore(msg, cfg, opts, (c) => killTree(c));
	const act = opts.activity.enabled && Date.now() >= activityMemo.silencedUntil ? startActivity(msg, core.mask, opts) : null;
	core.setActivity(act);
	const store = interact.createAllowStore(ALLOW_FILE, { log });
	const { fit } = activityLib.createSafe(core.mask);
	try {
		await session.runInteractiveTurn(msg, cfg, opts, {
			claude, act, core, log, flags, fit, store, childEnv, killTree, keepAwake, call, track, reap, kitDir: __dirname, snapshot: (child) => snapshotTree(child), lastWait: () => bridgeMemo.waitAt, markWait: (at) => { bridgeMemo.waitAt = at; },
			labels: activityLabels(opts),
			stateDir: STATE_DIR,
			caps: () => bridgeMemo.caps || buildCaps(opts, flags),
			catalog: () => bridgeMemo.catalog,
			guardCheck: guardCheck(opts.cwd),
			markOld: () => { if (Date.now() >= bridgeMemo.legacyUntil) log("DOCK has no /chat/wait route (older server); one-shot turns for 10 minutes"); bridgeMemo.legacyUntil = Date.now() + OLD_SERVER_MS; },
			noteInit: (o) => {
				const advertised = Array.isArray(o.capabilities) ? o.capabilities : [];
				const has = advertised.includes("interrupt_receipt_v1");
				if (!has && bridgeMemo.interrupt !== false) log("claude does not advertise interrupt_receipt_v1; stop is not offered from now on");
				bridgeMemo.interrupt = has;
			},
			adoptCatalog: (response, initEvent) => adoptCatalog(response, initEvent, cfg.extra),
		});
	} finally {
		try { pruneFiles(STATE_DIR, Date.now()); } catch {}
	}
}

async function runLegacy(msg, cfg, opts, claude) {
	let child;
	const core = turnCore(msg, cfg, opts, (c) => killTree(c));
	const { mask, out, state } = core;

	if (!claude) {
		const error = out(`Claude Code was not found on this machine (claudeBin: ${opts.claudeBin})`);
		await core.post({ done: false, error });
		return;
	}
	const act = opts.activity.enabled && Date.now() >= activityMemo.silencedUntil ? startActivity(msg, mask, opts) : null;
	core.setActivity(act);
	const args = [...claude.prefix, "-p", msg.text.startsWith("-") ? " " + msg.text : msg.text, "--output-format", "stream-json", "--verbose"];
	if (act) {
		const flags = await supportedFlags(claude, opts);
		if (flags.hooks && opts.activity.hooks && !opts.extraArgs.includes("--include-hook-events")) args.push("--include-hook-events");
		if (flags.subagentText && opts.activity.subagentText && !opts.extraArgs.includes("--forward-subagent-text")) args.push("--forward-subagent-text");
	}
	const resumeId = interact.uuidOf(msg.claudeSessionId), forkId = interact.uuidOf(msg.forkFrom);
	if ((msg.claudeSessionId && !resumeId) || (msg.forkFrom && !forkId)) log("a session id from DOCK is not a UUID; it was dropped");
	if (resumeId) args.push("--resume", resumeId);
	else if (forkId) args.push("--resume", forkId, "--fork-session");
	if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
	if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
	if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
	args.push(...opts.extraArgs);

	const env = childEnv(opts);
	let stderrTail = "", timedOut = false, spawnError = null;
	child = spawn(claude.cmd, args, { cwd: opts.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	core.setChild(child);
	const untrack = track(child);
	child.on("error", (e) => { spawnError = e; });
	child.stderr.on("data", (c) => { stderrTail = (stderrTail + c).slice(-2000); });
	// Bridge shutdown mid-turn: stop claude, close the open rows with one last best-effort post, then go.
	const onSignal = (sig) => { killTree(child); (act ? act.settle(2000) : Promise.resolve()).then(() => process.exit(sig === "SIGINT" ? 130 : 143)); };
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	const killer = setTimeout(() => { timedOut = true; killTree(child); }, opts.turnTimeoutMs);
	void keepAwake("working", opts);
	const awake = setInterval(() => { void keepAwake("working", opts, { force: true }); }, KEEP_AWAKE_EVERY_MS);
	awake.unref();

	let exited = false, oversizeLogged = false;
	const closed = new Promise((resolve) => {
		child.once("exit", (code) => { exited = true; resolve(code); });
		child.once("error", () => { if (child.pid === undefined && !exited) { exited = true; resolve(null); } });
	});
	const splitter = procLib.createLineSplitter((line) => {
		let o; try { o = JSON.parse(line); } catch { return; }
		if (!o || typeof o !== "object") return;
		if (act) act.feed(o);
		core.onEvent(o);
		if (o.type === "result") snapshotTree(child);
	}, { onDrop: () => { if (!oversizeLogged) { oversizeLogged = true; log("claude wrote a line over 32 MB; it was skipped"); } } });
	const drained = new Promise((resolve) => {
		child.stdout.on("data", (c) => splitter.write(c));
		child.stdout.on("end", () => splitter.end());
		child.stdout.on("error", () => {});
		child.stdout.once("close", resolve);
	});

	const code = await closed;
	clearTimeout(killer);
	clearInterval(awake);
	void keepAwake("idle", opts);
	await within(opts.timing.drainMs, drained);
	try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
	splitter.end();
	reap(child);
	untrack();
	core.stopTimer();

	const result = core.result();
	let error = null;
	if (timedOut) error = `The turn ran longer than ${opts.turnTimeoutMs >= 60000 ? Math.round(opts.turnTimeoutMs / 60000) + " minutes" : Math.round(opts.turnTimeoutMs / 1000) + " seconds"} and was stopped`;
	else if (spawnError) error = `Could not start Claude Code: ${spawnError.message}`;
	else if (result && result.is_error) error = String(result.result || result.subtype || "Claude Code reported an error");
	else if (code !== 0) error = `Claude Code exited with code ${code}${stderrTail.trim() ? ": " + stderrTail.trim().split("\n").at(-1) : ""}`;
	state.detail = null;
	const pace = sleep(Math.max(0, state.lastSent + DELTA_INTERVAL_MS - Date.now()));
	process.removeListener("SIGINT", onSignal);
	process.removeListener("SIGTERM", onSignal);
	if (act) await Promise.all([pace, act.settle()]);
	else await pace;
	await core.post(error ? { done: false, error: mask(error).slice(0, 300) } : { done: true, error: null });
	await core.chain();
}

async function claimOne(wait, caps) {
	const body = { wait };
	if (caps && Array.isArray(caps.features) && caps.features.length) body.caps = caps;
	const r = await call("/chat/claim", body, (wait + 10) * 1000);
	// DOCK wraps every ingest answer as { ok, result }.
	return { ...r, message: r.result ? r.result.message : r.message, wantCatalog: Boolean(r.result && r.result.wantCatalog) };
}

async function main(cmd, args) {
	if (cmd === "check") {
		const cfg = config(), s = settings(), c = resolveClaude(s.claudeBin);
		console.log(cfg ? `url: ${cfg.url}\ntoken: set` : "dock: not configured (set DOCK_INGEST_URL and DOCK_INGEST_TOKEN, or write dock.json)");
		console.log(`claude: ${c ? [c.cmd, ...c.prefix].join(" ") : "NOT FOUND (" + s.claudeBin + ")"}\ncwd: ${s.cwd}\nconfigDir: ${s.configDir || "(unset: Claude Code default)"}\nkeepAwake: ${s.keepAwake.mechanism}${s.keepAwake.mechanism === "server" ? " (not configured: DOCK-side keep-awake has no client part)" : ""}\npermissionMode: ${s.permissionMode || "(user settings)"}\nmaxTurns: ${s.maxTurns || "(none)"}\nextraArgs: ${s.extraArgs.join(" ") || "(none)"}`);
		let flags = null;
		if (c && s.interactive) { flags = await supportedFlags(c, s); await ensureCatalog(c, s, flags); }
		const caps = buildCaps(s, flags), cat = bridgeMemo.catalog;
		console.log(`interactive: ${s.interactive ? "on" : "off"}${flags && !(flags.inputFormat && flags.permissionPrompts) ? " (this claude lacks --input-format or --permission-prompts)" : ""}\nfeatures: ${caps.features.join(", ") || "(none)"}\nmodes: ${caps.modes.join(", ") || "(none)"}\ncatalogue: ${cat ? `${cat.commands.length} commands, ${cat.models.length} models, fast ${cat.fast.available ? "on" : "off"}` : "(none)"}\naskTtlSeconds: ${s.askTtlSeconds}`);
		return;
	}
	if (cmd === "label") {
		const info = activityLib.commandInfo(args.join(" "), activityLabels(settings()));
		console.log(info.label || "Bash");
		if (info.hide) console.log("output: hidden (sensitive command)");
		if (!info.label) console.log("no rule matched");
		return;
	}
	if (cmd !== "run" && cmd !== "once") return console.log('usage: dock-chat.cjs run | once [--wait seconds] | check | label "<command>"');
	const cfg = config();
	if (!cfg) return console.log("dock chat: DOCK not configured, nothing to do");
	const opts = settings();
	const w = args.indexOf("--wait");
	const wait = cmd === "once" ? Math.min(CLAIM_WAIT_S, w >= 0 ? Number(args[w + 1]) || 0 : 5) : CLAIM_WAIT_S;
	let backoff = 0, paceUntil = 0;
	log(`bridge ${cmd}: ${cfg.url}`);
	try { pruneFiles(STATE_DIR, Date.now()); interact.createAllowStore(ALLOW_FILE, { log }).prune(); } catch {}
	for (;;) {
		try {
			const claude = resolveClaude(opts.claudeBin);
			const flags = claude && opts.interactive ? await supportedFlags(claude, opts) : null;
			if (flags) await ensureCatalog(claude, opts, flags);
			bridgeMemo.caps = buildCaps(opts, flags);
			if (paceUntil > Date.now()) await sleep(paceUntil - Date.now());
			const began = Date.now();
			const r = await claimOne(wait, bridgeMemo.caps);
			paceUntil = cmd !== "once" && r.status === 200 && !(r.message && r.message.id != null) ? began + opts.timing.waitGapMs : 0;
			if (r.status === 401) { if (cmd === "once") return; await sleep(MAX_BACKOFF_MS); continue; }
			if (r.status !== 200) throw new Error(`claim answered ${r.status}`);
			backoff = 0;
			if (r.wantCatalog && bridgeMemo.catalog) await catalogLib.publishCatalog(bridgeMemo.catalog, call);
			if (r.message && r.message.id != null) {
				log(`message ${safeId(r.message.id)} for session ${safeId(r.message.sessionId)}`);
				await runTurn(r.message, config() || cfg, opts);
				log(`message ${safeId(r.message.id)} finished`);
			}
			if (cmd === "once") return;
		} catch (e) {
			log(`bridge error: ${e.message}`);
			if (cmd === "once") return;
			backoff = Math.min(backoff ? backoff * 2 : 1000, MAX_BACKOFF_MS);
			await sleep(backoff);
		}
	}
}

module.exports = { resolveClaude, killTree, childEnv, limitsOf, settings, keepAwake, track, snapshotTree, reap, killAllSync };

if (require.main === module) {
	const [cmd, ...args] = process.argv.slice(2);
	process.on("unhandledRejection", (e) => log(`unhandled: ${e && e.message}`));
	main(cmd, args).catch((e) => log(`bridge stopped: ${e.message}`));
}
