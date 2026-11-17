// Guild Master ops for a DOCK session in gm mode. dock-chat.cjs starts that session with DOCK_GM=1, and guard.cjs lets it run nothing else.
//   node gm.cjs agents                                   every agent: slug, source, model, tools
//   node gm.cjs agent <slug>                             one agent: description, model, tools
//   node gm.cjs propose-agent <slug> [--model m] [--tools a,b]   prints the diff and keeps it as this session's pending change
//   node gm.cjs settings                                 the DOCK settings it may change; secrets only as set / not set
//   node gm.cjs propose-settings <key>=<value>...        prints the diff and keeps it as this session's pending change
//   node gm.cjs propose-rollback <log id>                a rollback, pending like any change
//   node gm.cjs log | backups | pending
// No op of the command line writes a target. apply() writes the pending change only with DOCK's one-use nonce for the owner's "ya" to
// the proposal DOCK showed (its sha256), and DOCK consumes that nonce before the write. Backups come first; log entries are signed with
// the key DOCK hands the bridge, so only entries apply() wrote can be rolled back. One manager log per machine for every gm session.
// State: <DOCK_KIT_STATE_DIR or kit>/gm/{log.jsonl, backups/, pending/, settings.json}.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const agentsLib = require("./agents.cjs");
const { resolvePaths } = require("./paths.cjs");

const SESSION = /^[A-Za-z0-9-]{1,64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const BACKUP = /^[A-Za-z0-9.-]{1,80}\.bak$/;
const MODELS = ["haiku", "sonnet", "opus", "inherit"];
const MAX_VALUE = 2000;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function createGm({ stateDir = process.env.DOCK_KIT_STATE_DIR || __dirname, configDir = resolvePaths().configDir, kitDir = __dirname, agents, now = () => new Date() } = {}) {
	const root = path.join(stateDir, "gm");
	const logFile = path.join(root, "log.jsonl");
	const lockFile = path.join(root, "log.lock");
	const backups = path.join(root, "backups");
	const settingsFile = path.join(root, "settings.json");
	const allowFile = path.join(kitDir, "agents-allow.json");
	const lib = agents || agentsLib.createAgents({ configDir, kitDir });
	const agentFile = (slug) => {
		if (!SLUG.test(String(slug))) throw new Error("A slug is 2 to 48 lowercase letters, digits or dashes");
		return path.join(path.resolve(configDir, "agents"), `${slug}.md`);
	};
	const sid = (s) => {
		if (!SESSION.test(String(s || ""))) throw new Error("This op runs only inside a Guild Master session");
		return String(s);
	};
	const pendingFile = (s) => path.join(root, "pending", `${sid(s)}.json`);
	const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
	const readBytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
	const atomic = (file, data) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, file);
	};
	const mac = (key, row) => crypto.createHmac("sha256", String(key)).update(JSON.stringify({ ...row, mac: undefined })).digest("hex");

	function entries() {
		let text = "";
		try { text = fs.readFileSync(logFile, "utf8"); } catch { return []; }
		return text.split("\n").flatMap((line) => { try { const e = JSON.parse(line); return e && Number.isInteger(e.id) ? [e] : []; } catch { return []; } });
	}
	// Two gm turns, or a turn and a panel rollback, append at once: the id and the line are written under one lock file. The lock holds a
	// random token, and only the holder whose token is still in it removes it, so a stale-lock takeover never loses the newer lock.
	function withLock(work) {
		fs.mkdirSync(root, { recursive: true });
		const end = Date.now() + LOCK_WAIT_MS;
		const token = crypto.randomBytes(12).toString("hex");
		let fd = null;
		while (fd === null) {
			try { fd = fs.openSync(lockFile, "wx"); fs.writeSync(fd, token); } catch (e) {
				if (e.code !== "EEXIST") throw e;
				try { if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true }); } catch {}
				if (Date.now() > end) throw new Error("The manager log is locked; try again");
				sleepSync(20);
			}
		}
		try { return work(); } finally {
			fs.closeSync(fd);
			try { if (fs.readFileSync(lockFile, "utf8") === token) fs.rmSync(lockFile, { force: true }); } catch {}
		}
	}
	function append(entry, key) {
		return withLock(() => {
			const id = entries().reduce((m, e) => Math.max(m, e.id), 0) + 1;
			const row = { id, at: now().toISOString(), ...entry };
			row.mac = mac(key, row);
			fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`);
			return row;
		});
	}
	function backup(bytes, label) {
		const name = `${now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${label}-${crypto.randomBytes(3).toString("hex")}.bak`;
		fs.mkdirSync(backups, { recursive: true });
		fs.writeFileSync(path.join(backups, name), bytes);
		return { backup: name, backupSha: sha256(bytes) };
	}
	const backupBytes = (name) => {
		if (!BACKUP.test(String(name))) throw new Error("Not a backup id");
		return fs.readFileSync(path.join(backups, name));
	};

	// The settings a rollback of a settings entry writes back, so DOCK can bind the owner's confirmation to them.
	const restoreValues = (e) => {
		if (e.type !== "settings") return null;
		try { const v = JSON.parse(backupBytes(e.backup).toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
	};
	function view() {
		const rolled = new Set(entries().filter((e) => Number.isInteger(e.rollbackOf)).map((e) => e.rollbackOf));
		return entries().reverse().map(({ mac: _mac, ...e }) => ({ ...e, rolledBack: rolled.has(e.id), restoreValues: restoreValues(e) }));
	}

	const settingsView = () => {
		const s = readJson(settingsFile);
		return { values: s && s.values && typeof s.values === "object" ? s.values : {}, secrets: s && s.secrets && typeof s.secrets === "object" ? s.secrets : {} };
	};
	function saveSettings(snapshot) {
		if (!snapshot || typeof snapshot !== "object") return;
		const values = {}, secrets = {};
		for (const [k, v] of Object.entries(snapshot.values || {})) if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k)) values[k] = String(v ?? "").slice(0, MAX_VALUE);
		for (const [k, v] of Object.entries(snapshot.secrets || {})) if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k)) secrets[k] = v === "set" ? "set" : v === "expired" ? "expired" : "not set";
		atomic(settingsFile, JSON.stringify({ values, secrets }));
	}

	const keep = (sessionId, change) => { atomic(pendingFile(sessionId), JSON.stringify({ ...change, at: now().toISOString() })); return change; };
	const pending = (sessionId) => readJson(pendingFile(sessionId));
	const pendingRaw = (sessionId) => { const b = readBytes(pendingFile(sessionId)); return b ? b.toString("utf8") : null; };
	const discard = (sessionId) => { try { fs.rmSync(pendingFile(sessionId), { force: true }); } catch {} };

	function proposeAgent(sessionId, slug, { model, tools } = {}) {
		sid(sessionId);
		const cur = lib.get({ slug });
		if (model !== undefined && !MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(", ")}`);
		const input = { slug, create: false, description: cur.description, model: model ?? cur.model, tools: tools ?? cur.tools, body: cur.body, guardProfile: cur.guardProfile, dispatchable: cur.dispatchable };
		const p = lib.preview(input);
		if (!p.diff) throw new Error(`Nothing to write: ${p.checks.filter((c) => !c.ok).map((c) => c.text).join("; ") || "the agent already looks like that"}`);
		const what = [model !== undefined && model !== cur.model ? `model ${cur.model} -> ${model}` : "", tools ? `tools ${cur.tools.join(",")} -> ${tools.join(",")}` : ""].filter(Boolean).join(", ");
		return keep(sessionId, { type: "agent", slug, target: `agents/${slug}.md`, input, diff: p.diff, summary: `${slug}: ${what || "agent file"}` });
	}

	function proposeSettings(sessionId, pairs) {
		sid(sessionId);
		const { values } = settingsView();
		const next = {}, before = {}, lines = [];
		for (const pair of pairs) {
			const at = String(pair).indexOf("=");
			const key = at > 0 ? String(pair).slice(0, at) : "";
			const value = at > 0 ? String(pair).slice(at + 1) : "";
			if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`${key || pair} is not a setting Guild Master can change; run settings for the list`);
			if (value.length > MAX_VALUE) throw new Error(`${key} is longer than ${MAX_VALUE} characters`);
			if (values[key] === value) continue;
			next[key] = value;
			before[key] = values[key];
			lines.push(`- ${key}: ${values[key]}`, `+ ${key}: ${value}`);
		}
		if (!lines.length) throw new Error("Nothing changes");
		return keep(sessionId, { type: "settings", target: "DOCK settings", values: next, before, diff: `--- DOCK settings\n+++ DOCK settings\n${lines.join("\n")}`, summary: `Settings: ${Object.keys(next).join(", ")}` });
	}

	function proposeRollback(sessionId, id) {
		sid(sessionId);
		const entry = view().find((e) => e.id === Number(id));
		if (!entry) throw new Error(`No manager log entry #${id}`);
		if (entry.rolledBack) throw new Error(`#${entry.id} is already rolled back`);
		return keep(sessionId, { type: "rollback", rollbackOf: entry.id, target: entry.target, ...(entry.restoreValues ? { values: entry.restoreValues } : {}), diff: `restore ${entry.target} from ${entry.backup}`, summary: `Rollback of #${entry.id} (${entry.summary})` });
	}

	// A backed-up agent file is written back only when it still is that agent: same name, same hooks, and for a kit agent the same tools.
	function checkAgentBytes(slug, bytes) {
		const next = agentsLib.parse(bytes.toString("utf8"));
		const cur = agentsLib.parse(readBytes(agentFile(slug))?.toString("utf8") ?? "");
		const field = (doc, k) => (doc.fields[k] ? String(doc.fields[k].value).trim() : "");
		if (field(next, "name") !== slug) throw new Error(`The backup is not the agent ${slug}`);
		if (next.hooksText.replace(/\r/g, "") !== cur.hooksText.replace(/\r/g, "")) throw new Error("The backup has other hooks than the agent; it was not restored");
		if (next.hooksText && !agentsLib.hooksClosed(next.hooksText)) throw new Error("The backup has hooks that do not fail closed");
		let kit = false;
		try { kit = lib.get({ slug }).source === "kit"; } catch {}
		if (kit && field(next, "tools") !== field(cur, "tools")) throw new Error("A kit agent keeps its tools; the backup was not restored");
		const tools = field(next, "tools").split(",").map((t) => t.trim()).filter(Boolean);
		if (tools.some((t) => !/^[A-Za-z][A-Za-z0-9_:.-]{0,119}$/.test(t))) throw new Error("The backup lists a tool that is not a tool name");
	}
	const checkAllowBytes = (bytes) => {
		const list = JSON.parse(bytes.toString("utf8"));
		if (!Array.isArray(list) || list.some((s) => typeof s !== "string" || !SLUG.test(s))) throw new Error("The agents-allow.json backup is not a list of slugs");
	};

	// The entry must carry apply()'s signature, and its backups must still be the bytes apply() saved.
	function verified(entry, key) {
		const raw = entries().find((e) => e.id === entry.id);
		const refused = new Error(`#${entry.id} was not written by Guild Master and cannot be rolled back`);
		if (!key || !raw || typeof raw.mac !== "string" || raw.mac.length !== 64) throw refused;
		if (!crypto.timingSafeEqual(Buffer.from(raw.mac), Buffer.from(mac(key, raw)))) throw refused;
		const bytes = backupBytes(raw.backup);
		if (sha256(bytes) !== raw.backupSha) throw new Error(`The backup of #${entry.id} changed since it was written`);
		const allow = raw.allowBackup ? backupBytes(raw.allowBackup) : null;
		if (allow && sha256(allow) !== raw.allowSha) throw new Error(`The allow-list backup of #${entry.id} changed since it was written`);
		return { raw, bytes, allow };
	}

	async function restore(entry, { by, sessionId, settings, key, confirm }) {
		const { raw, bytes, allow } = verified(entry, key);
		let saved, savedAllow = null;
		if (raw.type === "agent") {
			checkAgentBytes(raw.slug, bytes);
			if (allow) checkAllowBytes(allow);
			const file = agentFile(raw.slug);
			saved = backup(readBytes(file) ?? Buffer.alloc(0), raw.slug);
			if (allow) savedAllow = backup(readBytes(allowFile) ?? Buffer.from("[]\n"), "agents-allow");
			await settings.confirm(confirm);
			atomic(file, bytes);
			if (allow) atomic(allowFile, allow);
		} else if (raw.type === "settings") {
			const values = JSON.parse(bytes.toString("utf8"));
			const current = (await settings.get()).values || {};
			saved = backup(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(values).map((k) => [k, current[k] ?? ""])))), "settings");
			await settings.put(values, confirm);
		} else throw new Error(`Entry #${raw.id} cannot be rolled back`);
		return append({ by, sessionId, kind: "rollback", type: raw.type, ...(raw.slug ? { slug: raw.slug } : {}), target: raw.target, summary: `Rollback of #${raw.id} (${raw.summary})`, ...saved, ...(savedAllow ? { allowBackup: savedAllow.backup, allowSha: savedAllow.backupSha } : {}), rollbackOf: raw.id }, key);
	}

	// confirm: { sessionId, nonce, sha256 }, which DOCK consumes on the write (settings.confirm, or settings.put for settings).
	async function rollback({ id, by = "owner", sessionId = null, settings, key, confirm }) {
		const entry = view().find((e) => e.id === Number(id));
		if (!entry) return { ok: false, error: `No manager log entry #${id}` };
		if (entry.rolledBack) return { ok: false, error: `#${entry.id} is already rolled back` };
		try { return { ok: true, entry: await restore(entry, { by, sessionId, settings, key, confirm }) }; } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
	}

	// The only path that writes a pending change. gmConfirm comes from DOCK: { nonce, sha256 of the pending file DOCK showed, exp }.
	async function apply({ sessionId, gmConfirm, key, by = "owner", settings }) {
		const c = gmConfirm && typeof gmConfirm === "object" ? gmConfirm : null;
		if (!c || typeof c.nonce !== "string" || !c.nonce || typeof c.sha256 !== "string") return { ok: false, error: "No confirmation from DOCK, so nothing was written" };
		if (!(Number(c.exp) > now().getTime())) return { ok: false, error: "The confirmation expired, so nothing was written" };
		if (!key) return { ok: false, error: "DOCK sent no log key, so nothing was written" };
		const raw = pendingRaw(sessionId);
		discard(sessionId);
		if (!raw) return { ok: false, error: "No change was waiting for a yes" };
		if (sha256(raw) !== c.sha256) return { ok: false, error: "The change waiting is not the one DOCK showed the owner, so nothing was written" };
		const change = JSON.parse(raw);
		const confirm = { sessionId, nonce: c.nonce, sha256: c.sha256 };
		try {
			if (change.type === "rollback") return await rollback({ id: change.rollbackOf, by, sessionId, settings, key, confirm });
			if (change.type === "agent") {
				if (lib.preview(change.input).diff !== change.diff) return { ok: false, error: "The agent changed since the proposal; ask again" };
				const file = agentFile(change.slug);
				const saved = backup(readBytes(file) ?? Buffer.alloc(0), change.slug);
				const allow = backup(readBytes(allowFile) ?? Buffer.from("[]\n"), "agents-allow");
				await settings.confirm(confirm);
				const r = lib.put(change.input);
				if (!r.ok) return { ok: false, error: r.error };
				return { ok: true, entry: append({ by, sessionId, kind: "change", type: "agent", slug: change.slug, target: change.target, summary: change.summary, diff: r.diff, ...saved, allowBackup: allow.backup, allowSha: allow.backupSha }, key) };
			}
			if (change.type === "settings") {
				const current = (await settings.get()).values || {};
				const saved = backup(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(change.values).map((k) => [k, current[k] ?? ""])))), "settings");
				await settings.put(change.values, confirm);
				return { ok: true, entry: append({ by, sessionId, kind: "change", type: "settings", target: change.target, summary: change.summary, diff: change.diff, ...saved }, key) };
			}
			return { ok: false, error: "Unknown pending change" };
		} catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
	}

	const listAgents = () => lib.list().map(({ slug, source, model, tools }) => ({ slug, source, model, tools }));
	const agent = (slug) => { const a = lib.get({ slug }); return { slug: a.slug, source: a.source, description: a.description, model: a.model, tools: a.tools, locked: a.locked }; };

	return { entries, view, listAgents, agent, saveSettings, settingsView, proposeAgent, proposeSettings, proposeRollback, pending, pendingRaw, discard, apply, rollback, backupBytes, agentFile, root };
}

const USAGE = "ops: agents | agent <slug> | propose-agent <slug> [--model m] [--tools a,b] | settings | propose-settings <key>=<value>... | propose-rollback <log id> | log | backups | pending";
const waiting = (c) => `${c.diff}\n\nPending: ${c.summary}. Nothing is written until the owner answers "ya" in this chat.`;

function cli(argv, { gm = createGm(), env = process.env, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
	const [op, ...rest] = argv;
	const session = env.DOCK_GM_SESSION;
	const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
	if (op === "agents") return out(JSON.stringify(gm.listAgents(), null, 1));
	if (op === "agent") return out(JSON.stringify(gm.agent(rest[0]), null, 1));
	if (op === "settings") return out(JSON.stringify(gm.settingsView(), null, 1));
	if (op === "log") return out(JSON.stringify(gm.view().slice(0, 30).map(({ diff, ...e }) => e), null, 1));
	if (op === "backups") return out(JSON.stringify(gm.view().filter((e) => e.backup).slice(0, 30).map((e) => ({ id: e.id, target: e.target, backup: e.backup, rolledBack: e.rolledBack })), null, 1));
	if (op === "pending") { const p = gm.pending(session); return out(p ? waiting(p) : "Nothing is pending."); }
	if (op === "propose-agent") {
		const tools = flag("--tools");
		return out(waiting(gm.proposeAgent(session, rest[0], { model: flag("--model"), tools: tools === undefined ? undefined : tools.split(",").map((t) => t.trim()).filter(Boolean) })));
	}
	if (op === "propose-settings") return out(waiting(gm.proposeSettings(session, rest)));
	if (op === "propose-rollback") return out(waiting(gm.proposeRollback(session, rest[0])));
	throw new Error(USAGE);
}

module.exports = { createGm, cli, sha256 };

if (require.main === module) {
	try { cli(process.argv.slice(2)); } catch (e) { process.stderr.write(`gm: ${e.message}\n`); process.exitCode = 1; }
}
