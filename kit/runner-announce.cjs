// PreToolUse hook for the sous lead (the main session, not a subagent): a sous-*-runner dispatch is refused until the lead has
// written its "Runner jalan:" line to the owner since the owner's last message or its own last runner dispatch. A runner runs in
// the foreground, so without that line the owner sees nothing for half an hour (QRD-1268, QRD-1426).
// Any other tool, a subagent's call, or a transcript it cannot read gets no answer.
// Test: echo '{"tool_name":"Agent","tool_input":{"subagent_type":"sous-ticket-runner"},"transcript_path":"t.jsonl"}' | node runner-announce.cjs
const fs = require("fs");

const RUNNER = /^sous-[a-z]+-runner$/;
const LINE = /Runner jalan:/i;
const REASON = "runner-announce: write one line to the owner first, starting `Runner jalan:`, naming what the runner does next in order " +
	"(for example `Runner jalan: intake -> planner -> T1 -> review -> verify -> FINAL -> video -> PR draft. Progress live di DOCK.`), " +
	"Write it together with another tool call (for example `node K/status.cjs set <KEY> note=...`) and dispatch in your next message: " +
	"a line in the same message as the dispatch is not on disk yet when this hook reads the transcript.";

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

function decide(payload, read = (file) => fs.readFileSync(file, "utf8"), sleep = pause) {
	if (payload.agent_type || !isRunner(payload.tool_name, payload.tool_input) || !payload.transcript_path) return null;
	for (let waited = 0; ; waited += STEP_MS) {
		let text;
		try { text = read(payload.transcript_path); } catch { return null; }
		const lines = text.split("\n").filter(Boolean);
		if (announced(lines, payload.tool_use_id)) return null;
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
	module.exports = { decide, announced };
}
