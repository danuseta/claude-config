// Asks DOCK whether a ticket's merged pull requests are deployed to UAT (dock#199, /ingest/orchestrator/deploy-gate).
//   node deploy-gate.cjs <KEY>     prints the state per repo; exit 0 ready, 3 not ready, 1 DOCK did not answer
// uatCheckGate() is the hook check: a Jira transition to UAT CHECK is refused until the gate says ready, unless the call carries
// the owner's own words, DEPLOY_GATE_OVERRIDE="<words>" in the tool input's comment or reason, found in an owner message.
// QRD-1292 (4 Nov): QA started 22 minutes before the BE deploy finished and seven test cases failed on 404s.
const fs = require("fs");
const path = require("path");
const dock = require("./dock-push.cjs");

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const TRANSITION_TOOL = /^mcp__[\w-]+__transitionJiraIssue$/;
const OVERRIDE = /DEPLOY_GATE_OVERRIDE="([^"]+)"/;

function settings() {
	try { return JSON.parse(fs.readFileSync(path.join(__dirname, "uat-gate.json"), "utf8")); } catch { return {}; }
}

async function gate(key, send = dock.send, timeoutMs = 4000) {
	const r = await send("/deploy-gate", { key }, timeoutMs);
	if (r?.skipped) return { answered: false, why: "DOCK is not configured (dock.json)" };
	if (r?.status !== 200 || !r.result) return { answered: false, why: `DOCK answered ${r?.status ?? "nothing"}${r?.error ? " " + r.error : ""}` };
	return { answered: true, ...r.result };
}

const blocks = (entry) => (typeof entry.message?.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message?.content || []);
function ownerSaid(words, transcript) {
	const want = String(words || "").trim().toLowerCase();
	if (!want) return false;
	for (const line of String(transcript || "").split("\n")) {
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== "user" || entry.isSidechain || entry.isMeta) continue;
		if (blocks(entry).some((b) => b.type === "text" && String(b.text || "").toLowerCase().includes(want))) return true;
	}
	return false;
}

function isToUatCheck(input, cfg) {
	const ids = (cfg.uatCheckTransitionIds || ["3"]).map(String);
	const names = (cfg.uatCheckNames || ["UAT CHECK"]).map((n) => String(n).toLowerCase());
	const t = input?.transition ?? {};
	const id = String(t.id ?? input?.transitionId ?? "");
	const name = String(t.name ?? input?.transitionName ?? input?.status ?? "").toLowerCase();
	return Boolean((id && ids.includes(id)) || (name && names.includes(name)));
}

// Null to let the call through, or the reason to refuse it.
async function uatCheckGate(payload, deps = {}) {
	if (!TRANSITION_TOOL.test(String(payload?.tool_name || ""))) return null;
	const input = payload.tool_input || {};
	const cfg = deps.settings || settings();
	if (!isToUatCheck(input, cfg)) return null;
	const key = String(input.issueIdOrKey || input.issueKey || "").trim().toUpperCase();
	if (!KEY.test(key)) return null;
	const text = JSON.stringify(input).replace(/\\"/g, '"');
	const override = text.match(OVERRIDE);
	if (override) {
		let transcript = "";
		try { transcript = (deps.readTranscript || ((f) => fs.readFileSync(f, "utf8")))(payload.transcript_path); } catch {}
		if (ownerSaid(override[1], transcript)) return null;
	}
	const g = await gate(key, deps.send || dock.send, deps.timeoutMs || 4000);
	if (!g.answered) return `uat-gate: ${key} cannot move to UAT CHECK: the deploy gate did not answer (${g.why}). Run node <kit>/deploy-gate.cjs ${key} and retry when it says ready.`;
	if (g.ready) return null;
	return `uat-gate: ${key} is not deployed to UAT yet, so it cannot move to UAT CHECK (QA would test old code): ${g.summary}. Wait for the deploy and retry. ` +
		"The owner can override in words: put DEPLOY_GATE_OVERRIDE=\"<their words>\" in the transition's comment, quoting what they wrote.";
}

// The PreToolUse answer for a refused move, or null.
async function hookAnswer(payload, deps) {
	const reason = await uatCheckGate(payload, deps);
	return reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) : null;
}

async function main() {
	const key = String(process.argv[2] || "").trim().toUpperCase();
	if (!KEY.test(key)) {
		console.error("usage: node deploy-gate.cjs <KEY>");
		process.exitCode = 1;
		return;
	}
	const g = await gate(key, dock.send, 60000);
	if (!g.answered) {
		console.error(`deploy-gate: ${g.why}`);
		process.exitCode = 1;
		return;
	}
	console.log(`${key}: ${g.ready ? "READY, deployed to UAT" : "NOT READY"}`);
	for (const r of g.repos || []) console.log(`  ${r.repo}#${r.pull} ${r.state}${r.runUrl ? " " + r.runUrl : ""} (${r.detail})`);
	process.exitCode = g.ready ? 0 : 3;
}

if (require.main === module) {
	main().catch((e) => { console.error(`deploy-gate: ${e.message || e}`); process.exitCode = 1; });
} else {
	module.exports = { gate, uatCheckGate, hookAnswer, isToUatCheck, ownerSaid };
}
