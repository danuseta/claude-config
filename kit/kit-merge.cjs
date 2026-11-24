// Local edits of installed skill and agent files survive a kit install: install/install.cjs merges three ways, this module holds the rules.
//   base     what the kit installed last time, kept at <config>/kit/.base/<path>
//   local    the file in the config dir, maybe edited by the owner or Guild Master
//   kit      the file of the kit being installed
// local == base: the kit version is written. kit == base: local stays. Both changed: git merge-file; a clean merge is written, a conflict
// leaves local alone and puts the kit version next to it as <file>.kit-new, keeping the old base. Without git it is a conflict too.
// Only skills/** and agents/*.md text files merge; guards, the allow-list, settings, hooks and linux/ always take the kit version.
// <config>/kit/merge-report.json records the last install's merged, kept and conflicting paths; DOCK reads it through the bridge.
// DOCK's ops (dock-chat.cjs runs them):
//   report {}                  the report, conflicts whose .kit-new is gone left out
//   file { path }              a conflict's local, kit and base text and the merge with conflict markers
// The resolve plan (resolvePlan / resolveCommit) writes only through gm.cjs, with DOCK's nonce, a backup and a manager log entry.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TEXT_EXT = /\.(md|json|cjs|js|mjs|sh|txt|yml|yaml|toml|py|ts|tsx|css|html|env|jsonl)$/i;
const MERGEABLE = /^(skills\/[^\0]+|agents\/[^/]+\.md)$/;
const LOCKED = [/^kit\/guard/, /^kit\/sous-guard\.cjs$/, /^kit\/agents-allow\.json$/, /^settings(\/|\.json$)/, /(^|\/)hooks(\/|$)/, /^linux\//, /^install\//, /^manifest\.json$/];
const SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9._@+-]{0,119}$/;
const KIT_NEW = ".kit-new";
const MAX_ROWS = 500;
const MAX_TEXT = 200000;

const toLf = (s) => String(s).replace(/\r\n/g, "\n");
const isLocked = (rel) => LOCKED.some((re) => re.test(rel));

// A relative config path that merges: skills/** or agents/*.md, a text file, plain segments, never a locked path.
function mergeable(rel) {
	const r = String(rel || "");
	if (!MERGEABLE.test(r) || isLocked(r) || !TEXT_EXT.test(r) || r.endsWith(KIT_NEW)) return false;
	return r.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
}

const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
function atomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

// git merge-file on three texts. { clean, text } or { error } when git is missing or failed.
function gitMerge(local, base, kit, git = "git") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-merge-"));
	try {
		const f = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
		const r = spawnSync(git, ["merge-file", "-p", "-L", "local", "-L", "base", "-L", "kit", f("local", local), f("base", base), f("kit", kit)], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
		if (r.error || typeof r.status !== "number") return { error: r.error ? r.error.code || r.error.message : "git did not run" };
		if (r.status === 0) return { clean: true, text: r.stdout };
		if (r.status > 0 && r.status < 128) return { clean: false, text: r.stdout };
		return { error: `git merge-file exited ${r.status}` };
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const baseFileOf = (configDir, rel) => path.join(configDir, "kit", ".base", ...rel.split("/"));
const reportFileOf = (configDir) => path.join(configDir, "kit", "merge-report.json");

/**
 * What an install does with one mergeable file, and with apply also does it. src is the kit file, dst the installed one.
 * action: new | same | installed (no base yet, overwritten as before) | updated | kept | merged | conflict.
 */
function mergeFile({ src, dst, rel, configDir, apply = false, git = "git" }) {
	const kitRaw = fs.readFileSync(src);
	const kit = toLf(kitRaw.toString("utf8"));
	const baseFile = baseFileOf(configDir, rel);
	const kitNew = `${dst}${KIT_NEW}`;
	const writeBase = () => { if (toLf(readText(baseFile) ?? "\0") !== kit) atomic(baseFile, kit); };
	const dropKitNew = () => fs.rmSync(kitNew, { force: true });
	const copy = () => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
	const done = (action, extra = {}, work = () => {}) => { if (apply) work(); return { action, rel, ...extra }; };

	const localRaw = readText(dst);
	if (localRaw === null) return done("new", {}, () => { copy(); writeBase(); dropKitNew(); });
	const local = toLf(localRaw);
	if (local === kit) return done("same", {}, () => { writeBase(); dropKitNew(); });
	const baseRaw = readText(baseFile);
	if (baseRaw === null) return done("installed", {}, () => { copy(); writeBase(); dropKitNew(); });
	const base = toLf(baseRaw);
	if (local === base) return done("updated", {}, () => { copy(); writeBase(); dropKitNew(); });
	if (kit === base) return done("kept", {}, dropKitNew);
	const m = gitMerge(local, base, kit, git);
	if (m.clean) {
		const crlf = localRaw.includes("\r\n");
		return done("merged", {}, () => { atomic(dst, crlf ? m.text.replace(/\n/g, "\r\n") : m.text); writeBase(); dropKitNew(); });
	}
	return done("conflict", { reason: m.error ? `git unavailable (${String(m.error).slice(0, 80)}), local kept` : "both changed the same lines" }, () => atomic(kitNew, kitRaw));
}

function writeReport(configDir, results, now = new Date()) {
	const at = now.toISOString();
	const rows = (action) => results.filter((r) => r.action === action).slice(0, MAX_ROWS);
	const report = {
		at,
		merged: rows("merged").map((r) => ({ path: r.rel, at })),
		kept: rows("kept").map((r) => ({ path: r.rel, at })),
		conflicts: rows("conflict").map((r) => ({ path: r.rel, kitNew: `${r.rel}${KIT_NEW}`, reason: r.reason, at })),
	};
	atomic(reportFileOf(configDir), `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

function createKitMerge({ configDir, git = "git", now = () => new Date() } = {}) {
	if (!configDir) throw new Error("configDir is required");
	const root = path.resolve(configDir);
	const reportFile = reportFileOf(root);
	const readReport = () => { try { const r = JSON.parse(fs.readFileSync(reportFile, "utf8")); return r && typeof r === "object" ? r : null; } catch { return null; } };
	const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x.path === "string" && mergeable(x.path)) : []);

	// The config file of a mergeable path; no part of it below the config dir may be a link.
	function fileOf(rel) {
		if (typeof rel !== "string" || !mergeable(rel.replace(/\\/g, "/"))) throw new Error("Not a skill or agent file the kit merges");
		const parts = rel.replace(/\\/g, "/").split("/");
		let at = root;
		for (const p of parts) {
			at = path.join(at, p);
			try { if (fs.lstatSync(at).isSymbolicLink()) throw new Error("A link in the path is refused"); } catch (e) { if (e.code !== "ENOENT") throw e; }
		}
		return at;
	}

	function report() {
		const r = readReport();
		if (!r) return { at: null, merged: [], kept: [], conflicts: [], resolved: [] };
		const conflicts = list(r.conflicts).filter((c) => fs.existsSync(`${fileOf(c.path)}${KIT_NEW}`));
		return { at: typeof r.at === "string" ? r.at : null, merged: list(r.merged), kept: list(r.kept), conflicts, resolved: list(r.resolved).slice(-50) };
	}

	function conflictOf(rel) {
		const file = fileOf(rel);
		if (!report().conflicts.some((c) => c.path === rel)) throw new Error(`${rel} has no open conflict`);
		const kit = readText(`${file}${KIT_NEW}`);
		if (kit === null) throw new Error(`${rel}${KIT_NEW} is gone`);
		return { file, local: readText(file), kit, base: readText(baseFileOf(root, rel)) };
	}

	function file(input) {
		const rel = input && input.path;
		const c = conflictOf(rel);
		const cut = (s) => (s === null ? null : s.slice(0, MAX_TEXT));
		const m = c.local !== null && c.base !== null ? gitMerge(toLf(c.local), toLf(c.base), toLf(c.kit), git) : { error: "no base" };
		return { path: rel, local: cut(c.local), kit: cut(c.kit), base: cut(c.base), merged: m.error ? null : cut(m.text), clean: m.clean === true };
	}

	// action local: the local file stays; kit: the .kit-new text replaces it; edit: the given text replaces it. Every action sets the base
	// to the kit version and removes .kit-new, so the next install sees the conflict as settled.
	function resolvePlan({ path: rel, action, text } = {}) {
		if (!["local", "kit", "edit"].includes(action)) throw new Error("action must be local, kit or edit");
		const c = conflictOf(rel);
		let next = null;
		if (action === "kit") next = c.kit;
		if (action === "edit") {
			if (typeof text !== "string" || text.length > MAX_TEXT || text.includes("\0")) throw new Error(`The merged text must be text of at most ${MAX_TEXT} characters`);
			if (/^(<{7}|>{7}) /m.test(text)) throw new Error("The merged text still has conflict markers");
			next = text;
		}
		return { rel, action, file: c.file, before: c.local, next, kit: c.kit };
	}

	function resolveCommit(plan) {
		if (plan.next !== null) atomic(plan.file, plan.next);
		atomic(baseFileOf(root, plan.rel), toLf(plan.kit));
		fs.rmSync(`${plan.file}${KIT_NEW}`, { force: true });
		const r = readReport() || { at: null, merged: [], kept: [], conflicts: [] };
		const resolved = [...list(r.resolved), { path: plan.rel, action: plan.action, at: now().toISOString() }].slice(-50);
		atomic(reportFile, `${JSON.stringify({ ...r, conflicts: list(r.conflicts).filter((c) => c.path !== plan.rel), resolved }, null, 2)}\n`);
		return report();
	}

	const OPS = { report: () => report(), file };
	function run(op, input) {
		if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Error(`Unknown kit merge op ${String(op).slice(0, 40)}`);
		return OPS[op](input && typeof input === "object" ? input : {});
	}
	return { report, file, resolvePlan, resolveCommit, fileOf, run, reportFile };
}

module.exports = { mergeable, isLocked, gitMerge, mergeFile, writeReport, createKitMerge, KIT_NEW, TEXT_EXT };
