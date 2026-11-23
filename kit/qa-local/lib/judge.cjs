"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { resolveLocalPaths } = require("./paths.cjs");

// The ticket verdict comes from the QA v2 skill's own script, so the priority rules live in one place.
// It resolves only from QA_COMPUTE_VERDICT or the installed skill (~/.claude/skills/skill-qonflo-qa, put there by qa-skill-sync.sh).
const COMPUTE_VERDICT = resolveLocalPaths().computeVerdict;

const RULES_SOURCE =
	"skill-qonflo-qa/judge.md (\"Pemetaan hasil ke Status\", \"Status tiket\", \"REVISION atau AC-GAP\") and triage-rules.md (\"Setengah bisa diuji\")";

const RULES = [
	{ id: "J-REVISION", verdict: "REVISION", text: "judge.md Status tiket: a Failed TC with finding REVISION wins over everything (the AC promises the behaviour, the code does not do it)." },
	{ id: "J-AC-GAP", verdict: "AC-GAP", text: "judge.md Status tiket: a Failed TC with finding AC-GAP and no REVISION." },
	{ id: "J-ESCALATED", verdict: "ESCALATED", text: "judge.md Status tiket: no Failed TC, but at least one Blocked TC (environment, data, selector or page not loaded, AC not verifiable automatically, or the run never reached the tests)." },
	{ id: "J-LOLOS", verdict: "LOLOS", text: "judge.md Status tiket: every TC is Passed or Passed with Note." },
];

const STATUS_RULES = {
	pass: "judge.md Pemetaan: matches Then, UI and state -> Passed",
	assertion: "judge.md Pemetaan: differs from Then -> Failed (REVISION: the linked AC promises it; Mayor proposed; not confirmed 2 of 2 by this tool)",
	environment: "judge.md Pemetaan: cannot run (env, data, permission, selector) -> Blocked",
	timeout: "judge.md Cara mengeksekusi: selector not found or page not loaded is not a feature FAIL -> Blocked",
	skipped: "judge.md Pemetaan: AC not verifiable automatically, or setup failed -> Blocked",
	missing: "judge.md Pemetaan: cannot run (declared TC has no test) -> Blocked",
	unknown: "judge.md Pemetaan: cannot run -> Blocked",
};

const ENV_PATTERNS = [
	/net::ERR_/,
	/ECONNREFUSED/,
	/ECONNRESET/,
	/browserType\.launch/,
	/Executable doesn't exist/,
	/Target page, context or browser has been closed/,
	/page\.goto: Timeout/,
	/storageState/,
	/Test was interrupted/,
];

const ASSERT_PATTERNS = [/expect\(/, /\bExpected\b/, /\bReceived\b/, /AssertionError/, /toHave|toBe|toContain|toEqual|toMatch/];
const TIMEOUT_PATTERNS = [/Timeout \d+ms exceeded/, /Test timeout of \d+ms exceeded/];

function classify(status, error) {
	const text = String(error || "");
	if (status === "passed") return "pass";
	if (status === "skipped") return "skipped";
	if (status === "missing") return "missing";
	if (status === "interrupted") return "environment";
	if (ENV_PATTERNS.some((re) => re.test(text))) return "environment";
	if (ASSERT_PATTERNS.some((re) => re.test(text))) return "assertion";
	if (status === "timedOut" || TIMEOUT_PATTERNS.some((re) => re.test(text))) return "timeout";
	return "assertion";
}

function qaStatus(t) {
	const row = { qaStatus: "Blocked", finding: null, severity: null, statusRule: STATUS_RULES[t.kind] || STATUS_RULES.unknown };
	if (t.kind === "pass") row.qaStatus = "Passed";
	else if (t.kind === "assertion") Object.assign(row, { qaStatus: "Failed", finding: "REVISION", severity: "Mayor" });
	return row;
}

function acStatus(acLines, tcs) {
	return acLines.map((a) => {
		const linked = tcs.filter((t) => t.ac.includes(a.n));
		let status = "Blocked";
		if (linked.some((t) => t.qaStatus === "Failed")) status = "Failed";
		else if (linked.length && linked.every((t) => t.qaStatus === "Passed" || t.qaStatus === "Passed with Note")) status = "Passed";
		return { n: a.n, ref: `AC-${a.n}`, text: a.text, tcs: linked.map((t) => t.id), status, uncovered: !linked.length };
	});
}

function firstLine(s) {
	return String(s || "").split("\n").find((l) => l.trim()) || "";
}

// Rows for compute-verdict: one per TC, plus a Blocked row for each thing that keeps the ticket from being judged
// in full here (a run that never reached the tests, a test without a TC id, an AC line without a TC).
function verdictRows({ infraError, tcs, acRows }) {
	const rows = tcs.filter((t) => t.hasId !== false).map((t) => (t.qaStatus === "Failed" ? { tc: t.id, status: t.qaStatus, finding: t.finding, severity: t.severity } : { tc: t.id, status: t.qaStatus }));
	const extra = [];
	const ran = tcs.filter((t) => t.kind !== "missing");
	if (infraError || !ran.length) extra.push(`run did not reach the tests (Blocked): ${infraError || "no test ran"}`);
	tcs.filter((t) => t.hasId === false).forEach((t) => extra.push(`test "${t.title}" has no TC id in its title`));
	acRows.filter((a) => a.uncovered).forEach((a) => extra.push(`${a.ref} has no TC`));
	extra.forEach((why, i) => rows.push({ tc: `LOCAL-BLOCKED-${i + 1}`, status: "Blocked", why }));
	return { rows, extra };
}

function computeVerdict(rows) {
	if (!COMPUTE_VERDICT) throw new Error("compute-verdict.mjs not found; run qa-skill-sync.sh so ~/.claude/skills/skill-qonflo-qa is there");
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qa-local-verdict-")), "results.json");
	fs.writeFileSync(file, JSON.stringify(rows.map(({ why, ...r }) => r)));
	try {
		return JSON.parse(execFileSync(process.execPath, [COMPUTE_VERDICT, file], { encoding: "utf8" }));
	} finally {
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	}
}

const RULE_OF = { REVISION: "J-REVISION", "AC-GAP": "J-AC-GAP", ESCALATED: "J-ESCALATED", LOLOS: "J-LOLOS" };

function judge({ infraError, tcs, acRows }) {
	const { rows, extra } = verdictRows({ infraError, tcs, acRows });
	const out = computeVerdict(rows);
	const r = RULES.find((x) => x.id === RULE_OF[out.ticketStatus]);
	const failed = tcs.filter((t) => t.qaStatus === "Failed");
	const blocked = tcs.filter((t) => t.qaStatus === "Blocked").map((t) => `${t.id} Blocked (${t.kind}${t.error || t.notes ? ": " + firstLine(t.error || t.notes) : ""})`);
	const reasons =
		out.ticketStatus === "REVISION" || out.ticketStatus === "AC-GAP"
			? failed.filter((t) => out.ticketStatus === "AC-GAP" || t.finding === "REVISION").map((t) => `${t.id} Failed (${t.finding}, ${t.severity}): ${firstLine(t.error)}`)
			: out.ticketStatus === "ESCALATED"
				? [...extra, ...blocked]
				: [`${tcs.length} TC Passed or Passed with Note, ${acRows.length} AC covered`];
	return { prediction: out.ticketStatus, rule: r.id, ruleText: r.text, reasons, rulesSource: RULES_SOURCE, computedBy: "skill-qonflo-qa/scripts/compute-verdict.mjs", computeVerdict: out };
}

module.exports = { RULES, RULES_SOURCE, STATUS_RULES, classify, qaStatus, acStatus, verdictRows, judge };
