// Laptop bridge for DOCK chat: claims queued browser messages, runs them through Claude Code, streams the answer back.
//   node dock-chat.cjs run      loop forever: claim -> start a turn (up to parallelTurns at once) -> deltas -> next
//   node dock-chat.cjs once     handle at most one message and exit  [--wait seconds, default 5]
//   node dock-chat.cjs check    show the configuration (never the token)
//   node dock-chat.cjs label "<command>"   print the activity label a Bash command gets (rules: activity-labels.json)
// Config: dock-chat.json next to this file, all optional:
//   { "cwd": "E:/qonflo", "configDir": "C:/Users/danus/.claude-kantor", "permissionMode": null, "maxTurns": null, "extraArgs": [],
//     "parallelTurns": 3,   how many chat turns run at once (min 1); maxTurns is claude's own --max-turns, not this
//     "claudeBin": "claude", "turnTimeoutMs": 1800000, "retryBaseMs": 1000,
//     "interactive": true, "askTtlSeconds": 600,   interactive: false keeps every turn on the one-shot path; askTtlSeconds is how long a phone prompt waits (30..1800)
//     "keepAwake": { "mechanism": "off | app-status | server", "appSlug": null },
//     "activity": { "enabled": true, "hooks": true, "subagentText": true } }   "activity": false (or enabled: false) switches the activity feed off
// Defaults come from paths.cjs. On Linux configDir is unset, so Claude Code keeps its own ~/.claude.
// The DOCK url and token come from dock-push.cjs (dock.json or env).
// `run` also pushes doctor.cjs on start, every 6 hours, and when DOCK's Health page asks (wantDoctor on a claim).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFile } = require("child_process");
const { maskString, config, send, sendFile, toolLine, cut, pushLedgersChangedSince } = require("./dock-push.cjs");
const activityLib = require("./activity.cjs");
const interact = require("./dock-chat-interact.cjs");
const session = require("./dock-chat-session.cjs");
const catalogLib = require("./dock-chat-catalog.cjs");
const { pruneFiles, resolveAttach, ATTACH_BYTES } = require("./dock-chat-files.cjs");
const guardLib = require("./guard.cjs");
const procLib = require("./dock-chat-proc.cjs");
const preflight = require("./dock-chat-preflight.cjs");
const outbox = require("./dock-chat-outbox.cjs");
const agentsLib = require("./agents.cjs");
const PATHS = require("./paths.cjs").resolvePaths();

const STATE_DIR = process.env.DOCK_KIT_STATE_DIR || __dirname;
const SESSIONS_FILE = path.join(STATE_DIR, "dock-chat-sessions.json");
const ALLOW_FILE = path.join(STATE_DIR, "dock-chat-allow.json");
const KIT_ID = "dock-kit-2";
const OLD_SERVER_MS = 10 * 60 * 1000;
const CATALOG_EVERY_MS = 6 * 60 * 60 * 1000;
const CATALOG_RETRY_MS = 10 * 60 * 1000;
const DOCTOR_EVERY_MS = 6 * 60 * 60 * 1000;
const DOCTOR_TIMEOUT_MS = 2 * 60 * 1000;
const TERMINAL_COMMANDS = ["doctor", "color", "focus", "reload-plugins"];
const DELTA_INTERVAL_MS = 1000;
const CLAIM_WAIT_S = 25;
const MAX_BACKOFF_MS = 30000;
const KEEP_AWAKE_EVERY_MS = 10 * 60 * 1000;
const BRIDGE_SECRET = /^(DOCK_INGEST_TOKEN|DOCK_MASK_EXTRA|BRAIN_TOKEN|CODER_AGENT_TOKEN|CODER_SESSION_TOKEN|(DOCK|BRAIN|CODER)_[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|KEY|PIN))$/;
const PROXY_VARS = /^(https?_proxy|all_proxy|node_use_env_proxy|dock_proxy)$/i;
const UPLOAD_TIMEOUT_MS = 30000;
const MAX_UPLOADS_PER_TURN = 20;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ATTACH_LINE = /^[ \t]*DOCK_ATTACH:[ \t]*(.+?)[ \t]*\r?$/gm;
const ACTIVITY_INTERVAL_MS = DELTA_INTERVAL_MS;
const ACTIVITY_TIMEOUT_MS = 5000;
const ACTIVITY_FINAL_WAIT_MS = 1000;
const ACTIVITY_SILENCE_MS = 10 * 60 * 1000;
const ACTIVITY_PAUSE_MS = 60 * 1000;
const HELP_TIMEOUT_MS = 5000;
// Thinking text never reaches the stream, so the skill choice is made visible by having Claude write it in the reply DOCK shows.
const SKILL_LINE_PROMPT = "This turn runs from DOCK chat, where the person follows your steps on a phone and cannot see your thinking. Before your first tool call of each task, write one plain line in your reply: Skills: <2-4 keywords from the task> / candidates: <matching skills from the available-skills list, or none> / using: <the skill you invoke, or none>. Then work as usual. A DOCK session works on one ticket only: when asked about another ticket, say it belongs in its own DOCK session instead of starting it here. To send a file to the owner, write a line DOCK_ATTACH: <absolute path> in your reply (a file inside the working folder, up to 10 MB); screenshots from your tools are shown automatically.";

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
		interruptGraceMs: num(t.interruptGraceMs, 10000), closeGraceMs: num(t.closeGraceMs, 5000), exitGraceMs: num(t.exitGraceMs, 10000), followTurnMs: num(t.followTurnMs, 5000), steerGraceMs: num(t.steerGraceMs, 30000), drainMs: num(t.drainMs, 1500), outageMs: num(t.outageMs, 30 * 60 * 1000),
		doctorEveryMs: num(t.doctorEveryMs, DOCTOR_EVERY_MS),
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
		parallelTurns: Math.max(1, Math.floor(Number(file.parallelTurns)) || 3),
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

// On a Coder workspace git reaches GitHub through `coder gitssh` and the coder askpass, both of which need CODER_AGENT_TOKEN, which a turn never
// gets. Without this a fetch or push in a turn fails or waits on an external-auth URL; with it git uses HTTPS and the gh login instead.
function gitOverGh(env) {
	delete env.GIT_SSH_COMMAND;
	if (/(^|[\\/])coder(\.exe)?$/.test(env.GIT_ASKPASS || "")) delete env.GIT_ASKPASS;
	let n = Number(env.GIT_CONFIG_COUNT) || 0;
	for (const [k, v] of [["url.https://github.com/.insteadOf", "git@github.com:"], ["url.https://github.com/.insteadOf", "ssh://git@github.com/"], ["credential.https://github.com.helper", ""], ["credential.https://github.com.helper", "!gh auth git-credential"]]) {
		env[`GIT_CONFIG_KEY_${n}`] = k;
		env[`GIT_CONFIG_VALUE_${n}`] = v;
		n++;
	}
	env.GIT_CONFIG_COUNT = String(n);
	env.GIT_TERMINAL_PROMPT = "0";
}

// The environment claude runs in. DOCK_CHAT_TURN=1 switches guard.cjs to its unattended profile; CAVEMAN_DEFAULT_MODE switches caveman on,
// which stays off in a headless session without it; CLAUDE_CONFIG_DIR is set only when configDir is; the proxy variables kit-node sets to
// reach DOCK are removed so Anthropic traffic does not go through tailscaled.
function childEnv(opts, base = process.env, platform = process.platform) {
	const env = { ...base, DOCK_CHAT_TURN: "1", CAVEMAN_DEFAULT_MODE: (opts.agent && opts.agent.caveman) || "caveman" };
	if (platform !== "win32" && opts.agent && opts.agent.rtk === false) env.DOCK_RTK = "off";
	else delete env.DOCK_RTK;
	const keep = new Set(Array.isArray(opts.passEnv) ? opts.passEnv : []);
	for (const k of Object.keys(env)) if (BRIDGE_SECRET.test(k) && !keep.has(k)) delete env[k];
	if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
	else delete env.CLAUDE_CONFIG_DIR;
	if (base.NODE_USE_ENV_PROXY === "1" || base.DOCK_PROXY) for (const k of Object.keys(env)) if (PROXY_VARS.test(k)) delete env[k];
	if (/\bcoder gitssh\b/.test(env.GIT_SSH_COMMAND || "") && !env.CODER_AGENT_TOKEN) gitOverGh(env);
	return env;
}

// Keeps the Coder workspace awake while a chat turn runs. This is the only place that knows how; it never throws and never blocks a turn.
//   app-status  reports the agent as "working" through the Coder agent API (needs CODER_AGENT_URL, CODER_AGENT_TOKEN and keepAwake.appSlug)
//   server      DOCK extends the deadline itself, nothing to do here (keepAwakeServerSide)
// Resolves "sent" | "throttled" | "off" | "not-configured" | "failed".
const keepAwakeState = { last: 0, failLoggedAt: 0 };
let activeTurns = 0;
const keepAwakeServerSide = async () => "not-configured";
async function keepAwake(state, cfg = {}, { force = false, env = process.env, fetchImpl = fetch, now = Date.now, memo = keepAwakeState } = {}) {
	const ka = cfg.keepAwake || { mechanism: "off" };
	if (ka.mechanism === "off") return "off";
	if (ka.mechanism === "server") return keepAwakeServerSide();
	if (state === "idle" && activeTurns > 1) return "throttled";
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

// Runs up to `limit` turns at once; slot() resolves when one is free, start() never rejects.
function createTurnPool(limit) {
	const running = new Set();
	return {
		slot: async () => { while (running.size >= limit) await Promise.race(running); },
		start(run, onError) {
			const p = Promise.resolve().then(run).catch(onError).catch(() => {}).finally(() => running.delete(p));
			running.add(p);
			return p;
		},
	};
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
const bridgeMemo = { legacyUntil: 0, interrupt: null, catalog: null, catalogAt: 0, catalogRun: null, uploadOff: false, terminal: TERMINAL_COMMANDS, claudeVersion: "", caps: null, guard: null, waitAt: 0 };

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
			const done = () => resolve({ hooks: text.includes("--include-hook-events"), subagentText: text.includes("--forward-subagent-text"), inputFormat: text.includes("--input-format"), permissionPrompts: text.includes("--permission-prompts"), replayUser: text.includes("--replay-user-messages") });
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

// Sends the files a turn collected. A 404 means an older DOCK without /chat/upload: uploads stay off for the life of this process.
// Resolves the files that could not be delivered because DOCK was unreachable (network error, 5xx, 401); a refused file is dropped.
async function uploadFiles(msg, files) {
	const left = [];
	for (const f of files) {
		if (bridgeMemo.uploadOff) return [];
		try {
			const r = await sendFile("/chat/upload", { sessionId: msg.sessionId, replyTo: msg.id, name: f.name }, f.bytes, f.mime, UPLOAD_TIMEOUT_MS);
			if (r.skipped || r.status === 200) continue;
			if (r.status === 404) { bridgeMemo.uploadOff = true; log("DOCK has no /chat/upload route (older server); files from the agent are skipped"); return []; }
			log(`upload refused: ${r.status}${r.error ? " " + r.error : ""}`);
			if (r.status >= 500 || r.status === 401) left.push(f);
		} catch (e) { log(`upload failed: ${e.message}`); left.push(f); }
	}
	return left;
}

// One delta with its files, delivered the way the main loop resends the outbox: files first when it is the final one.
async function deliverEntry({ msg, body, files }, retryBaseMs) {
	const done = Boolean(body && body.done);
	let left = files;
	if (done) left = await uploadFiles(msg, left);
	if (left.length && done) return false;
	if (body && !(await sendDelta(body, retryBaseMs, 1))) return false;
	if (!done) left = await uploadFiles(msg, left);
	return left.length === 0;
}

function numstatOf(text) {
	const files = [];
	for (const line of String(text).split("\n")) {
		const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		if (m) files.push({ path: m[3], added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
	}
	return files;
}

const EDIT_PATH = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

function touchedPath(block, cwd) {
	const key = EDIT_PATH[block.name];
	const p = key && block.input && block.input[key];
	return typeof p === "string" && p ? path.resolve(cwd, p) : null;
}

const git = (cwd, args) => new Promise((resolve) => execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)));

async function changedFiles(paths) {
	const byRepo = new Map(), tops = new Map();
	for (const file of paths) {
		const dir = path.dirname(file);
		if (!tops.has(dir)) tops.set(dir, await git(dir, ["rev-parse", "--show-toplevel"]));
		const top = tops.get(dir);
		if (top && top.trim()) {
			const repo = path.resolve(top.trim());
			byRepo.set(repo, [...(byRepo.get(repo) || []), file]);
		}
	}
	const files = [];
	for (const [repo, list] of byRepo) {
		const rel = (f) => path.relative(repo, f).split(path.sep).join("/");
		const tracked = new Set(String((await git(repo, ["ls-files", "--", ...list.map(rel)])) || "").split("\n").filter(Boolean));
		const diff = tracked.size ? await git(repo, ["diff", "--numstat", "--no-renames", "HEAD", "--", ...tracked]) : "";
		const found = new Map(numstatOf(diff || "").map((f) => [f.path, f]));
		for (const f of list) {
			const name = rel(f), shown = path.basename(repo) + "/" + name;
			let counted = found.get(name);
			if (!counted && !tracked.has(name)) {
				try { counted = { added: fs.readFileSync(f, "utf8").split("\n").filter((l, i, all) => l || i < all.length - 1).length, removed: 0 }; } catch { counted = null; }
			}
			files.push({ path: shown, added: counted ? counted.added : 0, removed: counted ? counted.removed : 0 });
		}
	}
	return files;
}

const tokensOf = (u) => (u && typeof u === "object" ? [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0) : 0);

// What /chat/status gets after a turn. Context is the last main-thread API call of the turn (input plus both cache counts), because the
// result event's own usage adds up every call of the turn; that sum is the fallback when no assistant event carried usage.
function statusOf(msg, result, state, files) {
	const body = { sessionId: msg.sessionId, files };
	if (state.model) body.model = state.model;
	const defaults = bridgeMemo.catalog && bridgeMemo.catalog.defaults;
	const effort = (msg.options && typeof msg.options.effort === "string" && msg.options.effort) || (defaults && defaults.effort);
	if (effort) body.effort = effort;
	const tokens = tokensOf(state.usage) || tokensOf(result.usage);
	if (tokens > 0) body.contextTokens = tokens;
	const byModel = result.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : {};
	const key = Object.keys(byModel).find((k) => k === state.model) || Object.keys(byModel).find((k) => state.model && (k.includes(state.model) || state.model.includes(k)));
	const size = key && byModel[key] ? byModel[key].contextWindow : undefined;
	if (Number.isFinite(size) && size > 0) {
		body.contextSize = size;
		if (tokens > 0) body.contextPercentage = Math.round((tokens / size) * 1000) / 10;
	}
	if (Number.isFinite(result.total_cost_usd)) {
		body.turnCostUsd = Math.max(0, result.total_cost_usd - state.costSeen);
		state.costSeen = result.total_cost_usd;
	}
	return body;
}

// A turn is never killed because DOCK cannot be reached. Deltas wait in order and are retried; once the turn has ended, the retrying
// lasts timing.outageMs, and what is still undelivered then goes to the outbox, which the main loop resends.
function turnCore(msg, cfg, opts) {
	const mask = (s) => maskString(String(s), { masked: 0, blobs: 0 }, cfg.extra);
	const out = (text) => cut(mask(text));
	const state = { claudeSessionId: interact.uuidOf(msg.claudeSessionId), pending: [], detail: null, lastSent: 0, finalAt: 0, parked: false, model: null, usage: null, uploads: [], seen: new Set(), images: 0, queued: 0, statusLogged: false, costSeen: 0 };
	let chain = Promise.resolve();
	let timer = null, child, result = null, act = null;
	const subs = new Map();

	const park = (job) => {
		state.parked = true;
		try { outbox.add(STATE_DIR, { msg: { sessionId: msg.sessionId, id: msg.id }, ...job }, { log }); log(`DOCK unreachable: the delta for message ${msg.id} was written to the outbox`); }
		catch (e) { log(`outbox write failed for message ${msg.id}: ${e.message}`); }
	};
	const deliver = async (job) => {
		if (state.parked) return park({ body: job.body, files: job.files });
		let left = job.files, sent = false;
		for (;;) {
			if (job.body.done) left = await uploadFiles(msg, left);
			if (!sent && (!job.body.done || !left.length)) sent = await sendDelta(job.body, opts.retryBaseMs, job.once ? 1 : undefined);
			if (sent && !job.body.done) left = await uploadFiles(msg, left);
			if (sent && !left.length) return;
			if (job.once) return log(`delta for message ${msg.id} not delivered`);
			if (state.finalAt && Date.now() - state.finalAt > opts.timing.outageMs) return park({ body: sent ? null : job.body, files: left });
			await sleep(opts.retryBaseMs);
		}
	};
	const post = (extra, attempts) => {
		const items = state.pending; state.pending = [];
		const files = state.uploads; state.uploads = [];
		const body = { sessionId: msg.sessionId, replyTo: msg.id, items, ...extra };
		if (state.claudeSessionId) body.claudeSessionId = state.claudeSessionId;
		if (state.detail) body.detail = state.detail;
		state.lastSent = Date.now();
		if (extra && (extra.done || extra.error)) state.finalAt = Date.now();
		chain = chain.then(() => deliver({ body, files, once: attempts === 1 })).catch((e) => log(`delta handling failed: ${e.message}`));
		return chain;
	};
	const schedule = () => {
		if (timer) return;
		const wait = Math.max(0, state.lastSent + DELTA_INTERVAL_MS - Date.now());
		timer = setTimeout(() => { timer = null; if (state.pending.length || state.detail || state.uploads.length) post({ done: false, error: null }); }, wait);
	};
	const learn = (id) => {
		if (typeof id !== "string" || !id || id === state.claudeSessionId) return;
		state.claudeSessionId = id;
		rememberSession(id);
	};
	const queueUpload = (file) => {
		if (state.queued >= MAX_UPLOADS_PER_TURN) return;
		state.queued++;
		state.uploads.push(file);
	};
	const collectImages = (content) => {
		for (const b of content) {
			if (!b || b.type !== "tool_result" || !Array.isArray(b.content)) continue;
			for (const c of b.content) {
				const src = c && c.type === "image" && c.source;
				const ext = src && src.type === "base64" && typeof src.data === "string" ? IMAGE_EXT[src.media_type] : null;
				if (!ext) continue;
				const bytes = Buffer.from(src.data, "base64");
				const hash = crypto.createHash("sha256").update(bytes).digest("hex");
				if (!bytes.length || bytes.length > ATTACH_BYTES || state.seen.has(hash)) continue;
				state.seen.add(hash);
				queueUpload({ name: `image-${++state.images}.${ext}`, mime: src.media_type, bytes });
			}
		}
		schedule();
	};
	const stripAttach = (text) => {
		const found = [];
		const rest = text.replace(ATTACH_LINE, (_, p) => { found.push(p); return ""; });
		if (!found.length) return text;
		for (const p of found) {
			const r = resolveAttach(p, opts.cwd);
			if (r.error) { log(`DOCK_ATTACH refused: ${r.error}`); continue; }
			try { queueUpload({ name: r.name, mime: r.mime, bytes: fs.readFileSync(r.file) }); } catch (e) { log(`DOCK_ATTACH not read: ${e.message}`); }
		}
		return rest.replace(/\n{3,}/g, "\n\n").trim();
	};
	const touched = new Set();
	const trackSubagents = (o) => {
		const blocks = o.message && Array.isArray(o.message.content) ? o.message.content : [];
		if (o.type === "assistant" && !o.parent_tool_use_id) { for (const b of blocks) if (b && b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && typeof b.id === "string") subs.set(b.id, { input: b.input, running: false }); }
		else if (o.type === "user") {
			for (const b of blocks) {
				const s = b && b.type === "tool_result" ? subs.get(b.tool_use_id) : null;
				if (s) { if (activityLib.isBackgroundLaunch(s.input, b.content, b.is_error)) s.running = true; else subs.delete(b.tool_use_id); }
			}
		} else if (o.type === "system" && o.subtype === "task_notification") subs.delete(o.tool_use_id);
	};
	const onEvent = (o) => {
		trackSubagents(o);
		if (o.type === "system" && o.subtype === "init") { learn(o.session_id); if (typeof o.model === "string" && o.model) state.model = o.model; }
		else if (o.type === "user" && o.message && Array.isArray(o.message.content)) collectImages(o.message.content);
		else if (o.type === "rate_limit_event") {
			const limits = limitsOf(o);
			if (limits.fiveHour || limits.sevenDay) call("/chat/status", { sessionId: msg.sessionId, ...limits }, 5000).catch(() => {});
		}
		else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
			learn(o.session_id);
			if (!o.parent_tool_use_id && o.message.usage) state.usage = o.message.usage;
			const at = new Date().toISOString();
			for (const b of o.message.content) {
				if (!b) continue;
				if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !(act && o.parent_tool_use_id)) {
					const text = stripAttach(b.text);
					if (text.trim()) state.pending.push({ role: "assistant", text: out(text), at });
				}
				else if (b.type === "tool_use") { const edited = touchedPath(b, opts.cwd); if (edited) touched.add(edited); state.pending.push({ role: "tool", text: out(toolLine(b.name, b.input)), at }); state.detail = mask(String(b.name)); }
			}
			schedule();
		} else if (o.type === "result") {
			learn(o.session_id);
			result = o;
			changedFiles([...touched]).then((files) => call("/chat/status", statusOf(msg, o, state, files), 5000)).catch((e) => { if (!state.statusLogged) { state.statusLogged = true; log(`status not sent: ${e.message}`); } });
		}
	};
	return {
		mask, out, state, post, schedule, onEvent,
		result: () => result,
		subagentsRunning: () => [...subs.values()].filter((s) => s.running).length,
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

function adoptCatalog(response, initEvent, extra = [], defaults = null) {
	try {
		if (initEvent && Array.isArray(initEvent.terminal_slash_commands)) bridgeMemo.terminal = initEvent.terminal_slash_commands.map(String);
		const before = bridgeMemo.catalog;
		const raw = before ? { ...response, fast_mode_state: before.fast.available ? "on" : "off", fast_mode_disabled_reason: before.fast.reason } : response;
		bridgeMemo.catalog = catalogLib.compactCatalog(raw, bridgeMemo.terminal, { extra, defaults });
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
			adoptCatalog(fast ? { ...base, fast_mode_state: fast.fast_mode_state, fast_mode_disabled_reason: fast.fast_mode_disabled_reason } : base, null, config() ? config().extra : [], catalogLib.machineDefaults(opts));
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
		if (flags.replayUser) features.push("steer");
	}
	const modes = features.length ? [...interact.MODES] : [];
	features.push("agents");
	return { v: 2, kit: KIT_ID, claude: bridgeMemo.claudeVersion, features, modes, catalogHash: cat ? cat.hash : null };
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
	const missing = process.env.DOCK_CHAT_PREFLIGHT === "off" ? [] : preflight.problems(childEnv({ ...opts, agent: msg.agent }), { agent: msg.agent });
	if (missing.length) {
		const core = turnCore(msg, cfg, opts);
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

let sharedAllow = null;
const allowStore = () => sharedAllow || (sharedAllow = interact.createAllowStore(ALLOW_FILE, { log }));

async function runInteractive(msg, cfg, opts, claude, flags) {
	const core = turnCore(msg, cfg, opts);
	const act = opts.activity.enabled && Date.now() >= activityMemo.silencedUntil ? startActivity(msg, core.mask, opts) : null;
	core.setActivity(act);
	const store = allowStore();
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
			adoptCatalog: (response, initEvent) => adoptCatalog(response, initEvent, cfg.extra, catalogLib.machineDefaults(opts)),
		});
	} finally {
		try { pruneFiles(STATE_DIR, Date.now()); } catch {}
	}
}

async function runLegacy(msg, cfg, opts, claude) {
	let child;
	const core = turnCore(msg, cfg, opts);
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
	const chosen = interact.optionArgs(msg.options, { catalog: bridgeMemo.catalog, log });
	const mode = chosen.mode || opts.permissionMode;
	if (mode) args.push("--permission-mode", mode);
	if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
	args.push(...chosen.args);
	if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
	args.push(...opts.extraArgs);

	const env = childEnv({ ...opts, agent: msg.agent });
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
	const subagentsRunning = !error ? core.subagentsRunning() : 0;
	await core.post(error ? { done: false, error: mask(error).slice(0, 300) } : subagentsRunning > 0 ? { done: true, error: null, subagentsRunning } : { done: true, error: null });
	await core.chain();
}

// The claude process of a turn has no DOCK credentials, so its ledger writes (status.cjs) are pushed from here once the turn is over.
// Fire and forget: bounded by pushLedgersChangedSince, never throws, one log line per turn when something failed.
function pushLedgers(since) {
	pushLedgersChangedSince(since).then((r) => { if (r.error) log(`ledger push after the turn: ${r.error}`); }, (e) => log(`ledger push after the turn: ${e.message}`));
}

// doctor.cjs --push in its own process: its probes block, so they never run inside the bridge. One run at a time.
const doctorMemo = { at: 0, running: false };
function runDoctor(why) {
	if (doctorMemo.running) return;
	doctorMemo.running = true;
	doctorMemo.at = Date.now();
	execFile(process.execPath, [path.join(__dirname, "doctor.cjs"), "--push"], { cwd: __dirname, encoding: "utf8", timeout: DOCTOR_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
		doctorMemo.running = false;
		const last = String(stdout || "").trim().split(/\r?\n/).at(-1) || "";
		log(`doctor (${why}): ${err ? "failed: " + (last || err.message) : last}`);
	});
}

async function claimOne(wait, caps) {
	const body = { wait };
	if (caps && Array.isArray(caps.features) && caps.features.length) body.caps = caps;
	const r = await call("/chat/claim", body, (wait + 10) * 1000);
	// DOCK wraps every ingest answer as { ok, result }.
	return { ...r, message: r.result ? r.result.message : r.message, wantCatalog: Boolean(r.result && r.result.wantCatalog), wantDoctor: Boolean(r.result && r.result.wantDoctor), agentJobs: r.result && Array.isArray(r.result.agentJobs) ? r.result.agentJobs.slice(0, 8) : [] };
}

// DOCK's agent library jobs (kit/agents.cjs), in order and outside the turn pool. Each job answers { id, result } or { id, error }.
let agentJobsRun = Promise.resolve();
function runAgentJobs(jobs, opts) {
	agentJobsRun = agentJobsRun.then(async () => {
		for (const job of jobs) {
			if (!job || typeof job.id !== "string") continue;
			let body;
			try { body = { id: job.id, result: agentsLib.createAgents({ configDir: opts.configDir || PATHS.configDir }).run(job.op, job.input) }; }
			catch (e) { body = { id: job.id, error: String((e && e.message) || e).slice(0, 500) }; }
			try {
				const r = await call("/chat/agents/result", body, 15000);
				if (r.status !== 200) log(`agent job ${safeId(job.id)}: DOCK answered ${r.status}`);
			} catch (e) { log(`agent job ${safeId(job.id)}: ${e.message}`); }
		}
	}).catch((e) => log(`agent jobs: ${e.message}`));
	return agentJobsRun;
}

async function main(cmd, args) {
	if (cmd === "check") {
		const cfg = config(), s = settings(), c = resolveClaude(s.claudeBin);
		console.log(cfg ? `url: ${cfg.url}\ntoken: set` : "dock: not configured (set DOCK_INGEST_URL and DOCK_INGEST_TOKEN, or write dock.json)");
		console.log(`claude: ${c ? [c.cmd, ...c.prefix].join(" ") : "NOT FOUND (" + s.claudeBin + ")"}\ncwd: ${s.cwd}\nconfigDir: ${s.configDir || "(unset: Claude Code default)"}\nkeepAwake: ${s.keepAwake.mechanism}${s.keepAwake.mechanism === "server" ? " (not configured: DOCK-side keep-awake has no client part)" : ""}\npermissionMode: ${s.permissionMode || "(user settings)"}\nmaxTurns: ${s.maxTurns || "(none)"}\nparallelTurns: ${s.parallelTurns}\nextraArgs: ${s.extraArgs.join(" ") || "(none)"}`);
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
	const pool = createTurnPool(opts.parallelTurns);
	const handle = async (message) => {
		activeTurns++;
		const began = Date.now();
		try { await runTurn(message, config() || cfg, opts); } finally { activeTurns--; pushLedgers(began); }
		log(`message ${safeId(message.id)} finished`);
	};
	log(`bridge ${cmd}: ${cfg.url}`);
	try { pruneFiles(STATE_DIR, Date.now()); allowStore().prune(); } catch {}
	for (;;) {
		try {
			await pool.slot();
			await outbox.flush(STATE_DIR, (entry) => deliverEntry(entry, opts.retryBaseMs), log);
			const claude = resolveClaude(opts.claudeBin);
			const flags = claude && opts.interactive ? await supportedFlags(claude, opts) : null;
			if (flags) await ensureCatalog(claude, opts, flags);
			bridgeMemo.caps = buildCaps(opts, flags);
			if (cmd === "run" && opts.timing.doctorEveryMs > 0 && Date.now() - doctorMemo.at >= opts.timing.doctorEveryMs) runDoctor("scheduled");
			if (paceUntil > Date.now()) await sleep(paceUntil - Date.now());
			const began = Date.now();
			const r = await claimOne(wait, bridgeMemo.caps);
			paceUntil = cmd !== "once" && r.status === 200 && !(r.message && r.message.id != null) ? began + opts.timing.waitGapMs : 0;
			if (r.status === 401) { if (cmd === "once") return; await sleep(MAX_BACKOFF_MS); continue; }
			if (r.status !== 200) throw new Error(`claim answered ${r.status}`);
			backoff = 0;
			if (r.wantCatalog && bridgeMemo.catalog) await catalogLib.publishCatalog(bridgeMemo.catalog, call);
			if (r.wantDoctor) runDoctor("asked from DOCK");
			if (r.agentJobs.length) {
				const done = runAgentJobs(r.agentJobs, opts);
				if (cmd === "once") await done;
			}
			if (r.message && r.message.id != null) {
				log(`message ${safeId(r.message.id)} for session ${safeId(r.message.sessionId)}`);
				if (cmd === "once") await handle(r.message);
				else pool.start(() => handle(r.message), (e) => log(`bridge error: message ${safeId(r.message.id)}: ${e.message}`));
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

module.exports = { resolveClaude, killTree, childEnv, numstatOf, touchedPath, changedFiles, limitsOf, settings, createTurnPool, keepAwake, track, snapshotTree, reap, killAllSync };

if (require.main === module) {
	const [cmd, ...args] = process.argv.slice(2);
	process.on("unhandledRejection", (e) => log(`unhandled: ${e && e.message}`));
	main(cmd, args).catch((e) => log(`bridge stopped: ${e.message}`));
}
