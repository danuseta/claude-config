// The Planning chat's way into DOCK's sprint draft (dock /ingest/orchestrator/sprint-draft/* and /storyboard). Used by the
// sprint-planner and storyboard-reader skills; it never writes to Jira or Confluence, DOCK publishes the draft when the planner says so.
//   node sprint-draft.cjs get <sprint>                                              the draft: tickets, after-it findings, predictions
//   node sprint-draft.cjs update <sprint> <KEY> [--dev <name>] [--wave <n>] [--sp <n>] [--ac-file <file>]
//                                                                                   --ac-file: one AC line per non-empty line, or a JSON array
//   node sprint-draft.cjs tc <sprint> <KEY> <json-file>                              test cases: [{ id: "TC-1", ac: 1, title, steps: [], expected }]
//   node sprint-draft.cjs question <sprint> "<text>" [KEY]                           an open question for the planner
//   node sprint-draft.cjs summary <sprint> <KEY> <json-file>                         the ticket summary (Intinya): { acHash, made, checked, notHere,
//                                                                                   waitsOn: [], before, after, line, testData, ui, acId: [], titleId }
//   node sprint-draft.cjs visual put <sprint> --title "<title>" --file <page.html> [--id <id>]   a self-contained HTML page in the Planning panel
//   node sprint-draft.cjs visual rm <sprint> --id <id>                              remove it; put with the same id replaces it
//   node sprint-draft.cjs new <sprint> --file <draft.json> [--id NEW-n]              a new ticket draft: { summary, type, epic, dev, sp, priority, userStory,
//                                                                                   problem, ac: [], reference, source }; prints its NEW-n id, --id replaces it
//   node sprint-draft.cjs new rm <sprint> --id NEW-n                                 remove a new ticket draft
//   node sprint-draft.cjs revise <sprint> --key QRD-n --file <rev.json>              a proposed rewrite of a ticket that exists in Jira: { summary, type, userStory,
//                                                                                   problem, ac: [], reference, openToConfirm, note, source }; only the fields given;
//                                                                                   prints the before/after DOCK read from Jira, one field per block
//   node sprint-draft.cjs revise rm <sprint> --key QRD-n                             discard the pending revision of that ticket
//   node sprint-draft.cjs sheet <google-sheet-url>                                   the sheet's rows as [{ row, cells }]; rows with a Jira Ticket are skipped
//   node sprint-draft.cjs storyboard <EPIC>                                          the newest storyboard version: { version, path, frames, changed }
// Prints DOCK's result as JSON. Exit 0 answered, 3 DOCK refused (its error on stderr), 1 usage error or DOCK did not answer.
const fs = require("fs");
const dock = require("./dock-push.cjs");

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const TC_ID = /^TC-\d+$/;
const NEW_ID = /^NEW-\d+$/;
const NEW_FIELDS = ["summary", "type", "epic", "dev", "sp", "priority", "userStory", "problem", "ac", "reference", "source"];
const REVISE_FIELDS = ["summary", "type", "userStory", "problem", "ac", "reference", "openToConfirm", "note", "source"];
const TICKET_TYPES = ["Task", "Story", "Bug"];
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const VISUAL_ID = /^[a-z0-9-]{1,40}$/;
const VISUAL_MAX_BYTES = 2 * 1024 * 1024;
const USAGE = [
	"usage: node sprint-draft.cjs get <sprint>",
	"       node sprint-draft.cjs update <sprint> <KEY> [--dev <name>] [--wave <n>] [--sp <n>] [--ac-file <file>]",
	"       node sprint-draft.cjs tc <sprint> <KEY> <json-file>",
	"       node sprint-draft.cjs question <sprint> \"<text>\" [KEY]",
	"       node sprint-draft.cjs summary <sprint> <KEY> <json-file>",
	"       node sprint-draft.cjs visual put <sprint> --title \"<title>\" --file <page.html> [--id <id>]",
	"       node sprint-draft.cjs visual rm <sprint> --id <id>",
	"       node sprint-draft.cjs new <sprint> --file <draft.json> [--id NEW-n]",
	"       node sprint-draft.cjs new rm <sprint> --id NEW-n",
	"       node sprint-draft.cjs revise <sprint> --key QRD-n --file <rev.json>",
	"       node sprint-draft.cjs revise rm <sprint> --key QRD-n",
	"       node sprint-draft.cjs sheet <google-sheet-url>",
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

function visualRequest(rest, readFile) {
	const [action, sprintRaw, ...args] = rest;
	const sprint = String(sprintRaw || "").trim();
	if (!["put", "rm"].includes(action)) return { error: action ? `unknown visual action ${action}` : "visual needs put or rm" };
	if (!sprint) return { error: `visual ${action} needs the sprint` };
	const opt = {};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i], value = args[i + 1];
		if (!["--title", "--file", "--id"].includes(flag)) return { error: `unknown option ${flag}` };
		if (value === undefined || value === "") return { error: `${flag} needs a value` };
		opt[flag.slice(2)] = value;
		i++;
	}
	if (opt.id !== undefined && !VISUAL_ID.test(opt.id)) return { error: "--id must be 1-40 characters of a-z, 0-9 and -" };
	if (action === "rm") {
		if (opt.id === undefined) return { error: "visual rm needs --id" };
		if (opt.title !== undefined || opt.file !== undefined) return { error: "visual rm takes only --id" };
		return { route: "/sprint-draft/visual", body: { sprint, action, id: opt.id }, timeoutMs: 60000 };
	}
	const title = String(opt.title || "").trim();
	if (!title || title.length > 60) return { error: "--title must be 1-60 characters" };
	if (!opt.file) return { error: "visual put needs --file <page.html>" };
	if (!/\.html$/i.test(opt.file)) return { error: `${opt.file} must be an .html file` };
	let html;
	try { html = readText(opt.file, readFile); } catch (e) { return { error: `cannot read ${opt.file}: ${e.message}` }; }
	if (!html.trim()) return { error: `${opt.file} is empty` };
	if (Buffer.byteLength(html) > VISUAL_MAX_BYTES) return { error: `${opt.file} is over 2 MB` };
	return { route: "/sprint-draft/visual", body: { sprint, action, ...(opt.id !== undefined ? { id: opt.id } : {}), title, html }, timeoutMs: 60000 };
}

// Null when the new ticket fits the sprint-draft/new limits, else what is wrong with it.
function newTicketProblem(t) {
	if (!t || typeof t !== "object" || Array.isArray(t)) return "the draft is not an object";
	const summary = typeof t.summary === "string" ? t.summary.trim() : "";
	if (!summary || summary.length > 200) return "summary must be 1-200 characters";
	if (t.type !== undefined && !TICKET_TYPES.includes(t.type)) return "type must be Task, Story or Bug";
	if (t.priority !== undefined && t.priority !== null && !PRIORITIES.includes(t.priority)) return "priority must be Highest, High, Medium, Low or Lowest";
	if (t.sp !== undefined && t.sp !== null && (typeof t.sp !== "number" || !Number.isFinite(t.sp) || t.sp < 0 || t.sp > 100)) return "sp must be a number from 0 to 100";
	for (const [f, max] of [["userStory", 4000], ["problem", 4000], ["reference", 2000]]) {
		if (t[f] === undefined || t[f] === null) continue;
		if (typeof t[f] !== "string") return `${f} must be a string`;
		if (t[f].length > max) return `${f} is over ${max} characters`;
	}
	for (const f of ["epic", "dev", "source"]) if (t[f] !== undefined && t[f] !== null && typeof t[f] !== "string") return `${f} must be a string`;
	if (t.epic && !KEY.test(keyOf(t.epic))) return "epic must be an existing epic key, e.g. QRD-1400";
	if (t.ac !== undefined) {
		if (!Array.isArray(t.ac) || t.ac.some((l) => typeof l !== "string")) return "ac must be an array of strings";
		if (t.ac.length > 40) return "ac has more than 40 lines";
		if (t.ac.some((l) => l.length > 1000)) return "an ac line is over 1000 characters";
	}
	return null;
}

function newRequest(rest, readFile) {
	const remove = rest[0] === "rm";
	const [sprintRaw, ...args] = remove ? rest.slice(1) : rest;
	const sprint = String(sprintRaw || "").trim();
	if (!sprint) return { error: `new${remove ? " rm" : ""} needs the sprint` };
	const opt = {};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i], value = args[i + 1];
		if (!["--file", "--id"].includes(flag)) return { error: `unknown option ${flag}` };
		if (value === undefined || value === "") return { error: `${flag} needs a value` };
		opt[flag.slice(2)] = value;
		i++;
	}
	const id = opt.id === undefined ? undefined : opt.id.trim().toUpperCase();
	if (id !== undefined && !NEW_ID.test(id)) return { error: "--id must look like NEW-1" };
	if (remove) {
		if (id === undefined) return { error: "new rm needs --id" };
		if (opt.file !== undefined) return { error: "new rm takes only --id" };
		return { route: "/sprint-draft/new", body: { sprint, id, remove: true }, timeoutMs: 60000 };
	}
	if (!opt.file) return { error: "new needs --file <draft.json>" };
	let t;
	try { t = JSON.parse(readText(opt.file, readFile)); } catch (e) { return { error: `cannot read ${opt.file}: ${e.message}` }; }
	const problem = newTicketProblem(t);
	if (problem) return { error: problem };
	const ticket = {};
	for (const f of NEW_FIELDS) if (t[f] !== undefined) ticket[f] = t[f];
	ticket.summary = ticket.summary.trim();
	if (ticket.epic) ticket.epic = keyOf(ticket.epic);
	return { route: "/sprint-draft/new", body: { sprint, ...(id !== undefined ? { id } : {}), ticket }, timeoutMs: 60000 };
}

// Null when the revision fits the sprint-draft/revise limits, else what is wrong with it.
function revisionProblem(r) {
	if (!r || typeof r !== "object" || Array.isArray(r)) return "the revision is not an object";
	const unknown = Object.keys(r).find((f) => !REVISE_FIELDS.includes(f));
	if (unknown) return `${unknown} is not a field a revision may change (allowed: ${REVISE_FIELDS.join(", ")})`;
	if (r.summary !== undefined && r.summary !== null) {
		if (typeof r.summary !== "string") return "summary must be a string";
		if (!r.summary.trim() || r.summary.trim().length > 200) return "summary must be 1-200 characters";
	}
	if (r.type !== undefined && r.type !== null && !TICKET_TYPES.includes(r.type)) return "type must be Task, Story or Bug";
	if (r.source !== undefined && r.source !== null && !["chat", "manual"].includes(r.source)) return "source must be chat or manual";
	for (const [f, max] of [["userStory", 4000], ["problem", 4000], ["openToConfirm", 4000], ["reference", 2000], ["note", 500]]) {
		if (r[f] === undefined || r[f] === null) continue;
		if (typeof r[f] !== "string") return `${f} must be a string`;
		if (r[f].length > max) return `${f} is over ${max} characters`;
	}
	for (const f of ["note", "source"]) if (r[f] !== undefined && r[f] !== null && typeof r[f] !== "string") return `${f} must be a string`;
	if (r.ac !== undefined && r.ac !== null) {
		if (!Array.isArray(r.ac) || r.ac.some((l) => typeof l !== "string")) return "ac must be an array of strings";
		if (r.ac.length > 40) return "ac has more than 40 lines";
		if (r.ac.some((l) => l.length > 1000)) return "an ac line is over 1000 characters";
	}
	if (!Object.keys(r).some((f) => !["note", "source"].includes(f) && r[f] !== undefined && r[f] !== null)) return "the revision changes no field";
	return null;
}

function reviseRequest(rest, readFile) {
	const remove = rest[0] === "rm";
	const [sprintRaw, ...args] = remove ? rest.slice(1) : rest;
	const sprint = String(sprintRaw || "").trim();
	if (!sprint) return { error: `revise${remove ? " rm" : ""} needs the sprint` };
	const opt = {};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i], value = args[i + 1];
		if (!["--file", "--key"].includes(flag)) return { error: `unknown option ${flag}` };
		if (value === undefined || value === "") return { error: `${flag} needs a value` };
		opt[flag.slice(2)] = value;
		i++;
	}
	if (opt.key === undefined) return { error: `revise${remove ? " rm" : ""} needs --key QRD-n` };
	const key = keyOf(opt.key);
	if (!KEY.test(key)) return { error: "--key must look like QRD-1602" };
	if (remove) {
		if (opt.file !== undefined) return { error: "revise rm takes only --key" };
		return { route: "/sprint-draft/revise", body: { sprint, key, remove: true }, timeoutMs: 60000 };
	}
	if (!opt.file) return { error: "revise needs --file <rev.json>" };
	let r;
	try { r = JSON.parse(readText(opt.file, readFile)); } catch (e) { return { error: `cannot read ${opt.file}: ${e.message}` }; }
	const problem = revisionProblem(r);
	if (problem) return { error: problem };
	const revision = {};
	for (const f of REVISE_FIELDS) if (r[f] !== undefined) revision[f] = r[f];
	if (typeof revision.summary === "string") revision.summary = revision.summary.trim();
	return { route: "/sprint-draft/revise", body: { sprint, key, revision }, timeoutMs: 60000 };
}

const reviseLines = (list) => (list && list.length ? list.map((l) => `  ${l}`) : ["  (empty)"]);

// One block per changed field: label, then the Jira value and the proposed one.
function revisionText(result) {
	const rev = result?.revision;
	const blocks = (rev?.fields || []).map((f) => [`## ${f.label || f.name} (${f.name})`, "before:", ...reviseLines(f.before), "after:", ...reviseLines(f.after)].join("\n"));
	return [`${result.key}${rev?.summary ? ` ${rev.summary}` : ""}`, ...(rev?.note ? [`note: ${rev.note}`] : []), ...blocks].join("\n\n");
}

// RFC 4180 CSV: quoted cells, doubled quotes, newlines inside quotes, CRLF.
function parseCsv(text) {
	const rows = [];
	let row = [], cell = "", quoted = false, started = false;
	const endCell = () => { row.push(cell); cell = ""; started = false; };
	const endRow = () => { endCell(); rows.push(row); row = []; };
	const src = text.replace(/^﻿/, "");
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c !== '"') cell += c;
			else if (src[i + 1] === '"') { cell += '"'; i++; }
			else quoted = false;
		} else if (c === '"' && !started) { quoted = true; started = true; }
		else if (c === ",") endCell();
		else if (c === "\r" || c === "\n") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			endRow();
		} else { cell += c; started = true; }
	}
	if (started || cell || row.length) endRow();
	return rows;
}

function sheetCsvUrl(raw) {
	let u;
	try { u = new URL(String(raw || "").trim()); } catch { return null; }
	const id = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname)?.[1];
	if (u.hostname !== "docs.google.com" || !id) return null;
	const gid = /(?:^|[?&#])gid=(\d+)/.exec(u.search + u.hash)?.[1];
	return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

// Rows of the sheet that have no Jira Ticket yet: [{ row, cells }], row = sheet row number (header is row 1).
function sheetRows(csv) {
	const [header = [], ...body] = parseCsv(csv);
	const names = header.map((h) => h.trim());
	const jira = names.findIndex((h) => h.toLowerCase() === "jira ticket");
	const rows = [];
	body.forEach((cells, i) => {
		if (cells.every((c) => !c.trim())) return;
		if (jira >= 0 && (cells[jira] || "").trim()) return;
		const out = {};
		names.forEach((h, n) => { if (h) out[h] = cells[n] ?? ""; });
		rows.push({ row: i + 2, cells: out });
	});
	return rows;
}

async function sheet(rest, doFetch) {
	const url = sheetCsvUrl(rest[0]);
	if (!url) return { code: 1, usage: true, why: "sheet needs a Google Sheets link, e.g. https://docs.google.com/spreadsheets/d/<id>/edit#gid=0" };
	let res, text;
	try {
		res = await doFetch(url, { redirect: "follow" });
		text = await res.text();
	} catch (e) { return { code: 1, why: `cannot fetch the sheet: ${e.message}` }; }
	const type = String(res.headers?.get?.("content-type") || "");
	if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) return { code: 1, why: 'the answer is a web page, not CSV: the sheet is not shared with "anyone with the link"' };
	if (!res.ok) return { code: 1, why: `the sheet answered ${res.status}; share it as "anyone with the link can view"` };
	return { code: 0, result: sheetRows(text) };
}

// argv after the script name -> { route, body, timeoutMs } or { error }.
function request(argv, readFile = (f) => fs.readFileSync(f, "utf8")) {
	const [cmd, ...rest] = argv;
	if (cmd === "visual") return visualRequest(rest, readFile);
	if (cmd === "new") return newRequest(rest, readFile);
	if (cmd === "revise") return reviseRequest(rest, readFile);
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
	if (argv[0] === "sheet") {
		const s = await sheet(argv.slice(1), deps.fetch || fetch);
		if (s.code) err(`sprint-draft: ${s.why}${s.usage ? "\n" + USAGE : ""}`);
		else out(JSON.stringify(s.result, null, 2));
		return s.code;
	}
	const req = request(argv, deps.readFile);
	if (req.error) {
		err(`sprint-draft: ${req.error}\n${USAGE}`);
		return 1;
	}
	const r = await call(req, deps.send || dock.send);
	if (r.code) err(`sprint-draft: ${r.why}`);
	else if (argv[0] === "visual" && argv[1] === "put" && r.result?.id) out(`${r.result.id}\n${JSON.stringify(r.result, null, 2)}`);
	else if (argv[0] === "new" && argv[1] !== "rm" && r.result?.id) out(`${r.result.id}\n${JSON.stringify(r.result, null, 2)}`);
	else if (argv[0] === "revise" && argv[1] !== "rm" && r.result?.revision) out(revisionText(r.result));
	else out(JSON.stringify(r.result, null, 2));
	return r.code;
}

if (require.main === module) {
	run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`sprint-draft: ${e.message || e}`); process.exitCode = 1; });
} else {
	module.exports = { request, call, run, acLines, tcProblem, summaryProblem, newTicketProblem, revisionProblem, revisionText, parseCsv, sheetCsvUrl, sheetRows };
}
