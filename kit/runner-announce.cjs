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
	"then dispatch the runner again.";

const isRunner = (tool, input) => (tool === "Agent" || tool === "Task") && RUNNER.test(String(input?.subagent_type || ""));
const blocks = (entry) => (typeof entry.message?.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message?.content || []);

// True when the lead wrote the line after the last owner prompt and after its last runner dispatch other than `toolUseId`.
function announced(lines, toolUseId) {
	let skipped = false;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		let entry;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		if (entry.isSidechain) continue;
		if (entry.type === "user") {
			if (!entry.isMeta && blocks(entry).some((block) => block.type === "text")) return false;
			continue;
		}
		if (entry.type !== "assistant") continue;
		for (const block of [...blocks(entry)].reverse()) {
			if (block.type === "text" && LINE.test(block.text || "")) return true;
			if (block.type !== "tool_use" || !isRunner(block.name, block.input)) continue;
			if (toolUseId ? block.id === toolUseId : !skipped) { skipped = true; continue; }
			return false;
		}
	}
	return false;
}

function decide(payload, read = (file) => fs.readFileSync(file, "utf8")) {
	if (payload.agent_type || !isRunner(payload.tool_name, payload.tool_input) || !payload.transcript_path) return null;
	let text;
	try { text = read(payload.transcript_path); } catch { return null; }
	return announced(text.split("\n").filter(Boolean), payload.tool_use_id) ? null : REASON;
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
