// PreToolUse hook for the sous lead (the main session, not a subagent): a sous-*-runner dispatch is refused until the lead has
// written its "Runner jalan:" line to the owner since the owner's last message or its own last runner dispatch. A runner runs in
// the foreground, so without that line the owner sees nothing for half an hour (QRD-1268, QRD-1426).
// The line may also sit in the dispatch's own Agent description or the first line of its prompt (DOCK shows the description). Sessions DOCK
// starts itself (`Cron run:`, `auto review dari DOCK`) have nobody waiting for the line and are skipped.
// Any other tool, a subagent's call, or a transcript it cannot read gets no answer.
// A sous-ticket-runner prompt that mentions redoing the demo video must say which: a line `new video: no`,
// `new video: yes, first video never made`, or `new video: yes, owner: "<words>"` whose quoted words the owner wrote in this
// session. The video is made once, for the first PR; on QRD-1312 (9 Nov) the lead planned "memperbarui video" itself and the first
// video was overwritten.
// Test: echo '{"tool_name":"Agent","tool_input":{"subagent_type":"sous-ticket-runner"},"transcript_path":"t.jsonl"}' | node runner-announce.cjs
const fs = require("fs");

const RUNNER = /^sous-[a-z]+-runner$/;
const LINE = /Runner jalan:/i;
const AUTOMATED = /Cron run:|auto review dari DOCK/i;
const REASON = "runner-announce: write one line to the owner first, starting `Runner jalan:`, naming what the runner does next in order " +
	"(for example `Runner jalan: intake -> planner -> T1 -> review -> verify -> FINAL -> video -> PR draft. Progress live di DOCK.`), " +
	"or put `Runner jalan: ...` in the Agent description. Otherwise write it together with another tool call (for example `node K/status.cjs set <KEY> note=...`) and dispatch in your next message: " +
	"a line in the same message as the dispatch is not on disk yet when this hook reads the transcript.";

const VIDEO_WORDS = /re-?render|re-?record|new video|video (ulang|baru)|memperbarui video|update the (demo )?video|redo the (demo )?video/i;
const VIDEO_LINE = /^\s*new video:\s*(no\b.*|yes, first video never made\b.*|yes, owner:\s*"([^"]+)")\s*$/im;
const VIDEO_REASON = "runner-announce: this prompt talks about redoing the demo video. The video is made once, for the first PR (sous SKILL.md section 3 step 7). " +
	"Add one line: `new video: no`, or `new video: yes, first video never made` when the video handoff is blocked, or `new video: yes, owner: \"<the owner's words>\"` " +
	"quoting the owner's own request in this session. Never plan a new video yourself.";

const isRunner = (tool, input) => (tool === "Agent" || tool === "Task") && RUNNER.test(String(input?.subagent_type || ""));
const blocks = (entry) => (typeof entry.message?.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message?.content || []);

// The ids of runner dispatches this hook refused: they never ran, so they do not use up a line written before them.
function refusedIds(entries) {
	const ids = new Set();
	for (const entry of entries) {
		if (entry.type !== "user") continue;
		for (const block of blocks(entry)) {
			if (block.type === "tool_result" && JSON.stringify(block.content ?? "").includes("runner-announce:")) ids.add(block.tool_use_id);
		}
	}
	return ids;
}

// True when the owner's last real prompt (the entry announced() stops at) was started by DOCK's cron or auto review.
function automated(lines) {
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.type !== "user" || entry.isSidechain || entry.isMeta) continue;
		const texts = blocks(entry).filter((block) => block.type === "text");
		if (texts.length) return texts.some((block) => AUTOMATED.test(block.text || ""));
	}
	return false;
}

// True when the lead wrote the line after the last owner prompt and after its last runner dispatch other than `toolUseId`.
function announced(lines, toolUseId) {
	let skipped = false;
	const entries = lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
	const refused = refusedIds(entries);
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.isSidechain) continue;
		if (entry.type === "user") {
			if (!entry.isMeta && blocks(entry).some((block) => block.type === "text")) return false;
			continue;
		}
		if (entry.type !== "assistant") continue;
		for (const block of [...blocks(entry)].reverse()) {
			if (block.type === "text" && LINE.test(block.text || "")) return true;
			if (block.type !== "tool_use" || !isRunner(block.name, block.input) || refused.has(block.id)) continue;
			if (toolUseId ? block.id === toolUseId : !skipped) { skipped = true; continue; }
			return false;
		}
	}
	return false;
}

// Claude Code can run this hook before it has written the text and tool_use of the dispatching message to the transcript, so a
// line written in that same message is not on disk yet (QRD-1286, 2026-10-29). Until the dispatch's own tool_use shows up, read again.
const WAIT_MS = 3000;
const STEP_MS = 150;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The owner's own words in this session: text of user entries that are not meta and not a subagent's.
function ownerTexts(lines) {
	const out = [];
	for (const line of lines) {
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== "user" || entry.isSidechain || entry.isMeta) continue;
		for (const block of blocks(entry)) if (block.type === "text") out.push(String(block.text || ""));
	}
	return out;
}

// Null when the prompt does not talk about a new video or says which with an allowed line; otherwise the reason to refuse.
function videoCheck(input, readLines) {
	if (String(input.subagent_type) !== "sous-ticket-runner") return null;
	const prompt = String(input.prompt || "");
	if (!VIDEO_WORDS.test(prompt)) return null;
	const match = prompt.match(VIDEO_LINE);
	if (!match) return VIDEO_REASON;
	if (!match[2]) return null;
	const quote = match[2].trim().toLowerCase();
	let lines;
	try { lines = readLines(); } catch { return VIDEO_REASON; }
	return ownerTexts(lines).some((text) => text.toLowerCase().includes(quote)) ? null : VIDEO_REASON;
}

// video-lock.cjs refuses a sous-video dispatch on a ticket that already has its video, for the lead and for a runner alike.
function lockedVideo(payload, read, deps) {
	if (payload.tool_name !== "Agent" && payload.tool_name !== "Task") return null;
	let lock;
	try { lock = require("./video-lock.cjs"); } catch { return null; }
	return lock.checkAgent(payload.tool_input, payload.transcript_path, { readTranscript: read, ...deps });
}

function decide(payload, read = (file) => fs.readFileSync(file, "utf8"), sleep = pause, deps = {}) {
	const locked = lockedVideo(payload, read, deps);
	if (locked) return locked;
	if (payload.agent_type || !isRunner(payload.tool_name, payload.tool_input) || !payload.transcript_path) return null;
	const input = payload.tool_input;
	const video = videoCheck(input, () => read(payload.transcript_path).split("\n").filter(Boolean));
	if (video) return video;
	if (LINE.test(String(input.description || "")) || LINE.test(String(input.prompt || "").split("\n")[0])) return null;
	for (let waited = 0; ; waited += STEP_MS) {
		let text;
		try { text = read(payload.transcript_path); } catch { return null; }
		const lines = text.split("\n").filter(Boolean);
		if (automated(lines) || announced(lines, payload.tool_use_id)) return null;
		const written = !payload.tool_use_id || lines.some((line) => line.includes(`"${payload.tool_use_id}"`));
		if (written || waited >= WAIT_MS) return REASON;
		sleep(STEP_MS);
	}
}

function main() {
	const reason = decide(JSON.parse(fs.readFileSync(0, "utf8")));
	if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

if (require.main === module) {
	try { main(); } catch {}
	process.exitCode = 0;
} else {
	module.exports = { decide, announced, videoCheck };
}
