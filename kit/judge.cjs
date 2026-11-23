// The Judge session's way to hand its result to DOCK (dock /ingest/orchestrator/judge). Used by skills/judge; it never writes to
// git, GitHub or Jira. DOCK computes the grade from the findings, so the body carries none.
//   node judge.cjs check <json-file>    validate the result offline and print the body that would be sent
//   node judge.cjs post <json-file>     validate, then POST it to DOCK
// The file: { sessionId, untilMessageId, findings: [{ messageId?, threadUrl?, cause, text, quote, shouldHave, call }], ownerWaitMinutes }
//   untilMessageId: the last message judged ("-" or null when the whole session was judged without one)
//   cause: stopped-with-way-out | self-inflicted-rework | misread-ac-scope | skipped-step | asked-instead-of-looking | wrong-code | environment
//   call: mistake | not
// Exit 0 answered, 3 DOCK refused (its error on stderr), 1 usage error, a result that does not fit, or DOCK did not answer.
const fs = require("fs");
const dock = require("./dock-push.cjs");

const CAUSES = ["stopped-with-way-out", "self-inflicted-rework", "misread-ac-scope", "skipped-step", "asked-instead-of-looking", "wrong-code", "environment"];
const CALLS = ["mistake", "not"];
const TEXT = ["cause", "text", "quote", "shouldHave"];
const USAGE = ["usage: node judge.cjs check <json-file>", "       node judge.cjs post <json-file>"].join("\n");

const isId = (v) => (typeof v === "string" && v.trim() !== "") || (Number.isInteger(v) && v >= 0);

// Null when the finding fits the contract, else what is wrong with it.
function findingProblem(f, i) {
	const at = `finding ${i + 1}`;
	if (!f || typeof f !== "object" || Array.isArray(f)) return `${at} is not an object`;
	const empty = TEXT.find((k) => typeof f[k] !== "string" || !f[k].trim());
	if (empty) return `${at}: ${empty} must be a non-empty string`;
	if (!CAUSES.includes(f.cause)) return `${at}: cause must be one of ${CAUSES.join(", ")}`;
	if (!CALLS.includes(f.call)) return `${at}: call must be mistake or not`;
	if (f.messageId !== undefined && f.messageId !== null && !isId(f.messageId)) return `${at}: messageId must be a message id`;
	if (f.threadUrl !== undefined && f.threadUrl !== null && !(typeof f.threadUrl === "string" && /^https?:\/\/\S+$/.test(f.threadUrl))) return `${at}: threadUrl must be an http(s) link`;
	return null;
}

// A parsed result file -> { body } or { error }.
function resultBody(r) {
	if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "the result is not an object" };
	if (typeof r.sessionId !== "string" || !r.sessionId.trim()) return { error: "sessionId must be the DOCK session id" };
	const until = r.untilMessageId === "-" || r.untilMessageId === undefined ? null : r.untilMessageId;
	if (until !== null && !isId(until)) return { error: 'untilMessageId must be a message id, "-" or null' };
	if (!Array.isArray(r.findings)) return { error: "findings must be an array (empty when the session has none)" };
	const problem = r.findings.map(findingProblem).find(Boolean);
	if (problem) return { error: problem };
	const wait = r.ownerWaitMinutes === undefined || r.ownerWaitMinutes === null ? 0 : r.ownerWaitMinutes;
	if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) return { error: "ownerWaitMinutes must be a number of minutes, 0 or more" };
	const findings = r.findings.map((f) => ({
		...(isId(f.messageId) ? { messageId: f.messageId } : {}),
		...(typeof f.threadUrl === "string" ? { threadUrl: f.threadUrl } : {}),
		cause: f.cause, text: f.text.trim(), quote: f.quote.trim(), shouldHave: f.shouldHave.trim(), call: f.call,
	}));
	return { body: { sessionId: r.sessionId.trim(), untilMessageId: until, findings, ownerWaitMinutes: Math.round(wait) } };
}

// argv after the script name -> { cmd, body } or { error }.
function request(argv, readFile = (f) => fs.readFileSync(f, "utf8")) {
	const [cmd, file] = argv;
	if (!["check", "post"].includes(cmd)) return { error: cmd ? `unknown command ${cmd}` : "no command" };
	if (!file) return { error: `${cmd} needs the JSON file of the result` };
	let parsed;
	try { parsed = JSON.parse(String(readFile(file)).replace(/^﻿/, "")); } catch (e) { return { error: `cannot read ${file}: ${e.message}` }; }
	const out = resultBody(parsed);
	return out.error ? out : { cmd, body: out.body };
}

async function call(body, send = dock.send) {
	const r = await send("/judge", body, 60000);
	if (r?.skipped) return { code: 1, why: "DOCK is not configured (dock.json)" };
	if (r?.status >= 200 && r.status < 300 && r.ok !== false) return { code: 0, result: r.result ?? { ok: true } };
	if (r?.status >= 400 && r.status < 500) return { code: 3, why: `DOCK refused (${r.status})${r.error ? ": " + r.error : ""}` };
	return { code: 1, why: `DOCK answered ${r?.status ?? "nothing"}${r?.error ? " " + r.error : ""}` };
}

async function run(argv, deps = {}) {
	const out = deps.out || ((s) => console.log(s));
	const err = deps.err || ((s) => console.error(s));
	const req = request(argv, deps.readFile);
	if (req.error) {
		err(`judge: ${req.error}\n${USAGE}`);
		return 1;
	}
	if (req.cmd === "check") {
		out(JSON.stringify(req.body, null, 2));
		return 0;
	}
	let r;
	try { r = await call(req.body, deps.send || dock.send); } catch (e) { r = { code: 1, why: `could not reach DOCK: ${e.message || e}` }; }
	if (r.code) err(`judge: ${r.why}`);
	else out(JSON.stringify(r.result, null, 2));
	return r.code;
}

if (require.main === module) {
	run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`judge: ${e.message || e}`); process.exitCode = 1; });
} else {
	module.exports = { request, resultBody, call, run, CAUSES };
}
