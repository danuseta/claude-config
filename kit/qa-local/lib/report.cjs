"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { classify, qaStatus } = require("./judge.cjs");

const TC_RE = /\b((?:[A-Z][A-Z0-9]*-\d+-)?TC-?\d+[A-Za-z]?)\b/i;

function stripAnsi(s) {
	return String(s || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function walk(suite, parents, out) {
	for (const s of suite.suites || []) walk(s, s.title ? [...parents, s.title] : parents, out);
	for (const spec of suite.specs || []) for (const test of spec.tests || []) out.push({ spec, test, titlePath: [...parents, spec.title] });
}

function moveFile(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	try {
		fs.renameSync(src, dest);
	} catch {
		fs.copyFileSync(src, dest);
	}
}

function uniqueName(dir, base, ext, used) {
	let name = `${base}${ext}`;
	for (let i = 2; used.has(name) || fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
	used.add(name);
	return name;
}

function collect(json, runDir, acDoc) {
	const entries = [];
	for (const s of (json && json.suites) || []) walk(s, [], entries);
	const declared = new Map((acDoc.tcs || []).map((t) => [String(t.id).toUpperCase(), t]));
	const videosDir = path.join(runDir, "videos");
	const used = new Set();
	const tcs = entries.map((e, i) => {
		const m = e.spec.title.match(TC_RE) || e.titlePath.join(" ").match(TC_RE);
		const id = m ? m[1].toUpperCase() : `NOID-${i + 1}`;
		const results = e.test.results || [];
		const r = results[results.length - 1] || {};
		const status = r.status || (e.test.status === "skipped" ? "skipped" : "unknown");
		const errors = [...(r.errors || []).map((x) => x.message || x.value), r.error && r.error.message].filter(Boolean);
		const error = stripAnsi([...new Set(errors)].join("\n")).slice(0, 2000);
		const atts = r.attachments || [];
		const vid = atts.find((a) => a.name === "video" && a.path && fs.existsSync(a.path));
		const shot = atts.find((a) => a.name === "screenshot" && a.path && fs.existsSync(a.path));
		let video = null;
		if (vid) {
			const name = uniqueName(videosDir, id, ".webm", used);
			moveFile(vid.path, path.join(videosDir, name));
			video = `videos/${name}`;
		}
		const dec = declared.get(id);
		const skip = [...(r.annotations || []), ...(e.test.annotations || [])].find((a) => a.type === "skip" && a.description);
		const kind = classify(status, error);
		return {
			id,
			hasId: Boolean(m),
			declared: Boolean(dec),
			title: e.spec.title,
			titlePath: e.titlePath,
			file: e.spec.file,
			line: e.spec.line,
			ac: dec && Array.isArray(dec.ac) ? dec.ac : [],
			user: dec && dec.user ? dec.user : null,
			status,
			kind,
			...qaStatus({ kind }),
			notes: skip ? stripAnsi(skip.description) : null,
			durationMs: r.duration || 0,
			error: error || null,
			video,
			screenshot: shot ? path.relative(runDir, shot.path) : null,
		};
	});
	for (const [id, dec] of declared) {
		if (tcs.some((t) => t.id === id)) continue;
		tcs.push({ id, hasId: true, declared: true, title: dec.title || "", titlePath: [], file: null, line: null, ac: dec.ac || [], user: dec.user || null, status: "missing", kind: "missing", ...qaStatus({ kind: "missing" }), notes: null, durationMs: 0, error: "declared in ac.json but no Playwright test carries this id", video: null, screenshot: null });
	}
	return tcs;
}

function git(dir, args) {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 10000 });
	return r.status === 0 ? String(r.stdout).trim() : null;
}

function gitInfo(dir) {
	if (!dir) return {};
	const dirty = git(dir, ["status", "--porcelain", "--untracked-files=no"]);
	return { branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(dir, ["rev-parse", "--short", "HEAD"]), dirtyFiles: dirty === null ? null : dirty.split("\n").filter(Boolean).length };
}

function counts(tcs) {
	const c = { Passed: 0, "Passed with Note": 0, Failed: 0, Blocked: 0 };
	for (const t of tcs) c[t.qaStatus]++;
	return c;
}

function cell(s) {
	return String(s === null || s === undefined ? "" : s).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function tcList(r, status) {
	return r.tcs.filter((t) => t.qaStatus === status).map((t) => `${t.id.replace(`${r.key}-`, "")} ${t.ac.map((n) => `AC-${n}`).join("/")}`);
}

function summaryMd(r) {
	const c = r.counts;
	const v = r.verdict;
	const part = (status) => `${status} ${c[status]}${c[status] ? ` (${tcList(r, status).join(", ")})` : ""}`;
	const lines = [];
	lines.push(`# Run summary ${r.runId}`, "");
	lines.push(`**${r.key}**: TEST local round 1, status **${v.prediction}** (prediction, rule ${v.rule}). No Jira label, no transition, no Confluence row.`);
	lines.push(`- ${["Passed", "Passed with Note", "Failed", "Blocked"].map(part).join(", ")}.`);
	for (const x of v.reasons) lines.push(`- ${x}`);
	lines.push(`- Rule: ${v.ruleText} Source: ${v.rulesSource}.`);
	const vids = r.tcs.filter((t) => t.video).map((t) => t.video);
	lines.push(`- Evidence: ${vids.length ? vids.join(", ") : "no video"}.`);
	lines.push(`- Stack: ${["be", "fe"].map((p) => { const s = r.stack[p] || {}; return `${p} ${cell(s.dir)} ${cell(s.branch)}@${cell(s.commit)} ${cell(s.url)}`; }).join("; ")}. Stopped: ${r.stack.stopped.length ? r.stack.stopped.join("; ") : "nothing started by this run"}.`);
	if (r.infraError) lines.push(`- Run error: ${cell(r.infraError).slice(0, 500)}`);
	lines.push("", "## Test cases", "", "| TC ID | AC Ref | Test Scenario | Status | Finding | Severity | Actual Result | Notes | Evidence |", "|---|---|---|---|---|---|---|---|---|");
	for (const t of r.tcs) {
		const actual = t.qaStatus === "Passed" ? "As expected" : cell((t.error || "").split("\n")[0]).slice(0, 200);
		const notes = [t.notes, t.statusRule, t.user ? `user ${t.user}` : null, `${(t.durationMs / 1000).toFixed(1)} s`].filter(Boolean).join("; ");
		lines.push(`| ${t.id} | ${t.ac.map((n) => `AC-${n}`).join(", ")} | ${cell(t.title)} | ${t.qaStatus} | ${t.finding || ""} | ${t.severity || ""} | ${actual} | ${cell(notes)} | ${t.video ? `[${path.basename(t.video)}](${t.video})` : ""} |`);
	}
	lines.push("", "## AC coverage", "", "| AC Ref | Text | TC | Status |", "|---|---|---|---|");
	for (const a of r.ac) lines.push(`| ${a.ref} | ${cell(a.text)} | ${a.tcs.join(", ")} | ${a.status} |`);
	lines.push("", "## Files", "", "- results.json", "- videos/", "- logs/ (be.log, fe.log, login-*.log, playwright.log)", "- pw-report.json, pw-output/", "- stack.json", "");
	return lines.join("\n");
}

function write(runDir, results) {
	const durationSec = Math.round((Date.parse(results.finishedAt) - Date.parse(results.startedAt)) / 1000) || 0;
	results.tickets = [{ ticket: results.key, action: "TEST", round: 1, ticketStatus: results.verdict.prediction, counts: results.counts, flaky: 0, transition: "SKIP", reason: results.verdict.reasons.join("; ").slice(0, 1000), durationSec }];
	results.verdictIn = results.tcs.map((t) => (t.qaStatus === "Failed" ? { tc: t.id, status: t.qaStatus, finding: t.finding, severity: t.severity } : { tc: t.id, status: t.qaStatus }));
	fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
	fs.writeFileSync(path.join(runDir, "summary.md"), summaryMd(results));
}

module.exports = { collect, gitInfo, counts, summaryMd, write, TC_RE };
