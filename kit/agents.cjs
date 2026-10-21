// The agent files of this config dir (<config>/agents/*.md) for DOCK's agent library. dock-chat.cjs runs the ops DOCK hands out.
//   list {}             AgentItem[] sorted by slug
//   get { slug }        AgentItem + body, hooksText, kitBody
//   preview PutInput    { diff, checks } and writes nothing
//   put PutInput        { ok: true, diff } | { ok: false, error }
//   delete { slug }     { ok: true } | { ok: false, error }; custom agents only
// Kit agents are the files claude-config ships (its agents/ folder, the install record kit/agents-kit.json, the sous-guard runner list).
// They take body and model changes only. A custom agent's hooks are always generated from its guard profile, never typed, and runners
// may dispatch it only through kit/agents-allow.json. Writes are atomic (tmp + rename) and never leave <config>/agents.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");
const { AGENTS } = require("./sous-guard.cjs");

const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const MODELS = ["haiku", "sonnet", "opus", "inherit"];
const TOOL = /^[A-Za-z][A-Za-z0-9_:.-]{0,119}$/;
const MAX_TOOLS = 40;
const MAX_BODY = 100000;
const MAX_DESCRIPTION = 1000;
const LAUNCH = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/bin/kit-node" sous-guard.cjs';
const READ = "Read|Grep|Glob";
const WRITE = "Edit|Write|NotebookEdit";
const PROFILES = {
	read: { write: false, hooks: [[READ, "path --read @wt @evidence"], ["Bash", "bash @wt @evidence"]] },
	worktree: { write: true, hooks: [[READ, "path --read @wt @evidence"], [WRITE, "path @wt"], ["Bash", "bash @wt @evidence"]] },
	browser: { write: true, hooks: [[READ, "path --read @wt @evidence @shots"], [WRITE, "path @evidence"], ["Bash", "browser @wt @evidence @shots"]] },
	board: { write: true, hooks: [[READ, "path --read @wt @evidence @board"], [WRITE, "path @board"], ["Bash", "bash @wt @evidence @board"]] },
};
const BASE_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Skill", "TodoWrite"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_MCP = /^mcp__.+__(get|search|list|fetch|lookup|read)[A-Za-z0-9_]*$/i;

function hooksFor(profile) {
	const lines = ["hooks:", "  PreToolUse:"];
	for (const [matcher, args] of PROFILES[profile].hooks) {
		lines.push(`    - matcher: "${matcher}"`, "      hooks:", "        - type: command", `          command: '${LAUNCH} ${args} || exit 2'`);
	}
	return lines.join("\n");
}

const scalar = (v) => {
	const s = String(v || "").trim();
	if (s.startsWith('"')) { try { return String(JSON.parse(s)); } catch { return s.slice(1, -1); } }
	if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
	return s;
};
const quote = (s) => (/^[A-Za-z0-9(][^\n]*$/.test(s) && !/(: | #|["'`]|:$|\s$)/.test(s) ? s : JSON.stringify(s));

// Frontmatter without a YAML dependency: top-level `key: value` lines, indented lines belong to the key above (the hooks block).
function parse(raw) {
	const text = String(raw).replace(/\r\n/g, "\n");
	const m = /^---\n([\s\S]*?\n)?---(\n|$)/.exec(text);
	if (!m) return { lines: [], fields: {}, lead: "", body: text, hooksText: "", hasHooks: false, block: () => [] };
	const lines = m[1] ? m[1].replace(/\n$/, "").split("\n") : [];
	const fields = {};
	let cur = null;
	for (let i = 0; i < lines.length; i++) {
		const k = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(lines[i]);
		if (k) { cur = fields[k[1]] = { value: k[2].trim(), at: i, end: i }; continue; }
		if (cur && /^(\s|-)/.test(lines[i])) cur.end = i;
	}
	const rest = text.slice(m[0].length);
	const lead = /^\n*/.exec(rest)[0];
	const block = (f) => (f ? lines.slice(f.at, f.end + 1) : []);
	const hooksLines = block(fields.hooks);
	return { lines, fields, lead, body: rest.slice(lead.length), hooksText: hooksLines.join("\n"), hasHooks: hooksLines.some((l) => /^\s+command:/.test(l)), block };
}

function toolsOf(doc) {
	const f = doc.fields.tools;
	if (!f) return [];
	let items = f.value.startsWith("[") ? f.value.replace(/^\[|\]$/g, "").split(",") : f.value ? f.value.split(",") : doc.block(f).slice(1).map((l) => l.replace(/^\s*-\s*/, ""));
	items = items.map(scalar).filter(Boolean);
	return [...new Set(items)];
}

const profileOfHooks = (hooksText) => Object.keys(PROFILES).find((p) => hooksFor(p) === hooksText.replace(/[ \t]+$/gm, "")) || null;

// Every hook command of the block runs sous-guard.cjs and fails closed.
const hooksClosed = (hooksText) => {
	const commands = hooksText.split("\n").filter((l) => /^\s+command:/.test(l));
	return commands.length > 0 && commands.every((l) => l.includes("sous-guard.cjs") && /\|\| exit 2'$/.test(l.trim()));
};

function unifiedDiff(before, after, name) {
	if (before === after) return "";
	const split = (s) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
	const A = split(before), B = split(after);
	const n = A.length, m = B.length;
	const ops = [];
	if (n * m > 9e6) {
		for (const l of A) ops.push(["-", l]);
		for (const l of B) ops.push(["+", l]);
	} else {
		const w = m + 1, L = new Uint32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
		let i = 0, j = 0;
		while (i < n && j < m) {
			if (A[i] === B[j]) { ops.push([" ", A[i]]); i++; j++; }
			else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push(["-", A[i++]]);
			else ops.push(["+", B[j++]]);
		}
		while (i < n) ops.push(["-", A[i++]]);
		while (j < m) ops.push(["+", B[j++]]);
	}
	const oldAt = [0], newAt = [0];
	for (const [k] of ops) { oldAt.push(oldAt.at(-1) + (k === "+" ? 0 : 1)); newAt.push(newAt.at(-1) + (k === "-" ? 0 : 1)); }
	const out = [`--- ${before === "" ? "/dev/null" : `a/agents/${name}`}`, `+++ b/agents/${name}`];
	let i = 0;
	while (i < ops.length) {
		while (i < ops.length && ops[i][0] === " ") i++;
		if (i >= ops.length) break;
		const start = Math.max(0, i - 3);
		let end = i, j = i;
		while (j < ops.length) {
			if (ops[j][0] !== " ") { end = j++; continue; }
			let k = j;
			while (k < ops.length && ops[k][0] === " ") k++;
			if (k >= ops.length || k - j > 6) break;
			j = k;
		}
		const stop = Math.min(ops.length, end + 4);
		const oldLen = oldAt[stop] - oldAt[start], newLen = newAt[stop] - newAt[start];
		out.push(`@@ -${oldLen ? oldAt[start] + 1 : oldAt[start]},${oldLen} +${newLen ? newAt[start] + 1 : newAt[start]},${newLen} @@`);
		for (let x = start; x < stop; x++) out.push(ops[x][0] + ops[x][1]);
		i = stop;
	}
	return out.join("\n") + "\n";
}

function createAgents({ configDir = resolvePaths().configDir, kitDir = __dirname, repoDir, home = os.homedir() } = {}) {
	const dir = path.resolve(configDir, "agents");
	const allowFile = path.join(kitDir, "agents-allow.json");
	const recordFile = path.join(kitDir, "agents-kit.json");
	const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
	const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
	const fileOf = (slug) => {
		if (!SLUG.test(String(slug))) throw new Error("A slug is 2 to 48 lowercase letters, digits or dashes");
		const f = path.resolve(dir, `${slug}.md`);
		if (path.dirname(f) !== dir) throw new Error("That path is outside the agents folder");
		return f;
	};
	const atomic = (file, text) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, file);
	};

	// What claude-config shipped: the repo's agents/ folder when it is on this machine, else the install record.
	function shipped() {
		const record = readJson(recordFile) || {};
		const repo = [repoDir, record.repo, path.join(home, "claude-config")].find((d) => d !== null && d !== undefined && fs.existsSync(path.join(d, "agents")));
		const out = new Map();
		const kept = record.agents && typeof record.agents === "object" ? record.agents : {};
		for (const [slug, text] of Object.entries(kept)) if (SLUG.test(slug) && typeof text === "string") out.set(slug, text);
		if (repo) {
			let names = [];
			try { names = fs.readdirSync(path.join(repo, "agents")).filter((f) => f.endsWith(".md")); } catch {}
			for (const f of names) {
				const text = readText(path.join(repo, "agents", f));
				if (text !== null && SLUG.test(f.slice(0, -3))) out.set(f.slice(0, -3), text);
			}
		}
		return out;
	}
	const kitSet = (ship) => new Set([...ship.keys(), ...AGENTS]);
	const readAllow = () => { const a = readJson(allowFile); return Array.isArray(a) ? a.filter((s) => typeof s === "string" && SLUG.test(s)) : []; };
	function writeAllow(slug, on) {
		const now = readAllow().sort();
		const next = [...new Set(on ? [...now, slug] : now.filter((s) => s !== slug))].sort();
		if (JSON.stringify(next) !== JSON.stringify(now)) atomic(allowFile, JSON.stringify(next, null, 2) + "\n");
	}

	function item(slug, doc, kit, allow) {
		const kitAgent = kit.has(slug);
		const guard = scalar(doc.fields.guard ? doc.fields.guard.value : "");
		const guardProfile = kitAgent ? profileOfHooks(doc.hooksText) : PROFILES[guard] ? guard : null;
		return {
			slug,
			source: kitAgent ? "kit" : "custom",
			description: scalar(doc.fields.description ? doc.fields.description.value : ""),
			model: scalar(doc.fields.model ? doc.fields.model.value : "") || "inherit",
			tools: toolsOf(doc),
			guardProfile,
			hasHooks: doc.hasHooks,
			dispatchable: kitAgent ? AGENTS.has(slug) : Boolean(guardProfile && doc.hasHooks && allow.includes(slug)),
			locked: kitAgent ? { slug: true, tools: true, hooks: true } : { slug: true, tools: false, hooks: true },
		};
	}

	function list() {
		const kit = kitSet(shipped()), allow = readAllow();
		let names = [];
		try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && SLUG.test(f.slice(0, -3))); } catch {}
		return names.map((f) => f.slice(0, -3)).sort().map((slug) => item(slug, parse(readText(path.join(dir, `${slug}.md`)) || ""), kit, allow));
	}

	function get(input) {
		const slug = input && input.slug;
		const file = fileOf(slug);
		const text = readText(file);
		if (text === null) throw new Error(`No agent named ${slug}`);
		const ship = shipped();
		const doc = parse(text);
		const it = item(slug, doc, kitSet(ship), readAllow());
		const kitText = it.source === "kit" ? ship.get(slug) : undefined;
		return { ...it, body: doc.body, hooksText: doc.hooksText, kitBody: typeof kitText === "string" ? parse(kitText).body : null };
	}

	// The file put would write, the checks DOCK shows on review, and the first blocking problem.
	function plan(input) {
		const checks = [];
		const add = (ok, text, block = true) => { checks.push({ ok, text, block: block && !ok }); return ok; };
		if (!input || typeof input !== "object") throw new Error("An agent object is required");
		const slug = String(input.slug || "");
		const file = fileOf(slug);
		const model = MODELS.includes(input.model) ? input.model : null;
		const body = typeof input.body === "string" && input.body.length <= MAX_BODY ? input.body : null;
		const tools = Array.isArray(input.tools) ? [...new Set(input.tools)] : null;
		const profile = input.guardProfile === null || input.guardProfile === undefined ? null : PROFILES[input.guardProfile] ? input.guardProfile : undefined;
		const description = typeof input.description === "string" ? input.description.replace(/\s*[\r\n]+\s*/g, " ").trim() : "";
		const before = readText(file);
		const old = before === null ? "" : before.replace(/\r\n/g, "\n");
		const crlf = before !== null && before.includes("\r\n");
		const ship = shipped();
		const kit = kitSet(ship);
		const isKit = kit.has(slug) || (before === null && slug.startsWith("sous-"));
		let next = null, allowOn = null;

		add(model !== null, model ? `Model ${model}` : `model must be one of ${MODELS.join(", ")}`);
		add(body !== null, body !== null ? "Body is text" : `The body must be text of at most ${MAX_BODY} characters`);
		if (input.create === true) add(before === null && !isKit, before !== null ? `An agent named ${slug} already exists` : isKit ? `${slug} is a kit agent name; pick another slug` : `No agent named ${slug} yet: a new file agents/${slug}.md`);
		else add(before !== null, before !== null ? `Updates agents/${slug}.md` : `No agent named ${slug}`);

		if (isKit) {
			if (before !== null) {
				const doc = parse(old);
				const cur = item(slug, doc, kit, readAllow());
				const same = description === cur.description && tools !== null && [...tools].sort().join(",") === [...cur.tools].sort().join(",");
				add(same, same ? "Kit agent: slug, tools and hooks are kept byte for byte" : "Kit agents only take body and model changes");
				if (model !== null && body !== null && same) {
					const lines = doc.lines.slice();
					const f = doc.fields.model;
					if (f) { if (scalar(f.value) !== model) lines[f.at] = `model: ${model}`; }
					else if (model !== "inherit") {
						const after = doc.fields.description || doc.fields.name;
						lines.splice(after ? after.end + 1 : lines.length, 0, `model: ${model}`);
					}
					next = `---\n${lines.join("\n")}\n---\n${doc.lead || "\n"}${body}`;
				}
			}
			add(true, AGENTS.has(slug) ? "Kit agent: runners may dispatch it through sous-guard.cjs" : "Kit agent: not in the sous-guard.cjs runner list", false);
		} else {
			add(description !== "" && description.length <= MAX_DESCRIPTION, description ? (description.length <= MAX_DESCRIPTION ? "Frontmatter is valid: name, description, model and tools" : `The description is longer than ${MAX_DESCRIPTION} characters`) : "A description is required");
			add(profile !== undefined, profile === undefined ? `guardProfile must be one of ${Object.keys(PROFILES).join(", ")}, or empty` : "Guard profile is known");
			const bad = tools === null ? ["(not a list)"] : tools.filter((t) => typeof t !== "string" || !TOOL.test(t));
			const fits = (t) => BASE_TOOLS.has(t) || READ_MCP.test(t) || (WRITE_TOOLS.has(t) && (!profile || PROFILES[profile].write));
			const outside = bad.length ? [] : tools.filter((t) => !fits(t));
			if (bad.length || tools.length === 0 || tools.length > MAX_TOOLS) add(false, bad.length ? `Not a tool name: ${String(bad[0]).slice(0, 60)}` : tools.length ? `At most ${MAX_TOOLS} tools` : "Pick at least one tool");
			else add(!outside.length, outside.length ? `${outside.join(", ")} ${outside.length > 1 ? "are" : "is"} not allowed for ${profile ? `the ${profile} profile` : "a draft"}` : `Tools fit ${profile ? `the ${profile} profile` : "a draft"}`);
			if (profile) {
				const hooks = hooksFor(profile);
				add(hooksClosed(hooks), `Hooks block generated from the ${profile} profile; every command ends with || exit 2`);
				allowOn = input.dispatchable === true;
				add(true, allowOn ? "Listed in kit/agents-allow.json: runners may dispatch it" : "Not in kit/agents-allow.json: runners cannot dispatch it", false);
			} else {
				allowOn = false;
				add(false, "Draft: no guard profile, runners cannot dispatch it", false);
			}
			add(false, "Not run yet: try it once in a review session before a runner dispatches it", false);
			if (!checks.some((c) => c.block) && profile !== undefined) {
				const head = [`name: ${slug}`, `description: ${quote(description)}`, `model: ${model}`, `tools: ${tools.join(", ")}`];
				if (profile) head.push(`guard: ${profile}`, hooksFor(profile));
				next = `---\n${head.join("\n")}\n---\n\n${body}`;
			}
		}
		if (next !== null && !next.endsWith("\n")) next += "\n";
		const problem = checks.find((c) => c.block);
		return { slug, file, old, next: problem ? null : next, crlf, isKit, allowOn, error: problem ? problem.text : null, checks: checks.map(({ ok, text }) => ({ ok, text })) };
	}

	function preview(input) {
		const p = plan(input);
		return { diff: p.next === null ? "" : unifiedDiff(p.old, p.next, `${p.slug}.md`), checks: p.checks };
	}

	function put(input) {
		let p;
		try { p = plan(input); } catch (e) { return { ok: false, error: e.message }; }
		if (p.error || p.next === null) return { ok: false, error: p.error || "The kit refused the change" };
		const diff = unifiedDiff(p.old, p.next, `${p.slug}.md`);
		if (diff) atomic(p.file, p.crlf ? p.next.replace(/\n/g, "\r\n") : p.next);
		if (!p.isKit) writeAllow(p.slug, p.allowOn === true);
		return { ok: true, diff };
	}

	function remove(input) {
		const slug = input && input.slug;
		let file;
		try { file = fileOf(slug); } catch (e) { return { ok: false, error: e.message }; }
		if (kitSet(shipped()).has(slug)) return { ok: false, error: "Kit agents cannot be deleted" };
		if (!fs.existsSync(file)) return { ok: false, error: `No agent named ${slug}` };
		fs.rmSync(file);
		writeAllow(slug, false);
		return { ok: true };
	}

	const OPS = { list: () => list(), get, preview, put, delete: remove };
	function run(op, input) {
		if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Error(`Unknown agent op ${String(op).slice(0, 40)}`);
		return OPS[op](input && typeof input === "object" ? input : {});
	}
	return { list, get, preview, put, delete: remove, run };
}

module.exports = { createAgents, parse, hooksFor, hooksClosed, unifiedDiff, PROFILES, SLUG };
