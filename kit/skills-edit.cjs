// The text files of the installed skills (<config>/skills/**) for Guild Master and DOCK. dock-chat.cjs runs the read ops DOCK hands out;
// writes go through gm.cjs only, after DOCK's nonce, with a backup and a manager log entry.
//   list {}                 { path, bytes }[] of every editable file, sorted
//   get { path }            { path, text, bytes, kitNew }
//   preview { path, text }  { diff } and writes nothing
//   put { path, text }      { ok: true, diff } | { ok: false, error }; gm.cjs calls it, the bridge does not hand it out
// A path is relative to the skills folder (a leading skills/ is dropped): plain segments, no .., not absolute, no link anywhere below
// skills/, a .md, .json or .txt file of at most 100 KB with no NUL byte. A new file only goes into a skill folder that exists.
// Writes are atomic (tmp + rename) and keep the file's line ending.
const fs = require("fs");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");
const { unifiedDiff } = require("./agents.cjs");

const SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9._@+-]{0,119}$/;
const EXT = /\.(md|json|txt)$/i;
const MAX_BYTES = 100 * 1024;
const MAX_DEPTH = 8;
const MAX_FILES = 5000;

function normalize(input) {
	if (typeof input !== "string" || !input.trim()) throw new Error("A skill file path is required");
	const raw = input.trim().replace(/\\/g, "/");
	if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || path.isAbsolute(raw)) throw new Error("The path must be relative to the skills folder");
	const rel = raw.replace(/^skills\//, "");
	const parts = rel.split("/");
	if (parts.some((p) => p === ".." || p === ".")) throw new Error("The path may not contain . or .. segments");
	if (parts.length < 2 || parts.length > MAX_DEPTH || !parts.every((p) => SEGMENT.test(p))) throw new Error("The path is <skill>/<file>, made of plain names");
	if (!EXT.test(rel) || rel.endsWith(".kit-new")) throw new Error("Only .md, .json and .txt files of a skill can be edited");
	return rel;
}

const binary = (buf) => buf.includes(0);

function createSkills({ configDir = resolvePaths().configDir } = {}) {
	const dir = path.resolve(configDir, "skills");

	// The file of a skill path; every part below skills/ that exists must be a plain folder or file, never a link.
	function fileOf(input) {
		const rel = normalize(input);
		const file = path.resolve(dir, ...rel.split("/"));
		const inside = path.relative(dir, file);
		if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("That path is outside the skills folder");
		let at = dir;
		for (const p of rel.split("/")) {
			at = path.join(at, p);
			let st = null;
			try { st = fs.lstatSync(at); } catch (e) { if (e.code !== "ENOENT") throw e; }
			if (st && st.isSymbolicLink()) throw new Error("A link in the path is refused");
		}
		return { rel, file };
	}

	function readFile(file) {
		let st;
		try { st = fs.lstatSync(file); } catch { return null; }
		if (!st.isFile()) throw new Error("Not a file");
		if (st.size > MAX_BYTES) throw new Error(`The file is larger than ${MAX_BYTES / 1024} KB`);
		const buf = fs.readFileSync(file);
		if (binary(buf)) throw new Error("A binary file cannot be edited");
		return buf.toString("utf8");
	}

	function list() {
		const out = [];
		const walk = (abs, rel, depth) => {
			if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
			let names = [];
			try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
			for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
				if (!SEGMENT.test(d.name) || d.isSymbolicLink()) continue;
				const r = rel ? `${rel}/${d.name}` : d.name;
				if (d.isDirectory()) walk(path.join(abs, d.name), r, depth + 1);
				else if (d.isFile() && rel && EXT.test(d.name)) {
					const size = fs.statSync(path.join(abs, d.name)).size;
					if (size <= MAX_BYTES) out.push({ path: r, bytes: size });
				}
			}
		};
		walk(dir, "", 0);
		return out;
	}

	function get(input) {
		const { rel, file } = fileOf(input && input.path);
		const text = readFile(file);
		if (text === null) throw new Error(`No skill file ${rel}`);
		return { path: rel, text, bytes: Buffer.byteLength(text), kitNew: fs.existsSync(`${file}.kit-new`) };
	}

	function plan(input) {
		if (!input || typeof input !== "object") throw new Error("A skill file object is required");
		const { rel, file } = fileOf(input.path);
		if (typeof input.text !== "string") throw new Error("The text of the file is required");
		const bytes = Buffer.from(input.text, "utf8");
		if (bytes.length > MAX_BYTES) throw new Error(`The file may be at most ${MAX_BYTES / 1024} KB`);
		if (binary(bytes)) throw new Error("A binary file cannot be written");
		const before = readFile(file);
		if (before === null) {
			const skill = path.join(dir, rel.split("/")[0]);
			if (!fs.existsSync(skill) || !fs.lstatSync(skill).isDirectory()) throw new Error(`No skill folder ${rel.split("/")[0]}`);
		}
		const old = before === null ? "" : before.replace(/\r\n/g, "\n");
		const next = input.text.replace(/\r\n/g, "\n");
		return { rel, file, old, next, crlf: before !== null && before.includes("\r\n") };
	}

	const diffOf = (p) => unifiedDiff(p.old, p.next, "x").replace(/^--- (a\/agents\/x|\/dev\/null)\n\+\+\+ b\/agents\/x\n/, (m, a) => `--- ${a === "/dev/null" ? a : `a/skills/${p.rel}`}\n+++ b/skills/${p.rel}\n`);

	function preview(input) {
		return { diff: diffOf(plan(input)) };
	}

	function put(input) {
		let p;
		try { p = plan(input); } catch (e) { return { ok: false, error: e.message }; }
		const diff = diffOf(p);
		if (diff) {
			fs.mkdirSync(path.dirname(p.file), { recursive: true });
			const tmp = `${p.file}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(tmp, p.crlf ? p.next.replace(/\n/g, "\r\n") : p.next);
			fs.renameSync(tmp, p.file);
		}
		return { ok: true, diff };
	}

	const OPS = { list: () => list(), get, preview };
	function run(op, input) {
		if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Error(`Unknown skill op ${String(op).slice(0, 40)}`);
		return OPS[op](input && typeof input === "object" ? input : {});
	}
	return { list, get, preview, put, run, fileOf };
}

module.exports = { createSkills, normalize, MAX_BYTES };
