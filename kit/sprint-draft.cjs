// The Planning chat's way into DOCK's sprint draft (dock /ingest/orchestrator/sprint-draft/* and /storyboard). Used by the
// sprint-planner and storyboard-reader skills; it never writes to Jira or Confluence, DOCK publishes the draft when the planner says so.
//   node sprint-draft.cjs get <sprint>                                              the draft: tickets, after-it findings, predictions
//   node sprint-draft.cjs update <sprint> <KEY> [--dev <name>] [--wave <n>] [--sp <n>] [--ac-file <file>]
//                                                                                   --ac-file: one AC line per non-empty line, or a JSON array
//   node sprint-draft.cjs tc <sprint> <KEY> <json-file>                              test cases: [{ id: "TC-1", ac: 1, title, steps: [], expected }]
//   node sprint-draft.cjs question <sprint> "<text>" [KEY]                           an open question for the planner
//   node sprint-draft.cjs summary <sprint> <KEY> <json-file>                         the ticket summary (Intinya): { acHash, made, checked, notHere,
//                                                                                   waitsOn: [], before, after, line, testData, ui, acId: [], titleId }
//   node sprint-draft.cjs storyboard <EPIC>                                          the newest storyboard version: { version, path, frames, changed }
// Prints DOCK's result as JSON. Exit 0 answered, 3 DOCK refused (its error on stderr), 1 usage error or DOCK did not answer.
const fs = require("fs");
const dock = require("./dock-push.cjs");

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const TC_ID = /^TC-\d+$/;
const USAGE = [
	"usage: node sprint-draft.cjs get <sprint>",
	"       node sprint-draft.cjs update <sprint> <KEY> [--dev <name>] [--wave <n>] [--sp <n>] [--ac-file <file>]",
	"       node sprint-draft.cjs tc <sprint> <KEY> <json-file>",
	"       node sprint-draft.cjs question <sprint> \"<text>\" [KEY]",
	"       node sprint-draft.cjs summary <sprint> <KEY> <json-file>",
	"       node sprint-draft.cjs storyboard <EPIC>",
].join("\n");

const readText = (file, readFile) => String(readFile(file)).replace(/^﻿/, "");
const keyOf = (raw) => String(raw || "").trim().toUpperCase();

function acLines(text) {
	const t = text.trim();
	if (t.startsWith("[")) {
		const list = JSON.parse(t);
		if (!Array.isArray(list) || list.some((l) => typeof l !== "string")) throw new Error("the AC file's JSON must be an array of strings");
		return list.map((l) => l.trim()).filter(Boolean);
	}
	return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Null when the test case fits the contract, else what is wrong with it.
function tcProblem(tc, i) {
	const at = `test case ${i + 1}`;
	if (!tc || typeof tc !== "object") return `${at} is not an object`;
	if (!TC_ID.test(String(tc.id))) return `${at}: id must look like TC-1`;
	if (!Number.isInteger(tc.ac) || tc.ac < 1) return `${tc.id}: ac must be the AC line number (1, 2, ...)`;
	if (!String(tc.title || "").trim()) return `${tc.id}: title is empty`;
	if (!Array.isArray(tc.steps) || !tc.steps.length || tc.steps.some((s) => typeof s !== "string" || !s.trim())) return `${tc.id}: steps must be a non-empty array of strings`;
	if (!String(tc.expected || "").trim()) return `${tc.id}: expected is empty`;
	return null;
}

const SUMMARY_TEXT = ["acHash", "made", "checked", "before", "after", "line"];
const SUMMARY_OPTIONAL = ["notHere", "testData", "titleId"];

// Null when the summary fits DOCK's sprint-draft/summary contract, else what is wrong with it.
function summaryProblem(s) {
	if (!s || typeof s !== "object" || Array.isArray(s)) return "the summary is not an object";
	const empty = SUMMARY_TEXT.find((f) => typeof s[f] !== "string" || !s[f].trim());
	if (empty) return `${empty} must be a non-empty string`;
	const notText = SUMMARY_OPTIONAL.find((f) => s[f] !== undefined && s[f] !== null && typeof s[f] !== "string");
	if (notText) return `${notText} must be a string or null`;
	for (const f of ["waitsOn", "acId"]) if (s[f] !== undefined && (!Array.isArray(s[f]) || s[f].some((l) => typeof l !== "string"))) return `${f} must be an array of strings`;
	const bad = (s.waitsOn || []).find((k) => !KEY.test(keyOf(k)));
	if (bad) return `waitsOn: ${bad} is not a ticket key`;
	if (s.ui !== undefined && typeof s.ui !== "boolean") return "ui must be true or false";
	return null;
}

// argv after the script name -> { route, body, timeoutMs } or { error }.
function request(argv, readFile = (f) => fs.readFileSync(f, "utf8")) {
	const [cmd, ...rest] = argv;
	const sprint = String(rest[0] || "").trim();
	if (cmd === "storyboard") {
		const epic = keyOf(rest[0]);
		return KEY.test(epic) ? { route: "/storyboard", body: { epic }, timeoutMs: 120000 } : { error: "storyboard needs the epic key, e.g. QRD-1400" };
	}
	if (!["get", "update", "tc", "question", "summary"].includes(cmd)) return { error: cmd ? `unknown command ${cmd}` : "no command" };
	if (!sprint) return { error: `${cmd} needs the sprint` };
	if (cmd === "get") return { route: "/sprint-draft/get", body: { sprint }, timeoutMs: 60000 };
	if (cmd === "question") {
		const text = String(rest[1] || "").trim();
		if (!text) return { error: "question needs its text" };
		const key = keyOf(rest[2]);
		if (rest[2] && !KEY.test(key)) return { error: `${rest[2]} is not a ticket key` };
		return { route: "/sprint-draft/question", body: { sprint, text, ...(rest[2] ? { key } : {}) }, timeoutMs: 60000 };
	}
	const key = keyOf(rest[1]);
	if (!KEY.test(key)) return { error: `${cmd} needs a ticket key after the sprint` };
	if (cmd === "tc") {
		if (!rest[2]) return { error: "tc needs the JSON file of test cases" };
		let parsed;
		try { parsed = JSON.parse(readText(rest[2], readFile)); } catch (e) { return { error: `cannot read ${rest[2]}: ${e.message}` }; }
		const tcs = Array.isArray(parsed) ? parsed : parsed?.tcs;
		if (!Array.isArray(tcs) || !tcs.length) return { error: `${rest[2]} holds no test cases (an array, or { "tcs": [...] })` };
		const problem = tcs.map(tcProblem).find(Boolean);
		if (problem) return { error: problem };
		const ids = tcs.map((t) => t.id);
		const twice = ids.find((id, i) => ids.indexOf(id) !== i);
		if (twice) return { error: `${twice} appears twice` };
		return { route: "/sprint-draft/tc", body: { sprint, key, tcs: tcs.map(({ id, ac, title, steps, expected }) => ({ id, ac, title, steps, expected })) }, timeoutMs: 60000 };
	}
	if (cmd === "summary") {
		if (!rest[2]) return { error: "summary needs the JSON file of the summary" };
		let s;
		try { s = JSON.parse(readText(rest[2], readFile)); } catch (e) { return { error: `cannot read ${rest[2]}: ${e.message}` }; }
		const problem = summaryProblem(s);
		if (problem) return { error: problem };
		if (s.key !== undefined && keyOf(s.key) !== key) return { error: `${rest[2]} is the summary of ${s.key}, not ${key}` };
		const { acHash, made, checked, notHere = "", waitsOn = [], before, after, line, testData = null, ui = false, acId = [], titleId = null } = s;
		return { route: "/sprint-draft/summary", body: { sprint, key, acHash, made, checked, notHere, waitsOn: waitsOn.map(keyOf), before, after, line, testData, ui, acId, titleId }, timeoutMs: 60000 };
	}
	const body = { sprint, key };
	const args = rest.slice(2);
	for (let i = 0; i < args.length; i++) {
		const flag = args[i], value = args[i + 1];
		if (!["--dev", "--wave", "--sp", "--ac-file"].includes(flag)) return { error: `unknown option ${flag}` };
		if (value === undefined || value === "") return { error: `${flag} needs a value` };
		i++;
		if (flag === "--dev") body.dev = value.trim();
		else if (flag === "--wave") {
			if (!/^\d+$/.test(value)) return { error: "--wave must be a whole number" };
			body.wave = Number(value);
		} else if (flag === "--sp") {
			if (!/^\d+(\.\d+)?$/.test(value)) return { error: "--sp must be a number" };
			body.sp = Number(value);
		} else {
			try { body.ac = acLines(readText(value, readFile)); } catch (e) { return { error: `cannot read ${value}: ${e.message}` }; }
			if (!body.ac.length) return { error: `${value} holds no AC line` };
		}
	}
	if (Object.keys(body).length === 2) return { error: "update needs at least one of --dev, --wave, --sp, --ac-file" };
	return { route: "/sprint-draft/update", body, timeoutMs: 60000 };
}

async function call(req, send = dock.send) {
	const r = await send(req.route, req.body, req.timeoutMs);
	if (r?.skipped) return { code: 1, why: "DOCK is not configured (dock.json)" };
	if (r?.status === 200 && r.result !== undefined) return { code: 0, result: r.result };
	if (r?.status >= 400 && r.status < 500) return { code: 3, why: `DOCK refused (${r.status})${r.error ? ": " + r.error : ""}` };
	return { code: 1, why: `DOCK answered ${r?.status ?? "nothing"}${r?.error ? " " + r.error : ""}` };
}

async function run(argv, deps = {}) {
	const out = deps.out || ((s) => console.log(s));
	const err = deps.err || ((s) => console.error(s));
	const req = request(argv, deps.readFile);
	if (req.error) {
		err(`sprint-draft: ${req.error}\n${USAGE}`);
		return 1;
	}
	const r = await call(req, deps.send || dock.send);
	if (r.code) err(`sprint-draft: ${r.why}`);
	else out(JSON.stringify(r.result, null, 2));
	return r.code;
}

if (require.main === module) {
	run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`sprint-draft: ${e.message || e}`); process.exitCode = 1; });
} else {
	module.exports = { request, call, run, acLines, tcProblem, summaryProblem };
}
