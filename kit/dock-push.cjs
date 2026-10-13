// Laptop -> DOCK. Pushes ticket status, agent activity and masked session transcripts.
//   node dock-push.cjs status KEY                 push one ledger
//   node dock-push.cjs all                        push every ledger
//   node dock-push.cjs event KEY EVENT [detail]   push one activity event
//   node dock-push.cjs transcript KEY <session.jsonl> [--from "marker"] [--agents id,id]
//   node dock-push.cjs hook                       Claude Code hook: event JSON on stdin
//   node dock-push.cjs sessions [--all] [--id <uuid>]   sync Claude Code session history to DOCK chat
//   node dock-push.cjs statusline <payload.json>  push one status line snapshot (called by statusline.cjs)
//   node dock-push.cjs ledger list|get|handover|accept [json]   call one of the four /ledger/* routes
//   node dock-push.cjs check                      show what is configured (never the token)
// Config: DOCK_INGEST_URL + DOCK_INGEST_TOKEN, or dock.json next to this file:
//   { "url": "https://<dock>/ingest/orchestrator", "token": "dock_ing_...", "maskExtra": ["..."] }
// Without config every command is a silent no-op, so the kit works with DOCK switched off.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PATHS = require("./paths.cjs").resolvePaths();
const LEDGER_ROOT = PATHS.evidence;
const CONFIG_FILE = path.join(__dirname, "dock.json");
const MAX_TRANSCRIPT_BYTES = 11 * 1024 * 1024;
const TAIL_BYTES = 80 * 1024 * 1024;
const FLUSH_WINDOW_MS = 2000;
const SESSIONS_DIR = PATHS.sessionsDir;
const STATE_DIR = process.env.DOCK_KIT_STATE_DIR || __dirname;   // tests point this away from the kit folder
const MAX_MESSAGE_CHARS = 16000;
const MAX_SESSION_MESSAGES = 5000;
const SESSION_BATCH = 400;
const SESSION_BATCH_BYTES = 1500000;   // DOCK takes 2 MB per /sessions request; 400 long messages alone could be 6 MB

function config() {
	let file = {};
	try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
	const url = (process.env.DOCK_INGEST_URL || file.url || "").replace(/\/+$/, "");
	const token = process.env.DOCK_INGEST_TOKEN || file.token || "";
	const extra = (process.env.DOCK_MASK_EXTRA ? process.env.DOCK_MASK_EXTRA.split(",") : file.maskExtra || []).filter(Boolean);
	return url && token ? { url, token, extra } : null;
}

// DOCK_PROXY=http://host:port reaches DOCK through an HTTP CONNECT tunnel built from node's own modules, for a node whose fetch ignores proxy variables.
function viaProxy(target, proxy, init) {
	return new Promise((resolve, reject) => {
		const t = new URL(target), p = new URL(proxy), secure = t.protocol === "https:";
		const port = t.port || (secure ? 443 : 80);
		const finish = (tunnel) => {
			const lib = secure ? require("https") : require("http");
			const req = lib.request({ host: t.hostname, port, path: t.pathname + t.search, method: init.method, headers: init.headers, createConnection: () => (secure ? require("tls").connect({ socket: tunnel, servername: t.hostname }) : tunnel), timeout: init.timeoutMs }, (res) => {
				const chunks = [];
				let size = 0, tooLarge = false;
				res.on("data", (c) => {
					size += c.length;
					if (init.maxBytes && size > init.maxBytes) { tooLarge = true; return req.destroy(new Error("response too large")); }
					chunks.push(c);
				});
				res.on("end", () => { if (tooLarge) return reject(new Error("response too large")); const buffer = Buffer.concat(chunks); resolve({ status: res.statusCode, text: buffer.toString("utf8"), buffer, headers: res.headers }); });
				res.on("error", reject);
			});
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.on("error", reject);
			if (init.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
			req.end(init.body);
		};
		const connect = require("http").request({ host: p.hostname, port: p.port || 80, method: "CONNECT", path: `${t.hostname}:${port}`, timeout: init.timeoutMs });
		connect.on("connect", (res, socket) => (res.statusCode === 200 ? finish(socket) : (socket.destroy(), reject(new Error(`proxy answered ${res.statusCode}`)))));
		connect.on("timeout", () => connect.destroy(new Error("timeout")));
		connect.on("error", reject);
		if (init.signal) {
			if (init.signal.aborted) return reject(new Error("aborted"));
			init.signal.addEventListener("abort", () => connect.destroy(new Error("aborted")), { once: true });
		}
		connect.end();
	});
}

async function send(route, body, timeoutMs, signal) {
	const cfg = config();
	if (!cfg) return { skipped: true };
	if (process.env.DOCK_PROXY) {
		const r = await viaProxy(cfg.url + route, process.env.DOCK_PROXY, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(body), timeoutMs, signal });
		let json = {}; try { json = JSON.parse(r.text); } catch {}
		return { status: r.status, ...json };
	}
	const res = await fetch(cfg.url + route, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, ...json };
}

async function sendBinary(route, body, timeoutMs, maxBytes = 9 * 1024 * 1024) {
	const cfg = config();
	if (!cfg) return { skipped: true };
	const headers = { "content-type": "application/json", authorization: `Bearer ${cfg.token}` };
	if (process.env.DOCK_PROXY) {
		const r = await viaProxy(cfg.url + route, process.env.DOCK_PROXY, { method: "POST", headers, body: JSON.stringify(body), timeoutMs, maxBytes });
		return { status: r.status, buffer: r.buffer, headers: r.headers };
	}
	const res = await fetch(cfg.url + route, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	const chunks = [];
	let size = 0;
	if (res.body) {
		for await (const chunk of res.body) {
			size += chunk.length;
			if (size > maxBytes) { await res.body.cancel().catch(() => {}); throw new Error("response too large"); }
			chunks.push(Buffer.from(chunk));
		}
	}
	return { status: res.status, buffer: Buffer.concat(chunks), headers: Object.fromEntries(res.headers) };
}

const ledgerFile = (key) => path.join(LEDGER_ROOT, key, "status.json");
const readLedger = (key) => JSON.parse(fs.readFileSync(ledgerFile(key), "utf8"));
const ledgerKeys = () => (fs.existsSync(LEDGER_ROOT) ? fs.readdirSync(LEDGER_ROOT).filter((k) => fs.existsSync(ledgerFile(k))) : []);

// ---------- masking: secrets are removed here, before anything leaves the laptop ----------
const SECRET_KEY = /^(pass(word|wd)?|secret|token|api[_-]?key|apikey|authorization|cookie|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|pin)$/i;
const PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:sk|pk|rk|xi)_[A-Za-z0-9]{24,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bapikey_[A-Za-z0-9_]{16,}\b/g,
	/\bdock_ing_[A-Za-z0-9_-]{20,}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@\/"']+:[^\s@\/"']+@/g,
];
const INLINE = /((?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|authorization|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;}\\]{6,})/gi;

function maskString(s, stats, extra) {
	if (s.length > 20000 && /^[A-Za-z0-9+\/=\r\n]+$/.test(s.slice(0, 400))) { stats.blobs++; return "***"; }
	let out = s;
	for (const re of PATTERNS) out = out.replace(re, () => { stats.masked++; return "***"; });
	out = out.replace(INLINE, (_m, head) => { stats.masked++; return head + "***"; });
	for (const word of extra) if (out.includes(word)) { out = out.split(word).join("***"); stats.masked++; }
	return out;
}
function maskValue(v, stats, extra, key) {
	if (typeof v === "string") return key && SECRET_KEY.test(key) && v.length > 0 ? (stats.masked++, "***") : maskString(v, stats, extra);
	if (Array.isArray(v)) return v.map((x) => maskValue(x, stats, extra));
	if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = maskValue(v[k], stats, extra, k); return o; }
	return v;
}
function maskJsonl(text, stats, extra) {
	const out = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.stringify(maskValue(JSON.parse(line), stats, extra))); stats.lines++; } catch { stats.dropped++; }
	}
	return out.join("\n") + "\n";
}
function readTail(file, bytes) {
	const size = fs.statSync(file).size, start = Math.max(0, size - bytes), fd = fs.openSync(file, "r");
	const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
	const text = buf.toString("utf8");
	return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
}

function buildTranscript(sessionFile, marker, agents, extra) {
	const stats = { masked: 0, blobs: 0, lines: 0, dropped: 0 };
	const id = path.basename(sessionFile, ".jsonl");
	const dir = path.join(path.dirname(sessionFile), id, "subagents");
	const files = [];
	let budget = MAX_TRANSCRIPT_BYTES;
	// Subagents first: they are small and they are the part of the graph worth seeing.
	for (const agent of agents) {
		const base = path.join(dir, `agent-${agent}`);
		if (!fs.existsSync(base + ".jsonl")) continue;
		const text = maskJsonl(fs.readFileSync(base + ".jsonl", "utf8"), stats, extra);
		if (Buffer.byteLength(text) > budget) continue;
		budget -= Buffer.byteLength(text);
		files.push({ path: `${id}/subagents/agent-${agent}.jsonl`, text });
		if (fs.existsSync(base + ".meta.json")) {
			const meta = JSON.stringify(maskValue(JSON.parse(fs.readFileSync(base + ".meta.json", "utf8")), stats, extra));
			budget -= Buffer.byteLength(meta);
			files.push({ path: `${id}/subagents/agent-${agent}.meta.json`, text: meta });
		}
	}
	let lines = readTail(sessionFile, TAIL_BYTES).split("\n");
	if (marker) { const from = lines.findIndex((l) => l.includes(marker)); if (from >= 0) lines = lines.slice(from); }
	let main = maskJsonl(lines.join("\n"), stats, extra);
	// Too big even after masking: keep the newest lines that fit.
	while (Buffer.byteLength(main) > budget) main = main.slice(main.indexOf("\n", Math.floor(main.length * 0.1)) + 1);
	files.unshift({ path: `${id}.jsonl`, text: main });
	return { files, stats };
}

// ---------- hook ----------
function ticketForCwd(cwd) {
	if (process.env.DOCK_TICKET) return process.env.DOCK_TICKET;
	const norm = String(cwd || "").replace(/\\/g, "/").toLowerCase();
	const wt = /\/wt-(\d+)-(?:be|fe)(?:\/|$)/.exec(norm);
	if (wt) return `QRD-${wt[1]}`;
	for (const key of ledgerKeys()) {
		try {
			const dirs = Object.values(readLedger(key).dirs || {}).filter(Boolean).map((d) => String(d).replace(/\\/g, "/").toLowerCase());
			if (dirs.some((d) => norm === d || norm.startsWith(d + "/"))) return key;
		} catch {}
	}
	return null;
}
// Hook events are queued per ticket and sent in batches, so the cost of a hook stays the
// same however fast tools run: one small file append, and at most one request every 2 s.
const queueFile = (key) => path.join(os.tmpdir(), `dock-queue-${key}.jsonl`);
const flushStamp = (key) => path.join(os.tmpdir(), `dock-flush-${key}.stamp`);
const HOOK_EVENTS = ["PreToolUse", "Stop", "SubagentStop", "Notification", "UserPromptSubmit"];
const HIDDEN_TOOLS = new Set(["SubagentHandback"]);

// A subagent runs in the lead's folder, so its ticket cannot be read from cwd. The lead names
// the ticket when it spawns a member (description, name or prompt); that link is remembered
// per session and every later event from that member follows it.
const KEY_IN_TEXT = /\bQRD-(\d{2,6})\b|[\\/]wt-(\d{2,6})-(?:be|fe)\b/gi;
function ticketsInText(text, known) {
	const found = new Set();
	for (const m of String(text || "").matchAll(KEY_IN_TEXT)) { const key = `QRD-${m[1] || m[2]}`; if (known.has(key)) found.add(key); }
	return [...found];
}
function subagentMeta(input) {
	try {
		const transcript = String(input.transcript_path || "").split("\\").join("/");
		const dir = transcript.includes("/subagents/") ? path.dirname(transcript) : path.join(path.dirname(transcript), String(input.session_id || ""), "subagents");
		return JSON.parse(fs.readFileSync(path.join(dir, `agent-${input.agent_id}.meta.json`), "utf8"));
	} catch { return null; }
}
function ticketForEvent(input) {
	const byCwd = ticketForCwd(input.cwd);
	const known = new Set(ledgerKeys());
	const stateFile = path.join(os.tmpdir(), `dock-agents-${String(input.session_id || "x").slice(0, 12)}.json`);
	let state = { pending: [], map: {} };
	try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
	const save = () => { try { state.pending = state.pending.filter((p) => Date.now() - p.at < 10 * 60 * 1000).slice(-30); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {} };
	const ti = input.tool_input || {};
	const spawning = input.hook_event_name === "PreToolUse" && (input.tool_name === "Agent" || input.tool_name === "Task");

	// Who is acting: a known member, a member seen for the first time, or the main session.
	let key = null;
	if (input.agent_id) {
		key = state.map[input.agent_id] || null;
		if (!key) {
			// Claude Code writes agent-<id>.meta.json next to the subagent transcript with the tool_use_id of the spawn
			// call and the parent agent's id, so a member is linked to its spawn exactly, not guessed from its type.
			// Without that link the member stays unmapped (and is retried on its next event) rather than risk
			// showing it under another ticket; the cwd is only trusted when no meta file can be read at all.
			const meta = subagentMeta(input);
			if (meta) {
				const i = meta.toolUseId ? state.pending.findIndex((p) => p.useId === meta.toolUseId) : -1;
				const named = ticketsInText(`${meta.description || ""} ${meta.name || ""}`, known);
				key = i >= 0 ? state.pending.splice(i, 1)[0].key
					: (meta.parentAgentId && state.map[meta.parentAgentId]) || (named.length === 1 ? named[0] : null);
			} else key = byCwd;
			if (key) { state.map[input.agent_id] = key; save(); }
		}
	}
	if (spawning) {
		// A sub-coordinator's members belong to its ticket; the main session names the ticket itself.
		if (!key) {
			const named = ticketsInText(`${ti.description || ""} ${ti.name || ""}`, known);
			const inPrompt = named.length === 1 ? named : ticketsInText(ti.prompt, known);
			key = (inPrompt.length === 1 ? inPrompt[0] : null) || byCwd;
		}
		if (key) { state.pending.push({ useId: String(input.tool_use_id || ""), key, at: Date.now() }); save(); }
		return key;
	}
	if (key || input.agent_id) return key;
	if (byCwd) return byCwd;
	// The lead's own tool calls: follow the one ticket its command or path mentions, if exactly one.
	const mentioned = ticketsInText(JSON.stringify(ti).slice(0, 4000), known);
	return mentioned.length === 1 ? mentioned[0] : null;
}

function hook(raw) {
	const cfg = config();
	if (!cfg) return;
	let input; try { input = JSON.parse(raw); } catch { return; }
	const event = input.hook_event_name;
	if (!HOOK_EVENTS.includes(event)) return;
	if (event === "PreToolUse" && HIDDEN_TOOLS.has(input.tool_name)) return;
	// "Waiting for your input" after a turn ends is the session being idle, not a ticket blocked on the owner.
	if (event === "Notification" && input.notification_type === "idle_prompt") return;
	const found = ticketForEvent(input);
	// The lead works on a ticket for one command and then moves on, and its Stop names no ticket. Without this the
	// ticket it last touched stays "active" on DOCK forever, so the lead's Stop is passed on to every ticket it touched.
	const leadFile = path.join(os.tmpdir(), `dock-lead-${String(input.session_id || "x").slice(0, 12)}.json`);
	let leadKeys = [];
	try { leadKeys = JSON.parse(fs.readFileSync(leadFile, "utf8")); } catch {}
	let keys = found ? [found] : [];
	if (!input.agent_id) {
		if (found && event === "PreToolUse" && !leadKeys.includes(found)) {
			leadKeys.push(found);
			try { fs.writeFileSync(leadFile, JSON.stringify(leadKeys.slice(-20))); } catch {}
		}
		if (event === "Stop") {
			keys = [...new Set([...keys, ...leadKeys])];
			try { fs.rmSync(leadFile, { force: true }); } catch {}
		}
	}
	for (const key of keys) queueEvent(cfg, input, event, key);
}

function queueEvent(cfg, input, event, key) {
	const stats = { masked: 0, blobs: 0 };
	const entry = { event, at: new Date().toISOString() };
	if (input.agent_id) { entry.agentId = String(input.agent_id); entry.agentType = String(input.agent_type || ""); }
	if (event === "PreToolUse") {
		entry.tool = String(input.tool_name || "");
		// Spawning a subagent: its type and its short description are the only words that leave the laptop.
		if ((entry.tool === "Agent" || entry.tool === "Task") && input.tool_input) {
			entry.spawnType = String(input.tool_input.subagent_type || "agent");
			if (input.tool_input.name) entry.spawnName = String(input.tool_input.name).replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 32);
			// The main session cannot name the agents it spawns, so a sub-coordinator is recognised by its description.
			else if (/coordinator/i.test(String(input.tool_input.description || ""))) entry.spawnName = `coord-${key.replace(/^[A-Z]+-/, "")}`;
			entry.detail = maskString(String(input.tool_input.description || ""), stats, cfg.extra).slice(0, 60);
		}
	} else if (event === "Notification") {
		entry.detail = maskString(String(input.message || ""), stats, cfg.extra).slice(0, 80);
	}

	const queue = queueFile(key);
	try { if (fs.statSync(queue).size > 200 * 1024) fs.rmSync(queue, { force: true }); } catch {}   // DOCK unreachable for a long time
	fs.appendFileSync(queue, JSON.stringify(entry) + "\n");

	// State changes go out at once; tool calls wait for the next 2 s window.
	const stamp = flushStamp(key);
	if (event === "PreToolUse") {
		let recent = false;
		try { recent = Date.now() - fs.statSync(stamp).mtimeMs < FLUSH_WINDOW_MS; } catch {}
		if (recent) {
			const later = `${stamp}.later`;
			let scheduled = false;
			try { scheduled = Date.now() - fs.statSync(later).mtimeMs < FLUSH_WINDOW_MS + 500; } catch {}
			if (!scheduled) { try { fs.writeFileSync(later, ""); } catch {} detached(["flush-later", key]); }
			return;
		}
	}
	try { fs.writeFileSync(stamp, ""); } catch {}
	detached(["flush", key]);
}

async function flush(key) {
	const queue = queueFile(key);
	const sending = `${queue}.${process.pid}.sending`;
	try { fs.renameSync(queue, sending); } catch { return; }
	try {
		const events = fs.readFileSync(sending, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		for (let i = 0; i < events.length; i += 100) {
			const result = await send("/events", { key, events: events.slice(i, i + 100) }, 5000);
			// A DOCK that predates batches still understands single events: keep its status alive with the newest main-session one.
			if (result.status === 404 && !result.error?.includes("Unknown ticket")) {
				const last = events.filter((e) => !e.agentId || e.event === "PreToolUse").at(-1);
				if (last) await send("/event", { key, event: last.event === "SubagentStop" ? "PreToolUse" : last.event, detail: last.tool || last.detail || undefined }, 3000);
				break;
			}
		}
	} catch {} finally { fs.rmSync(sending, { force: true }); }
}

function detached(args) {
	spawn(process.execPath, [__filename, ...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// Called by status.cjs after every ledger write. Never blocks and never throws.
function pushStatusDetached(key) {
	try { if (config()) detached(["status", key]); } catch {}
}
// ---------- ledger hand-over: the four /ledger/* routes, used by status.cjs ----------
const LEDGER_ROUTES = ["list", "get", "handover", "accept"];
function ledger(route, body, timeoutMs) {
	if (!LEDGER_ROUTES.includes(route)) return Promise.reject(new Error(`ledger route must be one of ${LEDGER_ROUTES.join(", ")}`));
	return send(`/ledger/${route}`, body || {}, timeoutMs || 8000);
}
// ---------- chat: shared with dock-chat.cjs ----------
const cut = (s) => (s.length > MAX_MESSAGE_CHARS ? s.slice(0, MAX_MESSAGE_CHARS - 7) + " …[cut]" : s);
function toolLine(name, input) {
	const i = input || {};
	const what = [i.description, i.file_path, i.pattern, i.command].find((v) => typeof v === "string" && v.trim());
	return what ? `${name} · ${what.replace(/\s+/g, " ").trim().slice(0, 80)}` : String(name);
}

// ---------- history sync: Claude Code sessions -> DOCK chat ----------
const SKIP_USER = /^\s*(?:<system-reminder>|<task-notification>|<command-|<local-command-|\[Request interrupted)/;
function userText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}
// One pass over the file; only the newest MAX_SESSION_MESSAGES kept messages stay in memory.
async function readSession(file) {
	const ring = [];
	let head = 0, firstUser = "", total = 0;
	const keep = (role, text, at) => {
		if (!text.trim()) return;
		total++;
		ring.push({ role, text: cut(text.slice(0, MAX_MESSAGE_CHARS + 200)), at });
		if (ring.length - head > MAX_SESSION_MESSAGES) ring[head++] = null;
		if (head > 10000) { ring.splice(0, head); head = 0; }
	};
	const lines = require("readline").createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		if (o.isSidechain || !o.message) continue;
		const at = o.timestamp || new Date(0).toISOString();
		if (o.type === "user") {
			if (o.isMeta || o.isCompactSummary) continue;
			const text = userText(o.message.content);
			if (!text.trim() || SKIP_USER.test(text)) continue;
			if (!firstUser) firstUser = text;
			keep("user", text, at);
		} else if (o.type === "assistant" && Array.isArray(o.message.content) && o.message.model !== "<synthetic>") {
			for (const b of o.message.content) {
				if (b.type === "text" && typeof b.text === "string") keep("assistant", b.text, at);
				else if (b.type === "tool_use") keep("tool", toolLine(b.name, b.input), at);
			}
		}
	}
	return { messages: ring.slice(head), total, firstUser };
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

async function syncSessions(args, cfg) {
	const all = args.includes("--all");
	const only = args.includes("--id") ? args[args.indexOf("--id") + 1] : "";
	const stateFile = path.join(STATE_DIR, "dock-sessions-state.json");
	const state = readJson(stateFile, {});
	const dockOwned = new Set(readJson(path.join(STATE_DIR, "dock-chat-sessions.json"), []));
	const files = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")) : [];
	let sent = 0, skipped = 0, failed = 0;
	for (const name of files) {
		const id = path.basename(name, ".jsonl");
		if (only && id !== only) continue;
		if (dockOwned.has(id)) { skipped++; continue; }
		const file = path.join(SESSIONS_DIR, name), st = fs.statSync(file);
		if (!all && state[id] && state[id].size === st.size && state[id].mtimeMs === st.mtimeMs) { skipped++; continue; }
		const { messages, total, firstUser } = await readSession(file);
		if (!messages.length) { state[id] = { size: st.size, mtimeMs: st.mtimeMs }; continue; }
		const stats = { masked: 0, blobs: 0 };
		const session = { id, title: maskString(firstUser.replace(/<\/?[a-z_-]+(?:\s[^>]*)?>/gi, " ").trim().replace(/\s+/g, " ").slice(0, 80), stats, cfg.extra), ticketKey: null, startedAt: messages[0].at, lastMessageAt: messages.at(-1).at };
		let ok = true, batches = 0;
		for (let i = 0; i < messages.length && ok;) {
			const batch = []; let bytes = 0;
			while (i < messages.length && batch.length < SESSION_BATCH) {
				const m = { role: messages[i].role, text: cut(maskString(messages[i].text, stats, cfg.extra)), at: messages[i].at };
				const size = Buffer.byteLength(JSON.stringify(m));
				if (batch.length && bytes + size > SESSION_BATCH_BYTES) break;
				batch.push(m); bytes += size; i++;
			}
			const r = await send("/sessions", { session, replace: batches === 0, messages: batch }, 30000);
			batches++;
			if (r.status !== 200) { ok = false; console.log(`${id}: ${r.status}${r.error ? " " + r.error : ""}`); }
		}
		if (ok) { state[id] = { size: st.size, mtimeMs: st.mtimeMs }; sent++; console.log(`${id}: ${messages.length}/${total} messages, ${batches} batches, ${stats.masked} secrets masked`); }
		else failed++;
		fs.writeFileSync(stateFile, JSON.stringify(state));
	}
	fs.writeFileSync(stateFile, JSON.stringify(state));
	console.log(`sessions: ${sent} sent, ${skipped} unchanged or skipped, ${failed} failed`);
}

module.exports = { pushStatusDetached, maskString, config, send, sendBinary, toolLine, cut, ledger };

if (require.main === module) {
	const [cmd, ...args] = process.argv.slice(2);
	const report = (label, r) => console.log(r.skipped ? `${label}: DOCK not configured, skipped` : `${label}: ${r.status}${r.error ? " " + r.error : ""}`);
	(async () => {
		if (cmd === "status") report(args[0], await send("", readLedger(args[0]), 8000));
		else if (cmd === "all") for (const key of ledgerKeys()) report(key, await send("", readLedger(key), 8000));
		else if (cmd === "event") await send("/event", { key: args[0], event: args[1], detail: args[2] || undefined }, 3000);
		else if (cmd === "flush") await flush(args[0]);
		else if (cmd === "flush-later") { await new Promise((r) => setTimeout(r, FLUSH_WINDOW_MS + 200)); await flush(args[0]); }
		else if (cmd === "transcript") {
			const [key, sessionFile] = args;
			const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
			const cfg = config();
			if (!cfg) return report(key, { skipped: true });
			const { files, stats } = buildTranscript(sessionFile, flag("--from"), flag("--agents").split(",").filter(Boolean), cfg.extra);
			const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
			console.log(`${key}: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB, ${stats.masked} secrets masked, ${stats.blobs} blobs dropped`);
			report(key, await send("/transcript", { key, files, stats }, 60000));
		} else if (cmd === "sessions") {
			const cfg = config();
			if (!cfg) return report("sessions", { skipped: true });
			await syncSessions(args, cfg);
		} else if (cmd === "ledger") {
			const r = await ledger(args[0], args[1] ? JSON.parse(args[1]) : {});
			console.log(r.skipped ? "ledger: DOCK not configured, skipped" : JSON.stringify(r));
		} else if (cmd === "statusline") {
			const payload = readJson(args[0], null);
			try { fs.rmSync(args[0], { force: true }); } catch {}
			if (payload) await send("/chat/status", payload, 5000);
		} else if (cmd === "hook") {
			let raw = ""; process.stdin.setEncoding("utf8");
			process.stdin.on("data", (c) => { raw += c; });
			process.stdin.on("end", () => { try { hook(raw); } catch {} });
		} else if (cmd === "check") {
			const cfg = config();
			console.log(cfg ? `url: ${cfg.url}\ntoken: set\nextra mask words: ${cfg.extra.length}\nledgers: ${ledgerKeys().join(", ") || "none"}` : `not configured: set DOCK_INGEST_URL and DOCK_INGEST_TOKEN, or write ${CONFIG_FILE}`);
		} else console.log("usage: dock-push.cjs status KEY | all | event KEY EVENT [detail] | transcript KEY <session.jsonl> [--from marker] [--agents a,b] | sessions [--all] [--id uuid] | statusline <payload.json> | ledger list|get|handover|accept [json] | hook | check");
	})().catch((e) => { if (cmd !== "event" && cmd !== "hook" && cmd !== "statusline" && !String(cmd).startsWith("flush")) console.log(`dock push failed: ${e.message}`); });
}
