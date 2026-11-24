// Guild Master ops for a DOCK session in gm mode. dock-chat.cjs starts that session with DOCK_GM=1, and guard.cjs lets it run nothing else.
//   node gm.cjs agents                                   every agent: slug, source, model, tools
//   node gm.cjs agent <slug>                             one agent: description, model, tools
//   node gm.cjs propose-agent <slug> [--model m] [--tools a,b]   prints the diff and keeps it as this session's pending change
//   node gm.cjs settings                                 the DOCK settings it may change; secrets only as set / not set
//   node gm.cjs propose-settings <key>=<value>...        prints the diff and keeps it as this session's pending change
//   node gm.cjs propose-rollback <log id>                a rollback, pending like any change
//   node gm.cjs skills | skill <path>                    the editable skill text files; one file with line numbers
//   node gm.cjs propose-skill <path> --find <base64> --replace <base64> | --delete   one exact, unique snippet of a skill file replaced
//   node gm.cjs party <KEY>                              the ticket's Scout fields, Party mode, worker model, log number and AC count; no free text
//   node gm.cjs propose-party <KEY> --mode light|full [--worker sonnet|haiku|opus]
//   node gm.cjs cron | propose-cron <key>=<value>...      the orchestrator cron fields DOCK lets it change
//   node gm.cjs propose-allow add|remove <slug>          a custom agent on or off kit/agents-allow.json
//   node gm.cjs propose-guard-draft --profile p --rule allow|deny --on read|write|bash --path p [--why words]   a draft only, never installed
//   node gm.cjs usage [KEY]                              per-ticket tokens, cost, agents and gate failures DOCK sent with the turn
//   node gm.cjs log | backups | pending
// No op of the command line writes a target. apply() writes the pending change only with DOCK's one-use nonce for the owner's "ya" to
// the proposal DOCK showed (its sha256), and DOCK consumes that nonce before the write. Backups come first; log entries are signed with
// the key DOCK hands the bridge, so only entries apply() wrote can be rolled back. One manager log per machine for every gm session.
// State: <DOCK_KIT_STATE_DIR or kit>/gm/{log.jsonl, backups/, pending/, settings.json, data.json, drafts/}.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const agentsLib = require("./agents.cjs");
const skillsLib = require("./skills-edit.cjs");
const kitMergeLib = require("./kit-merge.cjs");
const { resolvePaths } = require("./paths.cjs");

const SESSION = /^[A-Za-z0-9-]{1,64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const TICKET = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const PARTY_WORKERS = ["sonnet", "haiku", "opus"];
const PARTY_LINE = /^(mode|worker|verify|skip|by): [A-Za-z0-9 ,.()#-]{1,120}$/;
const plainLine = (t) => String(t).replace(/[^A-Za-z0-9 \u00b7~,.:+()#>\u2192\/-]/g, "").trim().slice(0, 160);
const BACKUP = /^[A-Za-z0-9.-]{1,80}\.bak$/;
const MODELS = ["haiku", "sonnet", "opus", "inherit"];
const MAX_VALUE = 2000;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function createGm({ stateDir = process.env.DOCK_KIT_STATE_DIR || __dirname, configDir = resolvePaths().configDir, kitDir = __dirname, evidence = process.env.QONFLO_EVIDENCE || resolvePaths().evidence, agents, skills, kitMerge, now = () => new Date() } = {}) {
	const root = path.join(stateDir, "gm");
	const logFile = path.join(root, "log.jsonl");
	const lockFile = path.join(root, "log.lock");
	const backups = path.join(root, "backups");
	const settingsFile = path.join(root, "settings.json");
	const dataFile = path.join(root, "data.json");
	const drafts = path.join(root, "drafts");
	const allowFile = path.join(kitDir, "agents-allow.json");
	const lib = agents || agentsLib.createAgents({ configDir, kitDir });
	const skillLib = skills || skillsLib.createSkills({ configDir });
	const mergeLib = kitMerge || kitMergeLib.createKitMerge({ configDir, now });
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
	// write(id), when given, runs under the same lock before the line, so a file can name the log entry that wrote it; the fields it
	// returns are signed with the entry. A write that throws leaves no line.
	function append(entry, key, write) {
		return withLock(() => {
			const id = entries().reduce((m, e) => Math.max(m, e.id), 0) + 1;
			const extra = write ? write(id) : null;
			const row = { id, at: now().toISOString(), ...entry, ...(extra || {}) };
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
		if (e.type !== "settings" && e.type !== "cron") return null;
		try { const v = JSON.parse(backupBytes(e.backup).toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
	};
	const macOk = (row, key) => Boolean(key) && typeof row.mac === "string" && row.mac.length === 64 && crypto.timingSafeEqual(Buffer.from(row.mac), Buffer.from(mac(key, row)));
	// With the log key, an entry whose signature does not hold is marked unverified; without it, only an entry with no signature at all.
	function view(key) {
		const rows = entries();
		const rolled = new Set(rows.filter((e) => Number.isInteger(e.rollbackOf)).map((e) => e.rollbackOf));
		return rows.reverse().map((row) => {
			const { mac: _mac, ...e } = row;
			return { ...e, rolledBack: rolled.has(e.id), restoreValues: restoreValues(e), unverified: key ? !macOk(row, key) : !(typeof row.mac === "string" && row.mac.length === 64) };
		});
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

	// What DOCK sent with the turn besides settings: the cron fields it may change and the usage numbers. Text is cut to plain words.
	const clean = (v, depth = 0) => {
		if (typeof v === "number") return Number.isFinite(v) ? v : null;
		if (typeof v === "boolean" || v === null) return v;
		if (typeof v === "string") return v.replace(/[^A-Za-z0-9 _.,:\/@+%#()-]/g, "").slice(0, 120);
		if (depth > 4) return null;
		if (Array.isArray(v)) return v.slice(0, 40).map((x) => clean(x, depth + 1));
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k)).slice(0, 40).map(([k, x]) => [k, clean(x, depth + 1)]));
		return null;
	};
	function saveData(snapshot) {
		if (!snapshot || typeof snapshot !== "object") return;
		const cron = snapshot.cron && typeof snapshot.cron === "object" && snapshot.cron.values && typeof snapshot.cron.values === "object" ? snapshot.cron.values : {};
		const values = Object.fromEntries(Object.entries(cron).filter(([k]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k)).map(([k, v]) => [k, String(v ?? "").slice(0, 200)]));
		atomic(dataFile, JSON.stringify({ cron: { values }, usage: Array.isArray(snapshot.usage) ? clean(snapshot.usage) : [] }));
	}
	const dataView = () => {
		const d = readJson(dataFile);
		return { cron: { values: d && d.cron && d.cron.values && typeof d.cron.values === "object" ? d.cron.values : {} }, usage: d && Array.isArray(d.usage) ? d.usage : [] };
	};

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

	// One exact snippet of a skill file, found once, replaced. Only the snippet pair and the file's hash wait, so a 100 KB file fits.
	const b64 = (v, name) => {
		if (typeof v !== "string" || !/^[A-Za-z0-9+\/_=-]{1,200000}$/.test(v)) throw new Error(`${name} is the base64 of the text`);
		return Buffer.from(v, "base64").toString("utf8");
	};
	function skillEdit(rel, find, replace) {
		const cur = skillLib.get({ path: rel });
		const text = cur.text.replace(/\r\n/g, "\n");
		const at = find === "" ? -1 : text.indexOf(find);
		if (at < 0) throw new Error(`The --find text is not in skills/${cur.path}; run skill ${cur.path} and copy it exactly`);
		if (text.indexOf(find, at + 1) >= 0) throw new Error("The --find text is in the file more than once; make it longer so it is unique");
		const next = text.slice(0, at) + replace + text.slice(at + find.length);
		return { rel: cur.path, before: cur.text, next, diff: skillLib.preview({ path: cur.path, text: next }).diff };
	}
	function proposeSkill(sessionId, rel, { find, replace, remove = false } = {}) {
		sid(sessionId);
		const f = b64(find, "--find");
		const r = remove ? "" : b64(replace, "--replace");
		const e = skillEdit(rel, f, r);
		if (!e.diff) throw new Error("Nothing changes");
		return keep(sessionId, { type: "skill", path: e.rel, target: `skills/${e.rel}`, find: f, replace: r, beforeSha: sha256(Buffer.from(e.before)), diff: e.diff, summary: `skills/${e.rel}: ${e.diff.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length} lines` });
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

	// What the owner reads for an empty cron field: no labels takes any ticket, no end date runs on.
	const cronShow = (key, value) => (value !== "" ? value : key === "labels" ? "(any ticket)" : key === "activeUntil" ? "(no end)" : key === "activeFrom" ? "(no start)" : "");
	function proposeCron(sessionId, pairs) {
		sid(sessionId);
		const { values } = dataView().cron;
		const next = {}, before = {}, lines = [];
		for (const pair of pairs) {
			const at = String(pair).indexOf("=");
			const key = at > 0 ? String(pair).slice(0, at) : "";
			const value = at > 0 ? String(pair).slice(at + 1) : "";
			if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`${key || pair} is not a cron field Guild Master can change; run cron for the list`);
			if (value.length > 200) throw new Error(`${key} is longer than 200 characters`);
			if (key === "labels" && value.trim() === "") throw new Error("Clearing the labels makes the cron take any ticket; only the owner does that, in the Cron dialog");
			if (values[key] === value) continue;
			next[key] = value;
			before[key] = values[key];
			lines.push(`- ${key}: ${cronShow(key, values[key])}`, `+ ${key}: ${cronShow(key, value)}`);
		}
		if (!lines.length) throw new Error("Nothing changes");
		return keep(sessionId, { type: "cron", target: "Cron settings", values: next, before, diff: `--- Cron settings\n+++ Cron settings\n${lines.join("\n")}`, summary: `Cron: ${Object.keys(next).join(", ")}` });
	}

	// A ticket's board, from its key and the ledger's board (an epic key); never from a path the ledger holds.
	const contractFile = (key) => {
		if (!TICKET.test(String(key))) throw new Error("A ticket key looks like QRD-1542");
		const ledger = readJson(path.join(evidence, key, "status.json"));
		const epic = ledger && typeof ledger.board === "string" && TICKET.test(ledger.board) ? ledger.board : null;
		return path.join(evidence, "blackboard", ...(epic ? [epic, "tickets", key] : [key]), "materials", "contract.md");
	};
	// The "## Party" block of contract.md: its field lines right under the heading and the line range they take.
	const partyAt = (text) => {
		const lines = String(text || "").split(/\r?\n/);
		const start = lines.findIndex((l) => /^## Party\s*$/.test(l));
		if (start < 0) return { lines, start: -1, end: -1, party: null };
		let end = start + 1;
		while (end < lines.length && /^(mode|worker|verify|skip|by):/.test(lines[end].trim())) end++;
		return { lines, start, end, party: lines.slice(start + 1, end).map((l) => l.trim()) };
	};
	// Only the block's own lines change (or the block is appended); every other line and the file's line ending stay.
	const withParty = (text, party) => {
		const eol = /\r\n/.test(text) ? "\r\n" : "\n";
		const at = partyAt(text);
		const block = party ? ["## Party", ...party] : [];
		if (at.start >= 0) return [...at.lines.slice(0, at.start), ...block, ...at.lines.slice(at.end)].join(eol);
		if (!party) return text;
		const body = text === "" ? "" : /\r?\n$/.test(text) ? text : `${text}${eol}`;
		return `${body}${body ? eol : ""}${block.join(eol)}${eol}`;
	};
	// A Party has two choices only: the runner (light or full) and, for light, the worker model. Gates stay with the owner's Light settings.
	const partyFields = (lines) => {
		const get = (re) => { for (const l of lines || []) { const m = re.exec(l); if (m) return m[1]; } return null; };
		const mode = get(/^mode: (light|full)$/);
		const log = get(/^by: Guild Master, log #(\d{1,9})$/);
		return { mode, worker: mode === "light" ? get(/^worker: sous-ticket-worker \((sonnet|haiku|opus)\)$/) : null, log: log ? Number(log) : null };
	};
	const partyLines = (mode, worker) => (mode === "light" ? ["mode: light", `worker: sous-ticket-worker (${worker || "sonnet"})`] : ["mode: full"]);
	const scoutFields = (line) => {
		const m = /^Scout: (BE|FE|BE \+ FE|FE \+ BE) · ~(\d{1,5}) files · (no contract change|contract change)(?: → (light|full))?/.exec(String(line || ""));
		return m ? { repos: m[1], files: Number(m[2]), contractChange: m[3] === "contract change", verdict: m[4] || null } : null;
	};
	function partyView(key) {
		const file = contractFile(key);
		const text = readBytes(file)?.toString("utf8") ?? null;
		const scout = text ? text.split(/\r?\n/).reverse().find((l) => /^Scout: /.test(l)) : null;
		const ac = readBytes(path.join(path.dirname(path.dirname(file)), "ac.txt"));
		const party = text ? partyAt(text).party : null;
		return { key, contract: text !== null, scout: scout ? scoutFields(scout) : null, party: party ? partyFields(party) : null, acLines: ac ? ac.toString("utf8").split(/\r?\n/).filter((l) => l.trim()).length : null };
	}
	const partyDiff = (key, text, party) => {
		const old = text !== null ? partyAt(text).party || [] : [];
		const s = partyView(key).scout;
		return [`contract > Party (${key})`, `  ${s ? `Scout: ${s.repos} · ~${s.files} files · ${s.contractChange ? "contract change" : "no contract change"}${s.verdict ? ` → ${s.verdict}` : ""}` : "no Scout line yet"}`,
			...old.map((l) => `- ${plainLine(l)}`), ...party.map((l) => `+ ${l}`), "+ by: Guild Master, log #<on write>"].join("\n");
	};
	function proposeParty(sessionId, key, { mode, worker } = {}) {
		sid(sessionId);
		if (!["light", "full"].includes(mode)) throw new Error("--mode must be light or full");
		if (worker !== undefined && !PARTY_WORKERS.includes(worker)) throw new Error(`--worker must be one of ${PARTY_WORKERS.join(", ")}`);
		if (mode === "full" && worker !== undefined) throw new Error("A full Party runs every agent as usual; --worker is for mode light");
		const party = partyLines(mode, worker);
		const cur = readBytes(contractFile(key));
		const text = cur ? cur.toString("utf8") : null;
		const old = text !== null ? partyAt(text).party || [] : [];
		if (JSON.stringify(old.filter((l) => !/^by: /.test(l))) === JSON.stringify(party)) throw new Error(`The Party of ${key} already reads like that`);
		return keep(sessionId, { type: "party", key, target: `blackboard ${key} materials/contract.md`, mode, worker: mode === "light" ? worker || "sonnet" : null, party, beforeSha: sha256(cur ?? Buffer.alloc(0)), diff: partyDiff(key, text, party), summary: `Party ${key}: ${mode}` });
	}

	// The allow-list change and every check behind it; run again on apply, so a change made since the proposal is refused.
	function allowPlan(action, slug) {
		if (action !== "add" && action !== "remove") throw new Error("propose-allow add|remove <slug>");
		const a = lib.get({ slug });
		if (a.source !== "custom") throw new Error(`${slug} is a kit agent; sous-guard.cjs decides who dispatches it`);
		const cur = readJson(allowFile);
		const list = Array.isArray(cur) ? cur.filter((s) => typeof s === "string" && SLUG.test(s)).sort() : [];
		if (action === "add" && !(a.guardProfile && a.hasHooks)) throw new Error(`${slug} has no guard profile with hooks, so a runner could not dispatch it anyway`);
		if (action === "add" && String(a.hooksText || "").replace(/\r/g, "").replace(/[ \t]+$/gm, "") !== agentsLib.hooksFor(a.guardProfile)) throw new Error(`${slug} has hooks other than the ${a.guardProfile} profile's own; it stays off the allow-list`);
		if ((action === "add") === list.includes(slug)) throw new Error(`${slug} is ${action === "add" ? "already" : "not"} in agents-allow.json`);
		const next = [...new Set(action === "add" ? [...list, slug] : list.filter((s) => s !== slug))].sort();
		return { list: next, old: list, diff: `--- kit/agents-allow.json\n+++ kit/agents-allow.json\n${action === "add" ? "+" : "-"} ${slug}` };
	}
	function proposeAllow(sessionId, action, slug) {
		sid(sessionId);
		const p = allowPlan(action, slug);
		return keep(sessionId, { type: "allow", action, slug, target: "kit/agents-allow.json", ...p, summary: `agents-allow.json: ${action} ${slug}` });
	}

	// A guard rule is never installed by Guild Master. The draft goes to gm/drafts for the owner; loosening or tightening, same path.
	function draftPlan({ profile, rule, on, at, why = "" } = {}) {
		if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(profile || ""))) throw new Error("--profile is a guard profile name");
		if (rule !== "allow" && rule !== "deny") throw new Error("--rule must be allow or deny");
		if (!["read", "write", "bash"].includes(on)) throw new Error("--on must be read, write or bash");
		if (!/^[A-Za-z0-9_.:\/@+-]{1,200}$/.test(String(at || "")) || /(^|\/)\.\.?(\/|$)/.test(at)) throw new Error("--path is one plain path");
		const draft = { kind: "guard-draft", installed: false, profile, rule, on, path: at, change: rule === "allow" ? "loosens" : "tightens", why: plainLine(why) };
		const diff = [`--- guard draft (${draft.change}, not installed)`, `+ profile: ${profile}`, `+ ${rule} ${on}: ${at}`, ...(draft.why ? [`+ why: ${draft.why}`] : []), "The owner installs it by hand; Guild Master never does."].join("\n");
		return { draft, diff };
	}
	function proposeGuardDraft(sessionId, args = {}) {
		sid(sessionId);
		const { draft, diff } = draftPlan(args);
		return keep(sessionId, { type: "guard-draft", target: "gm/drafts (not installed)", draft, diff, summary: `Guard draft, ${draft.change}: ${draft.profile} ${draft.rule} ${draft.on} ${draft.path}` });
	}

	function proposeRollback(sessionId, id) {
		sid(sessionId);
		const entry = view().find((e) => e.id === Number(id));
		if (!entry) throw new Error(`No manager log entry #${id}`);
		if (entry.rolledBack) throw new Error(`#${entry.id} is already rolled back`);
		if (entry.type === "guard-draft") throw new Error("A guard draft was never installed; there is nothing to roll back");
		return keep(sessionId, { type: "rollback", rollbackOf: entry.id, target: entry.target, ...(entry.restoreValues ? { [entry.type === "cron" ? "cron" : "values"]: entry.restoreValues } : {}), diff: `restore ${entry.target} from ${entry.backup}`, summary: `Rollback of #${entry.id} (${entry.summary})` });
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
	const checkSkillBytes = (bytes) => {
		if (bytes.length > skillsLib.MAX_BYTES || bytes.includes(0)) throw new Error("The skill backup is not a text file of at most 100 KB");
	};
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
		} else if (raw.type === "settings" || raw.type === "cron") {
			const values = JSON.parse(bytes.toString("utf8"));
			const cron = raw.type === "cron";
			const current = (await (cron ? settings.getCron() : settings.get())).values || {};
			saved = backup(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(values).map((k) => [k, current[k] ?? ""])))), raw.type);
			await (cron ? settings.putCron(values, confirm) : settings.put(values, confirm));
		} else if (raw.type === "party") {
			const file = contractFile(raw.ticket);
			const party = partyAt(bytes.toString("utf8")).party;
			if (party && party.some((l) => !PARTY_LINE.test(l))) throw new Error("The backup's Party block has lines a Party does not have; it was not restored");
			const cur = readBytes(file);
			saved = backup(cur ?? Buffer.alloc(0), `contract-${raw.ticket}`);
			await settings.confirm(confirm);
			atomic(file, withParty(cur ? cur.toString("utf8") : "", party));
		} else if (raw.type === "skill") {
			checkSkillBytes(bytes);
			const { file } = skillLib.fileOf(raw.path);
			saved = backup(readBytes(file) ?? Buffer.alloc(0), "skill");
			await settings.confirm(confirm);
			atomic(file, bytes);
		} else if (raw.type === "allow") {
			checkAllowBytes(bytes);
			saved = backup(readBytes(allowFile) ?? Buffer.from("[]\n"), "agents-allow");
			await settings.confirm(confirm);
			atomic(allowFile, bytes);
		} else throw new Error(`Entry #${raw.id} cannot be rolled back`);
		return append({ by, sessionId, kind: "rollback", type: raw.type, ...(raw.slug ? { slug: raw.slug } : {}), ...(raw.path ? { path: raw.path } : {}), ...(raw.ticket ? { ticket: raw.ticket } : {}), target: raw.target, summary: `Rollback of #${raw.id} (${raw.summary})`, ...saved, ...(savedAllow ? { allowBackup: savedAllow.backup, allowSha: savedAllow.backupSha } : {}), rollbackOf: raw.id }, key);
	}

	// confirm: { sessionId, nonce, sha256 }, which DOCK consumes on the write (settings.confirm, or settings.put for settings).
	async function rollback({ id, by = "owner", sessionId = null, settings, key, confirm }) {
		const entry = view().find((e) => e.id === Number(id));
		if (!entry) return { ok: false, error: `No manager log entry #${id}` };
		if (entry.rolledBack) return { ok: false, error: `#${entry.id} is already rolled back` };
		if (entry.type === "guard-draft") return { ok: false, error: "A guard draft was never installed; there is nothing to roll back" };
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
			if (change.type === "skill") {
				const e = skillEdit(change.path, change.find, change.replace);
				if (sha256(Buffer.from(e.before)) !== change.beforeSha || e.diff !== change.diff) return { ok: false, error: "The skill file changed since the proposal; ask again" };
				return await writeSkill({ rel: e.rel, text: e.next, by, sessionId, key, confirm, settings, summary: change.summary });
			}
			if (change.type === "settings") {
				const current = (await settings.get()).values || {};
				const saved = backup(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(change.values).map((k) => [k, current[k] ?? ""])))), "settings");
				await settings.put(change.values, confirm);
				return { ok: true, entry: append({ by, sessionId, kind: "change", type: "settings", target: change.target, summary: change.summary, diff: change.diff, ...saved }, key) };
			}
			if (change.type === "cron") {
				const current = (await settings.getCron()).values || {};
				const saved = backup(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(change.values).map((k) => [k, current[k] ?? ""])))), "cron");
				await settings.putCron(change.values, confirm);
				return { ok: true, entry: append({ by, sessionId, kind: "change", type: "cron", target: change.target, summary: change.summary, diff: change.diff, ...saved }, key) };
			}
			if (change.type === "party") {
				const file = contractFile(change.key);
				const party = partyLines(change.mode, change.worker || undefined);
				const before = readBytes(file);
				const text = before ? before.toString("utf8") : null;
				if (JSON.stringify(party) !== JSON.stringify(change.party) || sha256(before ?? Buffer.alloc(0)) !== change.beforeSha || partyDiff(change.key, text, party) !== change.diff) return { ok: false, error: "The Party changed since the proposal; ask again" };
				const saved = backup(before ?? Buffer.alloc(0), `contract-${change.key}`);
				await settings.confirm(confirm);
				return { ok: true, entry: append({ by, sessionId, kind: "change", type: "party", ticket: change.key, target: change.target, summary: change.summary, diff: change.diff, ...saved }, key, (id) => {
					const cur = readBytes(file);
					if (sha256(cur ?? Buffer.alloc(0)) !== change.beforeSha) throw new Error("contract.md changed while the Party was written; nothing was written, ask again");
					const lines = [...party, `by: Guild Master, log #${id}`];
					atomic(file, withParty(cur ? cur.toString("utf8") : "", lines));
					return { party: lines };
				}) };
			}
			if (change.type === "allow") {
				const p = allowPlan(change.action, change.slug);
				if (p.diff !== change.diff || JSON.stringify(p.list) !== JSON.stringify(change.list) || JSON.stringify(p.old) !== JSON.stringify(change.old)) return { ok: false, error: "agents-allow.json changed since the proposal; ask again" };
				checkAllowBytes(Buffer.from(JSON.stringify(p.list)));
				const saved = backup(readBytes(allowFile) ?? Buffer.from("[]\n"), "agents-allow");
				await settings.confirm(confirm);
				atomic(allowFile, `${JSON.stringify(p.list, null, 2)}\n`);
				return { ok: true, entry: append({ by, sessionId, kind: "change", type: "allow", slug: change.slug, target: change.target, summary: change.summary, diff: p.diff, ...saved }, key) };
			}
			if (change.type === "guard-draft") {
				const d = change.draft || {};
				const p = draftPlan({ profile: d.profile, rule: d.rule, on: d.on, at: d.path, why: d.why });
				if (p.diff !== change.diff || JSON.stringify(p.draft) !== JSON.stringify(d)) return { ok: false, error: "The guard draft is not the one proposed; ask again" };
				await settings.confirm(confirm);
				let draft = "";
				const entry = append({ by, sessionId, kind: "change", type: "guard-draft", target: change.target, summary: change.summary, diff: p.diff }, key, (id) => {
					draft = `guard-${id}.json`;
					atomic(path.join(drafts, draft), `${JSON.stringify({ ...p.draft, installed: false, log: id }, null, 2)}\n`);
				});
				return { ok: true, entry: { ...entry, draft } };
			}
			return { ok: false, error: "Unknown pending change" };
		} catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
	}

	// Backup, DOCK's confirmation, the atomic write, then the signed log entry: the same order as an agent write, so rollback works.
	async function writeSkill({ rel, text, by, sessionId, key, confirm, settings, summary }) {
		const { file } = skillLib.fileOf(rel);
		const p = skillLib.preview({ path: rel, text });
		if (!p.diff) return { ok: false, error: "Nothing changes" };
		const saved = backup(readBytes(file) ?? Buffer.alloc(0), "skill");
		await settings.confirm(confirm);
		const r = skillLib.put({ path: rel, text });
		if (!r.ok) return { ok: false, error: r.error };
		return { ok: true, entry: append({ by, sessionId, kind: "change", type: "skill", path: rel, target: `skills/${rel}`, summary: summary || `skills/${rel}`, diff: r.diff, ...saved }, key) };
	}

	// The owner's save from DOCK's editor. DOCK minted the nonce for this path and this exact text (skillPutSha), so nothing else is written.
	async function putSkill({ path: rel, text, by = "owner (skill editor)", settings, key, nonce }) {
		if (!key) return { ok: false, error: "DOCK sent no log key, so nothing was written" };
		try {
			const { rel: clean } = skillLib.fileOf(rel);
			return await writeSkill({ rel: clean, text, by, sessionId: null, key, settings, confirm: { sessionId: null, nonce, sha256: skillPutSha(clean, text) } });
		} catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
	}

	// An install conflict settled from DOCK: keep local, take the kit version, or write the owner's merge. Every action is logged with a
	// backup of the local file; a merged agent file keeps the kit version's name, hooks and tools.
	function checkAgentMerge(rel, text, kit) {
		const slug = rel.slice("agents/".length, -3);
		const next = agentsLib.parse(text), ship = agentsLib.parse(kit);
		const field = (doc, k) => (doc.fields[k] ? String(doc.fields[k].value).trim() : "");
		if (field(next, "name") !== slug) throw new Error(`The merged file is not the agent ${slug}`);
		if (next.hooksText.replace(/\r/g, "") !== ship.hooksText.replace(/\r/g, "")) throw new Error("The merged agent must keep the kit version's hooks");
		if (field(next, "tools") !== field(ship, "tools")) throw new Error("The merged agent must keep the kit version's tools");
	}
	const relDiff = (rel, before, after) => agentsLib.unifiedDiff(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"), "x").replace(/^--- (?:a\/agents\/x|\/dev\/null)\n\+\+\+ b\/agents\/x\n/, `--- a/${rel}\n+++ b/${rel}\n`);
	async function resolveConflict({ path: rel, action, text, by = "owner (kit conflict)", settings, key, nonce }) {
		if (!key) return { ok: false, error: "DOCK sent no log key, so nothing was written" };
		try {
			const plan = mergeLib.resolvePlan({ path: rel, action, text });
			const agent = rel.startsWith("agents/");
			if (agent && plan.next !== null) checkAgentMerge(rel, plan.next, plan.kit);
			const saved = backup(readBytes(plan.file) ?? Buffer.alloc(0), agent ? rel.slice("agents/".length, -3) : "skill");
			await settings.confirm({ sessionId: null, nonce, sha256: resolveSha(rel, action, action === "edit" ? plan.next : null) });
			const report = mergeLib.resolveCommit(plan);
			const type = agent ? { type: "agent", slug: rel.slice("agents/".length, -3) } : { type: "skill", path: rel.slice("skills/".length) };
			const how = action === "local" ? "kept local" : action === "kit" ? "took the kit version" : "merged by hand";
			const entry = append({ by, sessionId: null, kind: "change", ...type, target: rel, summary: `Kit conflict ${rel}: ${how}`, diff: plan.next === null ? "" : relDiff(rel, plan.before ?? "", plan.next), ...saved }, key);
			return { ok: true, entry, report };
		} catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
	}

	const listAgents = () => lib.list().map(({ slug, source, model, tools }) => ({ slug, source, model, tools }));
	const agent = (slug) => { const a = lib.get({ slug }); return { slug: a.slug, source: a.source, description: a.description, model: a.model, tools: a.tools, locked: a.locked }; };

	return { entries, view, listAgents, agent, listSkills: () => skillLib.list(), skill: (rel) => skillLib.get({ path: rel }), proposeSkill, putSkill, resolveConflict, saveSettings, settingsView, saveData, dataView, proposeAgent, proposeSettings, proposeCron, partyView, proposeParty, proposeAllow, proposeGuardDraft, proposeRollback, partyBlock: (key) => { const b = readBytes(contractFile(key)); return b ? partyAt(b.toString("utf8")).party : null; }, partyFields, pending, pendingRaw, discard, apply, rollback, backupBytes, agentFile, contractFile, root };
}

// What DOCK's nonce is bound to for a write the owner clicks: the path and the sha256 of the exact text; for a conflict the action, and
// the text only for a hand merge (DOCK never holds the .kit-new text it did not send).
const skillPutSha = (rel, text) => `skill:${rel}:${sha256(Buffer.from(String(text), "utf8"))}`;
const resolveSha = (rel, action, text) => `kit-resolve:${rel}:${action}:${text === null || text === undefined ? "" : sha256(Buffer.from(String(text), "utf8"))}`;

const USAGE = "ops: agents | agent <slug> | propose-agent <slug> [--model m] [--tools a,b] | skills | skill <path> | propose-skill <path> --find <base64> --replace <base64> | --delete | settings | propose-settings <key>=<value>... | party <KEY> | propose-party <KEY> --mode light|full [--worker m] | cron | propose-cron <key>=<value>... | propose-allow add|remove <slug> | propose-guard-draft --profile p --rule allow|deny --on read|write|bash --path p [--why words] | usage [KEY] | propose-rollback <log id> | log | backups | pending";
const waiting = (c) => `${c.diff}\n\nPending: ${c.summary}. Nothing is written until the owner answers "ya" in this chat.`;

function cli(argv, { gm = createGm(), env = process.env, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
	const [op, ...rest] = argv;
	const session = env.DOCK_GM_SESSION;
	const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
	if (op === "agents") return out(JSON.stringify(gm.listAgents(), null, 1));
	if (op === "agent") return out(JSON.stringify(gm.agent(rest[0]), null, 1));
	if (op === "skills") return out(gm.listSkills().map((f) => f.path).join("\n") || "No skill files.");
	if (op === "skill") { const f = gm.skill(rest[0]); return out(`skills/${f.path}\n${f.text.replace(/\r\n/g, "\n").split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n")}`); }
	if (op === "propose-skill") return out(waiting(gm.proposeSkill(session, rest[0], { find: flag("--find"), replace: flag("--replace"), remove: rest.includes("--delete") })));
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
	if (op === "party") return out(JSON.stringify(gm.partyView(rest[0]), null, 1));
	if (op === "propose-party") return out(waiting(gm.proposeParty(session, rest[0], { mode: flag("--mode"), worker: flag("--worker") })));
	if (op === "cron") return out(JSON.stringify(gm.dataView().cron, null, 1));
	if (op === "propose-cron") return out(waiting(gm.proposeCron(session, rest)));
	if (op === "propose-allow") return out(waiting(gm.proposeAllow(session, rest[0], rest[1])));
	if (op === "propose-guard-draft") {
		const why = rest.indexOf("--why");
		return out(waiting(gm.proposeGuardDraft(session, { profile: flag("--profile"), rule: flag("--rule"), on: flag("--on"), at: flag("--path"), why: why >= 0 ? rest.slice(why + 1).join(" ") : "" })));
	}
	if (op === "usage") { const rows = gm.dataView().usage; return out(JSON.stringify(rest[0] ? rows.filter((r) => r && r.key === rest[0]) : rows, null, 1)); }
	throw new Error(USAGE);
}

module.exports = { createGm, cli, sha256, skillPutSha, resolveSha };

if (require.main === module) {
	try { cli(process.argv.slice(2)); } catch (e) { process.stderr.write(`gm: ${e.message}\n`); process.exitCode = 1; }
}
