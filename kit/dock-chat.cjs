// Laptop bridge for DOCK chat: claims queued browser messages, runs them through Claude Code, streams the answer back.
//   node dock-chat.cjs run      loop forever: claim -> one turn -> deltas -> next
//   node dock-chat.cjs once     handle at most one message and exit  [--wait seconds, default 5]
//   node dock-chat.cjs check    show the configuration (never the token)
// Config: dock-chat.json next to this file, all optional:
//   { "cwd": "E:/qonflo", "configDir": "C:/Users/danus/.claude-kantor", "permissionMode": null, "maxTurns": null, "extraArgs": [],
//     "claudeBin": "claude", "turnTimeoutMs": 1800000, "retryBaseMs": 1000,
//     "keepAwake": { "mechanism": "off | app-status | server", "appSlug": null } }
// Defaults come from paths.cjs. On Linux configDir is unset, so Claude Code keeps its own ~/.claude.
// The DOCK url and token come from dock-push.cjs (dock.json or env).
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const { maskString, config, send, toolLine, cut } = require("./dock-push.cjs");
const PATHS = require("./paths.cjs").resolvePaths();

const SESSIONS_FILE = path.join(process.env.DOCK_KIT_STATE_DIR || __dirname, "dock-chat-sessions.json");
const DELTA_INTERVAL_MS = 1000;
const CLAIM_WAIT_S = 25;
const MAX_BACKOFF_MS = 30000;
const KEEP_AWAKE_EVERY_MS = 10 * 60 * 1000;
const PROXY_VARS = /^(https?_proxy|all_proxy|node_use_env_proxy|dock_proxy)$/i;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settings({ platform = process.platform, paths = PATHS, file: given } = {}) {
	let file = {};
	if (given) file = given;
	else try { file = JSON.parse(fs.readFileSync(process.env.DOCK_CHAT_CONFIG || path.join(__dirname, "dock-chat.json"), "utf8")); } catch {}
	const ka = file.keepAwake || {};
	return {
		cwd: file.cwd || paths.root,
		configDir: file.configDir || (platform === "win32" ? paths.configDir : null),
		permissionMode: file.permissionMode || null,
		maxTurns: file.maxTurns || null,
		extraArgs: Array.isArray(file.extraArgs) ? file.extraArgs.map(String) : [],
		claudeBin: file.claudeBin || "claude",
		turnTimeoutMs: file.turnTimeoutMs || 30 * 60 * 1000,
		retryBaseMs: file.retryBaseMs || 1000,
		keepAwake: { mechanism: ["app-status", "server"].includes(ka.mechanism) ? ka.mechanism : "off", appSlug: ka.appSlug || null },
	};
}

// The environment claude runs in. DOCK_CHAT_TURN=1 switches guard.cjs to its unattended profile; CLAUDE_CONFIG_DIR is set only when
// configDir is; the proxy variables kit-node sets to reach DOCK are removed so Anthropic traffic does not go through tailscaled.
function childEnv(opts, base = process.env) {
	const env = { ...base, DOCK_CHAT_TURN: "1" };
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
function descendants(pid, psOutput) {
	const kids = new Map();
	for (const line of psOutput.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) || []), Number(m[1])]);
	}
	const found = [], queue = [pid];
	while (queue.length) for (const k of kids.get(queue.shift()) || []) { found.push(k); queue.push(k); }
	return found;
}

function killTree(child, { platform = process.platform, run = spawnSync, kill = (p, sig) => process.kill(p, sig) } = {}) {
	try {
		if (platform === "win32") run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		else {
			const below = descendants(child.pid, String(run("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout || ""));
			child.kill("SIGKILL");
			for (const pid of below) { try { kill(pid, "SIGKILL"); } catch {} }
		}
	} catch {}
}

let authLogged = false;
// 401 is logged once; the caller keeps trying slowly.
async function call(route, body, timeoutMs) {
	const r = await send(route, body, timeoutMs);
	if (r.status === 401) { if (!authLogged) { authLogged = true; log("DOCK rejected the token (401); still trying, slowly"); } }
	else authLogged = false;
	return r;
}

// Sends one delta, retrying network failures and 5xx 5 times with backoff. Returns false when it gave up.
async function sendDelta(body, retryBaseMs) {
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			const r = await call("/chat/delta", body, 15000);
			if (r.skipped) return true;
			if (r.status < 500 && r.status !== 401) {
				if (r.status >= 400) log(`delta refused: ${r.status}${r.error ? " " + r.error : ""}`);
				return true;
			}
			log(`delta failed: ${r.status}`);
		} catch (e) { log(`delta failed: ${e.message}`); }
		if (attempt < 5) await sleep(Math.min(retryBaseMs * 2 ** attempt, MAX_BACKOFF_MS));
	}
	return false;
}

async function runTurn(msg, cfg, opts) {
	const mask = (s) => maskString(String(s), { masked: 0, blobs: 0 }, cfg.extra);
	const out = (text) => cut(mask(text));
	const claude = resolveClaude(opts.claudeBin);
	let state = { claudeSessionId: msg.claudeSessionId || null, pending: [], detail: null, lastSent: 0, aborted: false };
	let chain = Promise.resolve();
	let timer = null, child;

	const post = (extra) => {
		const items = state.pending; state.pending = [];
		const body = { sessionId: msg.sessionId, replyTo: msg.id, items, ...extra };
		if (state.claudeSessionId) body.claudeSessionId = state.claudeSessionId;
		if (state.detail) body.detail = state.detail;
		state.lastSent = Date.now();
		chain = chain.then(async () => {
			if (state.aborted) return;
			if (!(await sendDelta(body, opts.retryBaseMs))) { state.aborted = true; log(`dropping turn for message ${msg.id}: DOCK unreachable`); killTree(child); }
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

	if (!claude) {
		const error = out(`Claude Code was not found on this machine (claudeBin: ${opts.claudeBin})`);
		await post({ done: false, error });
		return;
	}
	const args = [...claude.prefix, "-p", msg.text.startsWith("-") ? " " + msg.text : msg.text, "--output-format", "stream-json", "--verbose"];
	if (msg.claudeSessionId) args.push("--resume", msg.claudeSessionId);
	else if (msg.forkFrom) args.push("--resume", msg.forkFrom, "--fork-session");
	if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
	if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
	args.push(...opts.extraArgs);

	const env = childEnv(opts);
	let stderrTail = "", result = null, timedOut = false, spawnError = null;
	child = spawn(claude.cmd, args, { cwd: opts.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	child.on("error", (e) => { spawnError = e; });
	child.stderr.on("data", (c) => { stderrTail = (stderrTail + c).slice(-2000); });
	const killer = setTimeout(() => { timedOut = true; killTree(child); }, opts.turnTimeoutMs);
	void keepAwake("working", opts);
	const awake = setInterval(() => { void keepAwake("working", opts, { force: true }); }, KEEP_AWAKE_EVERY_MS);
	awake.unref();

	const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
	const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
	const drained = new Promise((resolve) => lines.once("close", resolve));
	lines.on("line", (line) => {
		let o; try { o = JSON.parse(line); } catch { return; }
		if (!o || typeof o !== "object") return;
		if (o.type === "system" && o.subtype === "init") learn(o.session_id);
		else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
			learn(o.session_id);
			const at = new Date().toISOString();
			for (const b of o.message.content) {
				if (!b) continue;
				if (b.type === "text" && typeof b.text === "string" && b.text.trim()) state.pending.push({ role: "assistant", text: out(b.text), at });
				else if (b.type === "tool_use") { state.pending.push({ role: "tool", text: out(toolLine(b.name, b.input)), at }); state.detail = mask(String(b.name)); }
			}
			schedule();
		} else if (o.type === "result") { learn(o.session_id); result = o; }
	});

	const code = await closed;
	clearTimeout(killer);
	clearInterval(awake);
	void keepAwake("idle", opts);
	await drained;
	if (timer) { clearTimeout(timer); timer = null; }

	let error = null;
	if (timedOut) error = `The turn ran longer than ${opts.turnTimeoutMs >= 60000 ? Math.round(opts.turnTimeoutMs / 60000) + " minutes" : Math.round(opts.turnTimeoutMs / 1000) + " seconds"} and was stopped`;
	else if (spawnError) error = `Could not start Claude Code: ${spawnError.message}`;
	else if (result && result.is_error) error = String(result.result || result.subtype || "Claude Code reported an error");
	else if (code !== 0) error = `Claude Code exited with code ${code}${stderrTail.trim() ? ": " + stderrTail.trim().split("\n").at(-1) : ""}`;
	state.detail = null;
	await sleep(Math.max(0, state.lastSent + DELTA_INTERVAL_MS - Date.now()));
	await post(error ? { done: false, error: mask(error).slice(0, 300) } : { done: true, error: null });
	await chain;
}

async function claimOne(wait) {
	const r = await call("/chat/claim", { wait }, (wait + 10) * 1000);
	// DOCK wraps every ingest answer as { ok, result }.
	return { ...r, message: r.result ? r.result.message : r.message };
}

async function main(cmd, args) {
	if (cmd === "check") {
		const cfg = config(), s = settings(), c = resolveClaude(s.claudeBin);
		console.log(cfg ? `url: ${cfg.url}\ntoken: set` : "dock: not configured (set DOCK_INGEST_URL and DOCK_INGEST_TOKEN, or write dock.json)");
		console.log(`claude: ${c ? [c.cmd, ...c.prefix].join(" ") : "NOT FOUND (" + s.claudeBin + ")"}\ncwd: ${s.cwd}\nconfigDir: ${s.configDir || "(unset: Claude Code default)"}\nkeepAwake: ${s.keepAwake.mechanism}${s.keepAwake.mechanism === "server" ? " (not configured: DOCK-side keep-awake has no client part)" : ""}\npermissionMode: ${s.permissionMode || "(user settings)"}\nmaxTurns: ${s.maxTurns || "(none)"}\nextraArgs: ${s.extraArgs.join(" ") || "(none)"}`);
		return;
	}
	if (cmd !== "run" && cmd !== "once") return console.log("usage: dock-chat.cjs run | once [--wait seconds] | check");
	const cfg = config();
	if (!cfg) return console.log("dock chat: DOCK not configured, nothing to do");
	const opts = settings();
	const w = args.indexOf("--wait");
	const wait = cmd === "once" ? Math.min(CLAIM_WAIT_S, w >= 0 ? Number(args[w + 1]) || 0 : 5) : CLAIM_WAIT_S;
	let backoff = 0;
	log(`bridge ${cmd}: ${cfg.url}`);
	for (;;) {
		try {
			const r = await claimOne(wait);
			if (r.status === 401) { if (cmd === "once") return; await sleep(MAX_BACKOFF_MS); continue; }
			if (r.status !== 200) throw new Error(`claim answered ${r.status}`);
			backoff = 0;
			if (r.message && r.message.id != null) {
				log(`message ${r.message.id} for session ${r.message.sessionId}`);
				await runTurn(r.message, config() || cfg, opts);
				log(`message ${r.message.id} finished`);
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

module.exports = { resolveClaude, killTree, childEnv, settings, keepAwake };

if (require.main === module) {
	const [cmd, ...args] = process.argv.slice(2);
	process.on("unhandledRejection", (e) => log(`unhandled: ${e && e.message}`));
	main(cmd, args).catch((e) => log(`bridge stopped: ${e.message}`));
}
