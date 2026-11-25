// The lessons files DOCK writes for the skills and agents a session reads (DOCK › Agents › Lessons). dock-chat.cjs runs the op
// DOCK hands out with its claim, like the skill and agent ops; the files are local and no kit ships them, so a kit install keeps them.
//   put { kind: "skill", name, text }   writes <config>/skills/<name>/lessons.md; the skill folder must exist
//   put { kind: "agent", name, text }   writes <config>/kit/lessons/agents/<name>.md; the agent file agents/<name>.md must exist. Not in
//                                       agents/, which Claude Code loads as agent definitions; the install merge only touches skills/**
//                                       and agents/*.md, and never deletes a file the kit does not ship
//   get { kind, name }                  { path, text } with "" when there is no file yet
// Answers { ok: true, path, changed } or { ok: false, error }. Text is at most 100 KB with no NUL byte; writes are atomic (tmp + rename)
// and a link anywhere on the path is refused.
const fs = require("fs");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");

const NAME = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
const MAX_BYTES = 100 * 1024;

function createLessons({ configDir = resolvePaths().configDir } = {}) {
	const root = path.resolve(configDir);

	function fileOf(input) {
		const kind = input && input.kind;
		const name = input && typeof input.name === "string" ? input.name.trim() : "";
		if (kind !== "skill" && kind !== "agent") throw new Error("kind must be skill or agent");
		if (!NAME.test(name) || name.includes("..")) throw new Error("name must be a plain skill or agent name");
		const dir = path.join(root, kind === "skill" ? "skills" : "agents");
		const owner = kind === "skill" ? path.join(dir, name) : path.join(dir, `${name}.md`);
		for (const p of [dir, owner]) {
			let st;
			try { st = fs.lstatSync(p); } catch { throw new Error(kind === "skill" ? `No skill folder ${name}` : `No agent file agents/${name}.md`); }
			if (st.isSymbolicLink()) throw new Error("A link in the path is refused");
		}
		if (kind === "skill" && !fs.lstatSync(owner).isDirectory()) throw new Error(`No skill folder ${name}`);
		const file = kind === "skill" ? path.join(owner, "lessons.md") : path.join(root, "kit", "lessons", "agents", `${name}.md`);
		const parts = kind === "skill" ? [file] : ["kit", "kit/lessons", "kit/lessons/agents", `kit/lessons/agents/${name}.md`].map((p) => path.join(root, p));
		for (const p of parts) {
			try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error("A link in the path is refused"); } catch (e) { if (e.code !== "ENOENT") throw e; }
		}
		return { file, rel: path.relative(root, file).replace(/\\/g, "/") };
	}

	function get(input) {
		const { file, rel } = fileOf(input);
		let text = "";
		try { text = fs.readFileSync(file, "utf8"); } catch {}
		return { path: rel, text };
	}

	function put(input) {
		try {
			const { file, rel } = fileOf(input);
			if (typeof input.text !== "string") return { ok: false, error: "text is required" };
			const bytes = Buffer.from(input.text, "utf8");
			if (bytes.length > MAX_BYTES) return { ok: false, error: `A lessons file is at most ${MAX_BYTES / 1024} KB` };
			if (bytes.includes(0)) return { ok: false, error: "A lessons file is text" };
			let before = null;
			try { before = fs.readFileSync(file, "utf8"); } catch {}
			if (before === input.text) return { ok: true, path: rel, changed: false };
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(tmp, input.text);
			fs.renameSync(tmp, file);
			return { ok: true, path: rel, changed: true };
		} catch (e) {
			return { ok: false, error: String(e.message || e).slice(0, 300) };
		}
	}

	const OPS = { get, put };
	function run(op, input) {
		if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Error(`Unknown lessons op ${String(op).slice(0, 40)}`);
		return OPS[op](input && typeof input === "object" ? input : {});
	}
	return { get, put, run, fileOf };
}

module.exports = { createLessons };
