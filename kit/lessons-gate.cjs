// The lessons gate of a DOCK turn: before a session changes anything it reads the lessons file DOCK wrote for its ticket
// (<evidence>/lessons/<KEY>.md). guard.cjs runs it for every session and subagent, sous-guard.cjs for the sous agents.
//   applies   DOCK_CHAT_TURN=1, not a Guild Master or Judge turn, and a lessons file is named:
//             env DOCK_LESSONS_FILE (the bridge sets it from DOCK's turn), else the line `Pelajaran: <path>` in the first prompt
//             of the session's transcript (a subagent: its own transcript, whose first prompt is the dispatch prompt)
//   refused   Edit, Write, MultiEdit, NotebookEdit, and a Bash/PowerShell command that runs git commit
//   until     the transcript holds a Read of that file (the Read tool, or `rtk read` / `cat` of it through Bash) that did not
//             fail, made after the file last changed; DOCK rewrites the file when a lesson lands, so a newer file is read again
// Read, Grep, Glob and every other command stay allowed, so a session can look around first. A lessons file that does not
// exist refuses nothing (DOCK always writes one, "belum ada pelajaran" when empty). Outside a DOCK turn nothing changes.
const fs = require("fs");
const path = require("path");

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const LINE = /^[ \t]*Pelajaran:[ \t]*(\S.*?\.md)(?=[\s,;]|$)/m;
const READ_VERB = /(^|[\s;&|(])(rtk\s+(proxy\s+)?read|cat|type|Get-Content|gc)(\s|$)/i;
const MAX_TRANSCRIPT = 64 * 1024 * 1024;

const norm = (p, win) => {
	const s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").replace(/\/+/g, "/");
	const drive = win ? s.replace(/^\/([a-zA-Z])\//, "$1:/") : s;
	return win ? drive.toLowerCase() : drive;
};

// The transcript of the caller: a subagent's own file (Claude Code keeps it at <session>/subagents/agent-<id>.jsonl) when
// the payload names an agent, else the session's.
function transcriptOf(payload) {
	const t = String(payload?.transcript_path || "");
	if (!t || !payload.agent_id || t.replace(/\\/g, "/").includes("/subagents/")) return t;
	const id = String(payload.session_id || path.basename(t).replace(/\.jsonl$/, ""));
	const own = path.join(path.dirname(t), id, "subagents", `agent-${payload.agent_id}.jsonl`);
	return fs.existsSync(own) ? own : t;
}

const blocks = (entry) => {
	const c = entry?.message?.content;
	return typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
};

function entries(text) {
	const out = [];
	for (const line of String(text || "").split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch {}
	}
	return out;
}

// The `Pelajaran:` path of the first prompt in a transcript, or null.
function fileFromTranscript(list) {
	for (const e of list) {
		if (!e || e.type !== "user" || e.isMeta) continue;
		const said = blocks(e).filter((b) => b && b.type === "text").map((b) => String(b.text || "")).join("\n");
		if (!said.trim() || said.trim().startsWith("<")) continue;
		const m = LINE.exec(said);
		return m ? m[1].trim() : null;
	}
	return null;
}

// The time (ms) of the last successful read of `file` in the transcript, or 0.
function lastRead(list, file, win) {
	const want = norm(file, win);
	const reads = new Map();
	const failed = new Set();
	for (const e of list) {
		for (const b of blocks(e)) {
			if (!b || typeof b !== "object") continue;
			if (b.type === "tool_result" && b.is_error === true) failed.add(b.tool_use_id);
			if (b.type !== "tool_use" || !b.id) continue;
			const input = b.input || {};
			// Claude Code also writes api-request-blob lines that replay earlier tool calls without a timestamp; they must not
			// overwrite the time of the call itself.
			const at = Date.parse(e.timestamp || "") || 0;
			if (!at) continue;
			let read = false;
			if (b.name === "Read" && norm(input.file_path, win) === want && !(Number(input.offset) > 1)) read = true;
			else if (SHELL_TOOLS.has(b.name) && typeof input.command === "string") {
				const cmd = norm(input.command.replace(/["']/g, " "), win);
				read = cmd.includes(want) && READ_VERB.test(cmd);
			}
			if (read && at > (reads.get(b.id) || 0)) reads.set(b.id, at);
		}
	}
	let last = 0;
	for (const [id, at] of reads) if (!failed.has(id) && at > last) last = at;
	return last;
}

// The deny reason for one hook payload, or null. deps: { env, platform, commits(command) -> bool, readFile, stat } for tests.
function check(payload, deps = {}) {
	const env = deps.env || process.env;
	if (env.DOCK_CHAT_TURN !== "1" || env.DOCK_GM === "1" || env.DOCK_JUDGE === "1") return null;
	const tool = String(payload?.tool_name || "");
	const input = payload?.tool_input || {};
	let writes = WRITE_TOOLS.has(tool);
	if (!writes && SHELL_TOOLS.has(tool) && typeof input.command === "string" && /\bcommit\b/.test(input.command)) {
		const commits = deps.commits || require("./guard.cjs").commits;
		writes = commits(input.command);
	}
	if (!writes) return null;
	const win = (deps.platform || process.platform) === "win32";
	const readFile = deps.readFile || ((f) => {
		if (fs.statSync(f).size > MAX_TRANSCRIPT) throw new Error("transcript too large");
		return fs.readFileSync(f, "utf8");
	});
	const stat = deps.stat || ((f) => fs.statSync(f));
	const transcript = transcriptOf(payload);
	let list = null;
	try { list = transcript ? entries(readFile(transcript)) : null; } catch { list = null; }
	const named = typeof env.DOCK_LESSONS_FILE === "string" && env.DOCK_LESSONS_FILE.trim() ? env.DOCK_LESSONS_FILE.trim() : list ? fileFromTranscript(list) : null;
	if (!named) return null;
	let mtime;
	try { mtime = stat(named).mtimeMs; } catch { return null; }
	const shown = named.replace(/\\/g, "/");
	if (!list) return `lessons: read ${shown} first. This DOCK turn refuses Edit, Write and git commit until the session has read its lessons file, and the transcript could not be read to check it`;
	const at = lastRead(list, named, win);
	if (!at) return `lessons: read ${shown} first (the Read tool, or rtk read). This DOCK turn refuses Edit, Write and git commit until the session has read its lessons file`;
	if (at < mtime) return `lessons: ${shown} changed after you read it (DOCK added a lesson); read it again before Edit, Write or git commit`;
	return null;
}

module.exports = { check, fileFromTranscript, lastRead, transcriptOf, entries, LINE };
