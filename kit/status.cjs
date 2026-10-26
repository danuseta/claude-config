// Ticket status ledger: one JSON per ticket under E:/qonflo/.evidence/<KEY>/status.json.
//   node status.cjs                      -> table of every ticket
//   node status.cjs show KEY             -> one ticket with its AC lines
//   node status.cjs init KEY "title" bePort fePort beDir feDir
//   node status.cjs set KEY stage=<stage> [waiting="..."] [pr.be=..] [note="..."] [kind=ticket|review|card] [engine=sous]
//                       [productionData=true|false] [draft=true|false] [rounds.max=<n>]   (kind=card needs a CARD-<slug> key)
//                       [stackedOn=<PARENT>] -> base each repo on the parent's open PR head (gh pr view); stackedOn= clears it
//                       [board=<EPIC>]   -> the ticket's board moves into its epic's: <evidence>/blackboard/<EPIC>/tickets/KEY, with
//                                           prompts/, materials/ and EPIC.md at the epic root; board= clears it
//   node status.cjs ac KEY <n> <PASS|FAIL|TODO> "<text>" ["<evidence>"]
//   node status.cjs brief KEY "<text>" | @<file>   -> the working brief a fresh session starts from
//   node status.cjs decide KEY "<decision and why>" [--status SHOV|USULAN|DECIDED] [--by owner|arbiter|sous|agent] [--issue n]
//                      [--effect "<what changes for the user>"] [--alt "<other option>::<its effect>"]... [--replaces n]
//                                                     -> D-n appended to decisions[], never overwritten (no flags: DECIDED by owner);
//                                                        --replaces n marks D-n SUPERSEDED (the owner changed it from DOCK)
//   node status.cjs issue KEY <BLOCKER|QUESTION|RISK|DISPUTE> "<text>" [--options "A::effect of A|B::effect of B"] -> I-n, open at level arbiter
//   node status.cjs issue KEY <n> escalate sous|owner "<why>" -> owner sets waiting to "I-<n>: <text> [A|B]" and draft
//   node status.cjs issue KEY <n> resolve <decisionN> -> resolved by D-<decisionN>; clears waiting when it was this issue
//   node status.cjs round KEY ["<why>"]             -> one review-to-task return round; past rounds.max (default 2) an owner issue and draft
//   node status.cjs lock <name> KEY [--wait <s>] [--pid <n>] | unlock <name> KEY -> one heavy step per machine (stale: dead pid or 30 min)
//   node status.cjs render KEY                       -> status.md, decisions.md, issues.md, NOW.md under <evidence>/blackboard/KEY (generated);
//                                                     with board=<EPIC> under <EPIC>/tickets/KEY, plus <EPIC>/EPIC.md
//   node status.cjs sync [KEY] [--hook]            -> pull PR state from GitHub: fills pr.be / pr.fe, retargets a stacked PR once its parent merged, moves commit -> pr when a PR
//                                                     exists and pr -> done when every PR is merged. Two gh calls whatever the ticket count.
//   node status.cjs ac-set KEY @<file> [jiraUpdated] -> AC rows from Jira, one capability per line; stamps the source and locks the row count
//   node status.cjs stale [KEY jiraUpdated [@<file>]] -> compare the stamp with Jira; a stale ledger refuses PASS and done until ac-set runs again
//   node status.cjs handoff KEY <who> status=.. summary=.. evidence=.. where=.. assumptions=.. open=.. unverified=..  | @<file.json>
//   node status.cjs fail KEY <transient|defect|spec|env|permission> "<evidence>" ["<what failed>"] -> typed failure with an attempt count
//   node status.cjs assume KEY "<assumption>" "<what would prove it wrong>"  |  assume KEY <n> <confirmed|refuted> "<evidence>"
//   node status.cjs replan KEY "<reason>"            -> counted against replanBudget (default 2, set KEY replanBudget=<n> at the gate)
//   node status.cjs finding KEY [--severity blocker|non-blocking|nit] "<text>" -> a reviewer finding (default non-blocking)
//   node status.cjs finding KEY <n> resolve "<why>"  -> finding #n no longer applies (the AC changed, the author fixed it); kept, marked resolved
//   node status.cjs lgtm KEY "<part>"                -> a part of the change the reviewer found fine
//   node status.cjs verdict KEY approve|request-change [--ticket KEY] [--pr <url>]... -> the review verdict with the reviewed ticket and
//                                                     PR urls (default: KEY and pr.be / pr.fe); approve is refused while an unresolved blocker is recorded
//   node status.cjs metrics                          -> closing numbers per ticket and per work type
//   node status.cjs remote                           -> the tickets DOCK knows: owner machine, offered to, local ledger or not
//   node status.cjs handover KEY --to <machine> [--note "..."] -> offer a pushed ticket to another machine; save then refuses here
//   node status.cjs pull KEY [--force]               -> accept a ticket offered to this machine and write its ledger here
// Refusals print REFUSED and exit 2. PASS needs evidence that exists and a recorded handoff, FAIL needs evidence of what failed; done needs a handoff with proof.
// QONFLO_EVIDENCE=<dir> points the ledger at a scratch copy and switches the DOCK mirror off.
const fs = require("fs");
const path = require("path");
const PATHS = require("./paths.cjs").resolvePaths();
const ROOT = process.env.QONFLO_EVIDENCE || PATHS.evidence;
const SCRATCH = Boolean(process.env.QONFLO_EVIDENCE);
const SPRINT = path.join(ROOT, "sprint.md");
const TYPES = ["procedure", "project", "discovery"];
const FAILS = {
	transient: "retry, at most twice",
	defect: "fix round on exactly what failed",
	spec: "stop and take the two readings to the owner",
	env: "fix the environment, leave the code alone",
	permission: "stop and ask the owner, never assume consent",
};
const HANDOFF = ["status", "summary", "evidence", "where", "assumptions", "open", "unverified"];
const FIX_FROM = ["test", "verify", "evidence", "commit", "pr"];
const STAGES = ["gate", "plan", "code", "test", "verify", "evidence", "commit", "pr", "done", "blocked"];
const SEVERITIES = ["blocker", "non-blocking", "nit"];
const VERDICTS = ["approve", "request-change"];
const KINDS = ["ticket", "review", "card"];
const CARD_KEY = /^CARD-[a-z0-9][a-z0-9-]{0,63}$/;
const DECISION_SET = ["SHOV", "USULAN", "DECIDED"];
const DECIDERS = ["owner", "arbiter", "sous", "agent"];
const ISSUE_TYPES = ["BLOCKER", "QUESTION", "RISK", "DISPUTE"];
const BOOLEANS = ["productionData", "draft"];
const BOARD = path.join(ROOT, "blackboard");
const EPIC_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const LOCKS = path.join(ROOT, ".locks");
const LOCK_STALE_MS = 30 * 60 * 1000;
const file = (key) => path.join(ROOT, key, "status.json");
const load = (key) => (fs.existsSync(file(key)) ? JSON.parse(fs.readFileSync(file(key), "utf8")) : null);
const save = (key, s, allowHanded = false) => {
	const prev = allowHanded ? null : load(key);
	if (prev?.handedTo) return refuse(`${key} was handed over to ${prev.handedTo}; it is changed there. \`status.cjs pull ${key}\` takes it back`);
	fs.mkdirSync(path.dirname(file(key)), { recursive: true });
	s.updatedAt = new Date().toISOString();
	if (s.engine === "sous") stampBoard(key, s);
	fs.writeFileSync(file(key), JSON.stringify(s, null, 2));
	if (s.engine === "sous") try { renderBoard(key, s); } catch {}
	// Mirror the ledger to DOCK when it is configured; a no-op otherwise.
	if (SCRATCH) return;
	try { require("./dock-push.cjs").pushStatusDetached(key); } catch {}
};
const setPath = (obj, dotted, value) => {
	const keys = dotted.split(".");
	let o = obj;
	for (const k of keys.slice(0, -1)) o = o[k] ??= {};
	o[keys.at(-1)] = value;
};
const age = (iso) => {
	const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
	return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const now = () => new Date().toISOString();
const refuse = (msg) => {
	console.log(`REFUSED: ${msg}`);
	process.exitCode = 2;
};
const fromArg = (arg) => {
	if (!arg.startsWith("@")) return arg;
	if (!fs.existsSync(arg.slice(1))) {
		console.log(`REFUSED: no such file ${arg.slice(1)}`);
		process.exit(2);
	}
	return fs.readFileSync(arg.slice(1), "utf8").trim();
};
const acLines = (text) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s*)/, "").trim()).filter(Boolean);
const acHash = (lines) => require("crypto").createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 12);
const sameTime = (a, b) => (Number.isNaN(Date.parse(a)) || Number.isNaN(Date.parse(b)) ? a === b : Date.parse(a) === Date.parse(b));
// Why an evidence string cannot back a PASS, or null when it can. A token counts as a path when it is drive-absolute or has a
// folder and a file extension; such a path must exist, either as written or under the ticket's worktrees or evidence folder.
const evidenceProblem = (s, evidence) => {
	const e = (evidence || "").trim();
	if (!e) return "no evidence given";
	const vague = e.match(/\b(pending|todo|tbd|belum|menyusul)\b/i);
	if (vague) return `evidence says "${vague[0]}"`;
	for (const raw of e.split(/[\s,;]+/)) {
		const p = raw.replace(/^["'`(]+|["'`).]+$/g, "").replace(/(:\d+(-\d+)?)+$/, "").replace(/^\/([a-zA-Z])\//, "$1:/");
		if (/^https?:/i.test(p)) continue;
		const absolute = /^[A-Za-z]:[\\/]/.test(p) || path.isAbsolute(p);
		if (!absolute && !(/[\\/]/.test(p) && /\.\w{1,5}$/.test(p))) continue;
		const tries = absolute ? [p] : [s.dirs?.be, s.dirs?.fe, path.join(ROOT, s.key)].filter(Boolean).map((d) => path.join(d, p));
		if (!tries.some((c) => fs.existsSync(c))) return `evidence path not found: ${p}`;
	}
	return null;
};
// The newest handoff of each member; an older one is superseded by that member's next report.
const latestHandoffs = (s) => Object.values(Object.fromEntries((s.handoffs ?? []).map((h) => [h.who, h])));
const closing = (s, end) => {
	const history = s.history ?? [];
	const start = s.createdAt ?? history[0]?.at ?? s.decisions?.[0]?.at ?? null;
	const failures = {};
	for (const x of s.failures ?? []) failures[x.type] = (failures[x.type] ?? 0) + 1;
	return {
		at: end,
		hours: start ? Math.round((new Date(end) - new Date(start)) / 360000) / 10 : null,
		fixRounds: history.filter((h) => h.to === "code" && FIX_FROM.includes(h.from)).length,
		failures,
		replans: (s.replans ?? []).length,
	};
};
const moveStage = (s, to) => {
	const from = s.stage;
	if (from === to) return;
	s.stage = to;
	(s.history ??= []).push({ at: now(), from: from ?? null, to });
	if (to === "done") s.closing = closing(s, now());
};
const flags = (s) => {
	const out = [];
	if (s.source?.stale) out.push("STALE");
	const unproven = latestHandoffs(s).filter((h) => !h.proven).length;
	if (unproven) out.push(`${unproven} unproven`);
	const open = (s.assumptions ?? []).filter((a) => a.state === "open").length;
	if (open) out.push(`${open} assumed`);
	return out.join(", ") || "-";
};
const fwd = (p) => String(p).replace(/\\/g, "/");
// `--name value` pairs (repeatable) taken out of an argument list; what is left are the words.
const takeFlags = (args, names) => {
	const out = {}, words = [];
	for (let i = 0; i < args.length; i++) {
		if (names.includes(args[i])) (out[args[i]] ??= []).push(args[++i] ?? "");
		else words.push(args[i]);
	}
	return { flags: out, words };
};
// Entries written before D-n numbering carry no n, status or by: they read as their position, DECIDED by the owner.
const decisionsOf = (s) => (s.decisions ?? []).map((d, i) => ({ ...d, n: d.n ?? i + 1, status: d.status ?? "DECIDED", by: d.by ?? "owner" }));
const issueOf = (s, n) => (s.issues ?? []).find((x) => x.n === Number(n));
// "<label>::<effect>": an option and what choosing it changes; the effect part is optional.
const optionOf = (raw) => {
	const [label, ...effect] = String(raw).split("::");
	return { label: label.trim(), effect: effect.join("::").trim() };
};
const stamp = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "-");
const line = (t) => String(t ?? "").replace(/\r?\n/g, " ");
const cell = (t) => line(t).replace(/\|/g, "\\|");
const IN_FORCE = ["DECIDED", "SHOV", "USULAN"];
// Where a ticket's board lives: its own folder, or tickets/KEY inside its epic's board, whose root holds the shared files.
const boardOf = (key, s) => {
	if (!s?.board) return { dir: path.join(BOARD, key), root: null };
	const root = path.join(BOARD, s.board);
	return { dir: path.join(root, "tickets", key), root };
};
const stampBoard = (key, s) => {
	const b = boardOf(key, s);
	s.blackboard = fwd(b.dir);
	if (b.root) s.epicBoard = fwd(b.root);
	else delete s.epicBoard;
};
// The epic index: every ledger on this epic's board, with the sessions whose prompt names the ticket on its first line.
const renderEpic = (epic, root) => {
	const keys = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((k) => fs.existsSync(file(k))) : [];
	const dir = path.join(root, "prompts");
	const prompts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^S\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))) : [];
	const heads = prompts.map((f) => { try { return [f.slice(0, -3), fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)[0]]; } catch { return [f.slice(0, -3), ""]; } });
	const rows = keys.map(load).filter((t) => t?.board === epic).map((t) => {
		const own = new RegExp(`(^|[^0-9A-Za-z])${t.key}([^0-9]|$)`);
		const sessions = heads.filter(([, h]) => own.test(h)).map(([n]) => n).join(", ") || "-";
		return `| ${t.key} | ${cell(t.title)} | ${sessions} | ${t.stage ?? "-"} | ${cell(t.waiting || "-")} | \`tickets/${t.key}/NOW.md\` |`;
	});
	const head = `<!-- generated, do not edit: \`status.cjs render <KEY>\` of any ticket on this board rebuilds this file from the ledgers -->\n`;
	const intro = "Shared here: `materials/` and `prompts/S<n>.md` (numbered across the epic; each prompt names its ticket on its first line). Per ticket: `tickets/<KEY>/`.";
	fs.writeFileSync(path.join(root, "EPIC.md"), `${head}# EPIC - ${epic}\n\n${intro}\n\n| Ticket | Title | Sessions | Stage | Waiting on the owner | Board |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`);
};
// The blackboard files a session reads, rebuilt whole from the ledger; nobody edits them.
const renderBoard = (key, s) => {
	const { dir, root } = boardOf(key, s);
	fs.mkdirSync(dir, { recursive: true });
	const head = `<!-- generated, do not edit: \`status.cjs render ${key}\` rebuilds this file from the ledger -->\n`;
	const decisions = decisionsOf(s);
	const issues = s.issues ?? [];
	const open = issues.filter((x) => x.status === "open");
	const events = [
		...(s.history ?? []).map((h) => [h.at, "STAGE", `${h.from ?? "-"} -> ${h.to}`]),
		...decisions.map((d) => [d.at, "DECISION", `D-${d.n} ${d.cancelledAt ? d.was ?? "DECIDED" : d.status} by ${d.by}: ${d.text}`]),
		...decisions.filter((d) => d.cancelledAt).map((d) => [d.cancelledAt, "DECISION", `D-${d.n} CANCELLED: ${d.cancelNote}`]),
		...issues.flatMap((x) => [
			[x.at, "ISSUE-OPEN", `I-${x.n} ${x.type}: ${x.text}`],
			...(x.escalations ?? []).map((e) => [e.at, "ESCALATED", `I-${x.n} to ${e.to}: ${e.why}`]),
			...(x.resolvedAt ? [[x.resolvedAt, "ISSUE-CLOSED", `I-${x.n} by D-${x.resolvedBy}`]] : []),
		]),
		...(s.rounds?.log ?? []).map((r) => [r.at, "ROUND", `${r.used}/${r.max}${r.why ? ` ${r.why}` : ""}`]),
		...(s.handoffs ?? []).map((h) => [h.at, "HANDOFF", `${h.who} ${h.status}: ${h.summary}${h.proven ? "" : " (unproven)"}`]),
		...(s.failures ?? []).map((f) => [f.at, "FAIL", `${f.type} #${f.attempt}${f.what ? ` ${f.what}` : ""}`]),
		...(s.findings ?? []).map((f) => [f.at, "FINDING", `${f.severity}: ${f.text}`]),
		...(s.findings ?? []).flatMap((f, i) => (f.resolved ? [[f.resolved.at, "FINDING-RESOLVED", `#${i + 1}: ${f.resolved.why}`]] : [])),
	].filter((e) => e[0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	fs.writeFileSync(path.join(dir, "status.md"), `${head}# Status log - ${key}\n\nFormat: \`YYYY-MM-DD HH:MM · ${key} · MARKER · what\`\n\n${events.map(([at, m, t]) => `${stamp(at)} · ${key} · ${m} · ${line(t)}`).join("\n")}\n`);
	const dBlock = (d) => [
		`## D-${d.n}`,
		`- **Status:** ${d.status} · **By:** ${d.by} · **At:** ${stamp(d.at)}${d.issue ? ` · **Issue:** I-${d.issue}` : ""}`,
		`- **Decision:** ${line(d.text)}`,
		...(d.effect ? [`- **Effect:** ${line(d.effect)}`] : []),
		...(d.alts ?? []).map((a) => `- **Other option:** ${line(a.label)}${a.effect ? ` (effect: ${line(a.effect)})` : ""}`),
		...(d.replaces ? [`- **Replaces:** D-${d.replaces}`] : []),
		...(d.supersededBy ? [`- **Superseded by:** D-${d.supersededBy} ${stamp(d.supersededAt)}`] : []),
		...(d.cancelledAt ? [`- **Cancelled:** ${stamp(d.cancelledAt)}: ${line(d.cancelNote)}`] : []),
	].join("\n");
	fs.writeFileSync(path.join(dir, "decisions.md"), `${head}# Decisions - ${key}\n\nPrecedence: owner DECIDED > SHOV > contract > Jira AC > USULAN. CANCELLED and SUPERSEDED entries do not apply.\n\n${decisions.map(dBlock).join("\n\n")}\n`);
	const iBlock = (x) => [
		`### I-${x.n} - ${x.type} · level ${x.level}`,
		`- **Raised:** ${stamp(x.at)}`,
		`- **Detail:** ${line(x.text)}`,
		...(x.options?.length ? [`- **Options:** ${x.options.map((o, i) => `${line(o)}${x.effects?.[i] ? ` (effect: ${line(x.effects[i])})` : ""}`).join(" | ")}`] : []),
		...(x.escalations ?? []).map((e) => `- **Escalated:** to ${e.to} ${stamp(e.at)}: ${line(e.why)}`),
	].join("\n");
	const closed = issues.filter((x) => x.status !== "open").map((x) => `- I-${x.n} ${x.type}: ${line(x.text)} (resolved by D-${x.resolvedBy}, ${stamp(x.resolvedAt)})`);
	fs.writeFileSync(path.join(dir, "issues.md"), `${head}# Issues - ${key}\n\n## Open\n\n${open.map(iBlock).join("\n\n") || "none"}\n\n## Resolved\n\n${closed.join("\n") || "none"}\n`);
	const rows = [
		["Stage", s.stage], ["Kind", s.kind ?? "ticket"], ["Engine", s.engine ?? "-"], ["Waiting on the owner", s.waiting || "-"],
		["Review rounds", s.rounds ? `${s.rounds.used ?? 0}/${s.rounds.max ?? 2}` : "-"], ["Draft PR", s.draft ? "yes" : "no"],
		["Production data", s.productionData ? "yes" : "no"], ["PR", [s.pr?.be, s.pr?.fe].filter(Boolean).join(" ") || "-"],
		["Worktrees", [s.dirs?.be, s.dirs?.fe].filter((d) => d && d !== "-").join(" ") || "-"],
		...(root ? [["Epic board", fwd(root)]] : []),
	];
	const now_ = [
		`${head}# NOW - ${key} ${s.title ?? ""} · per ${stamp(s.updatedAt)}`, "",
		"| Field | Value |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), "",
		"## Acceptance criteria", "", "| AC | State | Text |", "|---|---|---|", ...(s.ac ?? []).map((a) => `| ${a.n} | ${a.state} | ${cell(a.text)} |`), "",
		"## Open issues", "", ...(open.length ? open.map((x) => `- I-${x.n} ${x.type} (level ${x.level}): ${line(x.text)}`) : ["none"]), "",
		"## Decisions in force", "", ...(decisions.filter((d) => IN_FORCE.includes(d.status)).map((d) => `- D-${d.n} ${d.status}: ${line(d.text)}`)), "",
		"## Pointers", "", "| Need | Open |", "|---|---|", `| Work prompt and terrain | \`${root ? `${fwd(root)}/` : ""}prompts/S<n>.md\` |`, ...(root ? [`| Sibling tickets, shared materials | \`${fwd(root)}/EPIC.md\`, \`${fwd(root)}/materials/\` |`] : []), "| Every event | `status.md` |", "| Why a rule holds | `decisions.md` |", "| Open questions | `issues.md` |", "",
	];
	fs.writeFileSync(path.join(dir, "NOW.md"), now_.join("\n"));
	if (root) renderEpic(s.board, root);
	return dir;
};
const lockFile = (name) => path.join(LOCKS, `${name}.lock`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readLock = (name) => { try { return JSON.parse(fs.readFileSync(lockFile(name), "utf8")); } catch { return null; } };
// A holder is stale when its pid is gone or it is older than 30 minutes. An unreadable lock younger than 5 s is still being written.
const staleLock = (name, h) => {
	if (!h) { try { return Date.now() - fs.statSync(lockFile(name)).mtimeMs > 5000; } catch { return true; } }
	return Date.now() - Date.parse(h.at) > LOCK_STALE_MS || (h.pid ? !alive(Number(h.pid)) : false);
};
const tryLock = (name, owner, pid) => {
	fs.mkdirSync(LOCKS, { recursive: true });
	let broke = null;
	for (let i = 0; i < 3; i++) {
		try {
			const fd = fs.openSync(lockFile(name), "wx");
			fs.writeSync(fd, JSON.stringify({ owner, pid: pid || null, host: require("os").hostname(), at: now() }));
			fs.closeSync(fd);
			return { got: true, broke };
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			const h = readLock(name);
			if (h?.owner === owner) return { got: true, again: true };
			if (!staleLock(name, h)) return { got: false, holder: h };
			fs.rmSync(lockFile(name), { force: true });
			broke = h;
		}
	}
	return { got: false, holder: readLock(name) };
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const REPOS = PATHS.repos;
const SYNC_STAMP = path.join(require("os").tmpdir(), "qonflo-ledger-sync.stamp");
// QONFLO_GH=<script> runs that node script in place of gh (tests).
const gh = (args, cwd) => require("child_process").execFileSync(process.env.QONFLO_GH ? process.execPath : "gh", [...(process.env.QONFLO_GH ? [process.env.QONFLO_GH] : []), ...args], { cwd, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
const ghJson = (args) => { try { return JSON.parse(gh(args)); } catch { return null; } };
const myPulls = (dir) => {
	try {
		const out = gh(["pr", "list", "--state", "all", "--author", "@me", "--limit", "200", "--json", "number,state,url,headRefName,title"], dir);
		return JSON.parse(out);
	} catch { return null; }
};
// The parent's open PR per repo, for a ticket built on top of it; null with the reason when the parent cannot carry a stack.
const stackOn = (parent) => {
	const p = load(parent);
	if (!p) return { why: `no ledger for ${parent}` };
	const out = { key: parent, retargeted: {} };
	for (const side of ["be", "fe"]) {
		const url = p.pr?.[side];
		if (!url) continue;
		const v = ghJson(["pr", "view", url, "--json", "headRefName,baseRefName,state"]);
		if (!v) return { why: `gh pr view ${url} failed` };
		if (v.state === "OPEN") out[side] = { pr: url, branch: v.headRefName, base: v.baseRefName };
	}
	return out.be || out.fe ? { stack: out } : { why: `${parent} has no open PR to stack on` };
};
// A stacked child whose parent PR merged: point the child PR at the parent's base once. A failure is a finding, never retried.
const retarget = (s) => {
	const st = s.stackedOn;
	if (!st) return;
	for (const side of ["be", "fe"]) {
		const e = st[side];
		const child = s.pr?.[side];
		if (!e || !child || st.retargeted?.[side]) continue;
		if ((s.findings ?? []).some((f) => f.text.startsWith(`retarget ${side} `))) continue;
		if (ghJson(["pr", "view", e.pr, "--json", "state"])?.state !== "MERGED") continue;
		const c = ghJson(["pr", "view", child, "--json", "baseRefName,state"]);
		if (!c || c.state !== "OPEN") continue;
		if (c.baseRefName === e.branch) {
			try { gh(["pr", "edit", child, "--base", e.base]); } catch {
				(s.findings ??= []).push({ at: now(), severity: "blocker", text: `retarget ${side} failed: ${st.key} merged; run gh pr edit ${child} --base ${e.base} by hand` });
				continue;
			}
		}
		(st.retargeted ??= {})[side] = now();
		(s.decisions ??= []).push({ n: s.decisions.length + 1, at: now(), text: `sync: ${st.key} merged; ${side} PR ${child} now targets ${c.baseRefName === e.branch ? e.base : c.baseRefName}`, status: "DECIDED", by: "agent" });
	}
};
// The pull request that speaks for a ticket in one repo: an open one first, else the newest merged one. Closed-unmerged ones are ignored.
const pullFor = (pulls, key) => {
	const own = new RegExp(`(^|[^0-9A-Za-z])${key}([^0-9]|$)`);
	const mine = pulls.filter((p) => own.test(p.title.slice(0, 20)) || own.test(p.headRefName)).sort((a, b) => b.number - a.number);
	return { open: mine.find((p) => p.state === "OPEN") ?? null, merged: mine.find((p) => p.state === "MERGED") ?? null };
};
const sync = (only, quiet) => {
	const pulls = { be: myPulls(REPOS.be), fe: myPulls(REPOS.fe) };
	if (!pulls.be && !pulls.fe) return quiet || console.log("sync: GitHub not reachable, ledger left as it is");
	const keys = only ? [only] : fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((k) => fs.existsSync(file(k))) : [];
	let changed = 0;
	for (const k of keys) {
		const s = load(k);
		if (!s || s.kind === "review" || s.kind === "card" || s.stage === "done" || s.stage === "blocked" || s.handedTo) continue;
		const before = JSON.stringify(s);
		const found = [];
		for (const side of ["be", "fe"]) {
			if (!pulls[side]) continue;
			const p = pullFor(pulls[side], k);
			const main = p.open ?? p.merged;
			if (!main) continue;
			found.push(p);
			(s.pr ??= {})[side] = main.url;
		}
		retarget(s);
		const from = s.stage;
		if (found.length && s.stage === "commit") moveStage(s, "pr");
		if (found.length && s.stage === "pr" && found.every((p) => !p.open && p.merged)) moveStage(s, "done");
		if (s.stage !== from) {
			const was = s.waiting ? `; waiting was: ${s.waiting}` : "";
			// A merged ticket waits for nothing. An opened PR only answers a "buka PR" note, and never while an AC is failing.
			const failing = (s.ac ?? []).some((row) => row.state === "FAIL");
			const clear = s.stage === "done" || (!failing && /PR/i.test(s.waiting || ""));
			(s.decisions ??= []).push({ at: new Date().toISOString(), text: `sync: stage ${from} -> ${s.stage} from GitHub${clear ? was : ""}` });
			if (clear) s.waiting = "";
		}
		if (JSON.stringify(s) === before) continue;
		save(k, s);
		changed++;
		console.log(`${k}: ${from === s.stage ? s.stage : `${from} -> ${s.stage}`}${s.pr?.be ? ` be ${s.pr.be.split("/").pop()}` : ""}${s.pr?.fe ? ` fe ${s.pr.fe.split("/").pop()}` : ""}`);
	}
	if (!changed && !quiet) console.log("sync: no change");
};

// ---------- ledger hand-over between machines (routes: dock-push.cjs ledger) ----------
const dock = () => require("./dock-push.cjs");
const git = (dir, ...args) => {
	try { return { ok: true, out: require("child_process").execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() }; } catch { return { ok: false, out: "" }; }
};
// Why a ticket cannot be handed over yet (the branch must be on the remote), or the branch names to send along.
const handoverCheck = (s) => {
	const branches = {};
	for (const side of ["be", "fe"]) {
		const dir = s.dirs?.[side];
		if (!dir) continue;
		if (git(dir, "status", "--porcelain").out) return { problem: `the ${side} worktree has uncommitted changes; commit and push it first` };
		const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
		if (!branch.ok || !git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").ok) return { problem: `push the branch first: the ${side} branch has no upstream` };
		const ahead = git(dir, "rev-list", "--count", "@{u}..HEAD");
		if (!ahead.ok || Number(ahead.out) > 0) return { problem: `push the branch first: the ${side} branch has ${ahead.out || "unknown"} commits DOCK's remote does not` };
		branches[side] = branch.out;
	}
	return { branches };
};
const dockError = (what, r) => (r.skipped ? "DOCK is not configured" : `DOCK refused ${what}: ${r.status}${r.error ? " " + r.error : ""}`);
// A ticket moved back to To Do in Jira loses its run on DOCK. The ledger made before that is put aside, so the next start is fresh.
const archiveResets = (resets) => {
	for (const reset of resets) {
		const local = load(reset.key);
		if (!local || Date.parse(local.createdAt ?? "") >= Date.parse(reset.resetAt)) continue;
		const to = path.join(ROOT, `${reset.key}.reset-${now().replace(/[-:.]/g, "")}`);
		fs.renameSync(path.dirname(file(reset.key)), to);
		console.log(`${reset.key} went back to To Do in Jira; its old ledger is in ${to}`);
	}
};
// One line per ticket offered to this machine; quiet when DOCK is off or slow.
const offers = async () => {
	try {
		const r = await dock().ledger("list", {}, 3000);
		if (r.status !== 200) return;
		for (const run of r.result?.runs ?? []) if (run.handoverTo && !run.mine) console.log(`${run.key} is offered to this machine: node ${String(PATHS.kitDir).replace(/\\/g, "/")}/status.cjs pull ${run.key}`);
		archiveResets(r.result?.resets ?? []);
	} catch {}
};

const [cmd, rawKey, ...rest] = process.argv.slice(2);
// A free-form card is CARD-<slug>: the prefix upper case, the slug lower case, as DOCK stores it.
const key = /^card-/i.test(rawKey ?? "") ? `CARD-${rawKey.slice(5).toLowerCase()}` : rawKey;
const optValue = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] ?? "" : ""; };

if (!cmd) {
	const keys = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((k) => fs.existsSync(file(k))) : [];
	if (keys.length === 0) return console.log("no tickets");
	console.log("| Ticket | Stage | AC | Waiting on you | Flags | Ports | Updated |");
	console.log("|---|---|---|---|---|---|---|");
	for (const k of keys) {
		const s = load(k);
		const ac = s.ac ?? [];
		const pass = ac.filter((a) => a.state === "PASS").length;
		console.log(`| ${k} | ${s.stage} | ${pass}/${ac.length} | ${s.waiting || "-"} | ${flags(s)} | ${s.ports?.be ?? "-"}/${s.ports?.fe ?? "-"} | ${age(s.updatedAt)} |`);
	}
} else if (cmd === "show") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}`);
	console.log(JSON.stringify(s, null, 2));
} else if (cmd === "init") {
	const [title, be, fe, beDir, feDir] = rest;
	if (key?.startsWith("CARD-") && !CARD_KEY.test(key)) return refuse(`a card key is CARD-<slug>, the slug a-z, 0-9 and -, at most 64 characters; got ${key}`);
	const s = load(key) ?? { key, ac: [], createdAt: now(), ...(key?.startsWith("CARD-") ? { kind: "card" } : {}) };
	Object.assign(s, { title, stage: s.stage ?? "gate", waiting: s.waiting ?? "", ports: { be: Number(be) || null, fe: Number(fe) || null }, dirs: { be: beDir || null, fe: feDir || null } });
	save(key, s);
	console.log(`init ${key}`);
} else if (cmd === "set") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	for (const pair of rest) {
		const i = pair.indexOf("=");
		const k = pair.slice(0, i);
		const v = pair.slice(i + 1);
		if (k === "stage" && !STAGES.includes(v)) return console.log(`stage must be one of ${STAGES.join(", ")}`);
		if (k === "type" && !TYPES.includes(v)) return console.log(`type must be one of ${TYPES.join(", ")}`);
		if (k === "kind" && !KINDS.includes(v)) return refuse(`kind must be one of ${KINDS.join(", ")}`);
		if (k === "kind" && (v === "card") !== CARD_KEY.test(key)) return refuse(v === "card" ? `kind=card needs a CARD-<slug> key, not ${key}` : `${key} is a card; its kind stays card`);
		if (k === "engine" && !["sous", ""].includes(v)) return refuse("engine must be sous, or empty for the orchestrate flow");
		if (BOOLEANS.includes(k) && !["true", "false"].includes(v)) return refuse(`${k} must be true or false`);
		if (k === "rounds.max" && !(Number.isInteger(Number(v)) && Number(v) > 0)) return refuse("rounds.max must be a whole number above 0");
		if (BOOLEANS.includes(k) || k === "rounds.max") {
			setPath(s, k, k === "rounds.max" ? Number(v) : v === "true");
			if (k === "productionData" && v === "true") s.draft = true;
			continue;
		}
		if (k === "stackedOn") {
			if (!v) {
				delete s.stackedOn;
				continue;
			}
			if (v === key) return refuse(`${key} cannot stack on itself`);
			const r = stackOn(v);
			if (r.why) return refuse(`${key} cannot stack on ${v}: ${r.why}`);
			s.stackedOn = r.stack;
			if (/^Blocked: prerequisite/i.test(s.waiting || "")) s.waiting = "";
			const bases = ["be", "fe"].filter((d) => r.stack[d]).map((d) => `${d} ${r.stack[d].branch}`).join(", ");
			(s.decisions ??= []).push({ n: s.decisions.length + 1, at: now(), text: `stacked on ${v}: base ${bases}; ${v}'s PR merges first`, status: "DECIDED", by: "agent" });
			continue;
		}
		if (k === "board") {
			if (v && !EPIC_KEY.test(v)) return refuse(`board must be an epic key like QRD-100, or empty for the ticket's own board; got ${v}`);
			if ((s.board ?? "") === v) continue;
			const from = boardOf(key, s).dir;
			const to = boardOf(key, { board: v }).dir;
			const prompts = path.join(from, "prompts");
			if (fs.existsSync(prompts) && fs.readdirSync(prompts).length) return refuse(`${key} already has prompts in ${fwd(prompts)}; its board stays where it is`);
			if (fs.existsSync(from) && fs.existsSync(to)) console.log(`${fwd(to)} exists; ${fwd(from)} left in place`);
			else if (fs.existsSync(from)) {
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.renameSync(from, to);
				console.log(`moved ${fwd(from)} to ${fwd(to)}`);
			}
			if (v) s.board = v;
			else delete s.board;
			if (s.blackboard) stampBoard(key, s);
			continue;
		}
		if (k === "engine" && !v) {
			delete s.engine;
			continue;
		}
		if (k === "stage" && v === "done" && s.stage !== "done") {
			if (s.source?.stale) return refuse(`${key} is stale (${s.source.stale.reason}); run ac-set again before closing`);
			const reports = latestHandoffs(s);
			if (!reports.length) return refuse(`${key} has no handoff; record one with status.cjs handoff before done`);
			const unproven = reports.filter((h) => !h.proven);
			if (unproven.length) return refuse(`handoff without proof from ${unproven.map((h) => h.who).join(", ")}; verify it and record a new handoff`);
		}
		if (k === "stage") {
			moveStage(s, v);
			continue;
		}
		setPath(s, k, v);
	}
	save(key, s);
	console.log(`${key}: ${rest.join(" ")}`);
} else if (cmd === "ac") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const [n, state, text, evidence] = rest;
	if (!["PASS", "FAIL", "TODO"].includes(state)) return console.log("state must be one of PASS, FAIL, TODO");
	const idx = Number(n) - 1;
	const locked = Boolean(s.source?.acHash);
	if (!Number.isInteger(idx) || idx < 0) return refuse(`AC number must be 1 or more, got ${n}`);
	if (!locked && idx > s.ac.length) return refuse(`${key} has ${s.ac.length} AC rows; row ${n} would leave a gap`);
	if (locked && idx >= s.ac.length) return refuse(`${key} has ${s.ac.length} AC rows from Jira, row ${n} does not exist; run ac-set again if Jira changed`);
	const prev = s.ac[idx];
	const row = { n: Number(n), state, text: locked ? prev.text : (text ?? prev?.text ?? ""), evidence: evidence ?? prev?.evidence ?? "" };
	if (locked && text && text !== prev.text) row.note = text;
	else if (prev?.note) row.note = prev.note;
	if (state === "PASS") {
		if (s.source?.stale) return refuse(`${key} is stale (${s.source.stale.reason}); run ac-set again before marking PASS`);
		const problem = evidenceProblem(s, row.evidence);
		if (problem) return refuse(`AC${n} PASS needs evidence: ${problem}`);
		if (!(s.handoffs ?? []).length) return refuse(`${key} has no handoff; record the member's report with status.cjs handoff before PASS`);
	}
	if (state === "FAIL" && !row.evidence.trim()) return refuse(`AC${n} FAIL needs evidence: what failed (test name and error, or the screenshot path)`);
	s.ac[idx] = row;
	save(key, s);
	console.log(`${key} AC${n}: ${state}`);
} else if (cmd === "remote") {
	dock().ledger("list", {}).then((r) => {
		if (r.status !== 200) return refuse(dockError("the list", r));
		console.log("| Ticket | Stage | Owner | Offered to | Local ledger |");
		console.log("|---|---|---|---|---|");
		for (const run of r.result.runs) console.log(`| ${run.key} | ${run.stage ?? "-"} | ${run.machine}${run.mine ? " (this machine)" : ""} | ${run.handoverTo ?? "-"} | ${load(run.key) ? "yes" : "no"} |`);
	}).catch((e) => refuse(`could not reach DOCK: ${e.message}`));
} else if (cmd === "handover") {
	const local = load(key);
	const to = optValue("--to");
	if (!local) return console.log(`no status for ${key}; nothing to hand over`);
	if (!to) return console.log('usage: status.cjs handover KEY --to <machine> [--note "..."]');
	const checked = handoverCheck(local);
	if (checked.problem) return refuse(checked.problem);
	(async () => {
		await dock().send("", local, 8000);
		const note = optValue("--note");
		const r = await dock().ledger("handover", { key, to, ...(note ? { note } : {}), branches: checked.branches });
		if (r.status !== 200) return refuse(dockError("the hand-over", r));
		local.handedTo = to;
		save(key, local, true);
		console.log(`${key} offered to ${to}. On that machine: node <kit>/status.cjs pull ${key}`);
	})().catch((e) => refuse(`could not reach DOCK: ${e.message}`));
} else if (cmd === "pull") {
	(async () => {
		const got = await dock().ledger("get", { key });
		if (got.status === 404) return refuse(`DOCK does not know ${key}`);
		if (got.status !== 200) return refuse(dockError("the ledger", got));
		const remote = got.result;
		const local = load(key);
		if (local && Date.parse(local.updatedAt) > Date.parse(remote.ledgerUpdatedAt)) {
			const dir = path.dirname(file(key));
			fs.writeFileSync(path.join(dir, "status.remote.json"), JSON.stringify(remote.ledger, null, 2));
			if (!rest.includes("--force")) return refuse(`local ledger is newer than DOCK's copy; DOCK's copy is in ${path.join(dir, "status.remote.json")}. Use pull ${key} --force to keep the local one as status.local-<UTC>.json and replace it`);
			fs.copyFileSync(file(key), path.join(dir, `status.local-${now().replace(/[-:.]/g, "")}.json`));
		}
		const accepted = await dock().ledger("accept", { key });
		if (accepted.status !== 200) return refuse(dockError("the pull", accepted));
		const next = { ...accepted.result.ledger };
		delete next.dirs; delete next.ports; delete next.handedTo;
		const from = remote.handover?.from ?? remote.machine;
		const text = `handed over from ${from}; evidence before this point lives on ${from}`;
		next.decisions = [...(next.decisions ?? [])];
		if (next.decisions.at(-1)?.text !== text) next.decisions.push({ at: now(), text });
		fs.mkdirSync(path.dirname(file(key)), { recursive: true });
		fs.writeFileSync(file(key), JSON.stringify(next, null, 2));
		const b = remote.handover?.branches ?? {};
		console.log(`${key} is now on this machine. Continue: prep-ticket.sh ${key} <slug> ${b.be ? "origin/" + b.be : "-"} ${b.fe ? "origin/" + b.fe : "-"} "${next.title ?? key}"`);
	})().catch((e) => refuse(`could not reach DOCK: ${e.message}`));
} else if (cmd === "sync") {
	const hook = process.argv.includes("--hook");
	if (hook && !SCRATCH) void offers();
	// From a hook: at most once per 10 minutes, and silent unless a ticket moved.
	if (hook) {
		try { if (Date.now() - fs.statSync(SYNC_STAMP).mtimeMs < 10 * 60 * 1000) return; } catch {}
		try { fs.writeFileSync(SYNC_STAMP, ""); } catch {}
	}
	sync(key && !key.startsWith("--") ? key : null, hook);
} else if (cmd === "brief") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const arg = rest.join(" ");
	if (!arg) return console.log(s.brief || "no brief");
	s.brief = arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8").trim() : arg;
	save(key, s);
	console.log(`${key} brief: ${s.brief.length} chars`);
} else if (cmd === "decide") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const { flags: f, words } = takeFlags(rest, ["--status", "--by", "--issue", "--effect", "--alt", "--replaces"]);
	const status = f["--status"]?.[0] ?? "DECIDED";
	const by = f["--by"]?.[0] ?? "owner";
	if (!DECISION_SET.includes(status)) return refuse(`--status must be one of ${DECISION_SET.join(", ")}`);
	if (!DECIDERS.includes(by)) return refuse(`--by must be one of ${DECIDERS.join(", ")}`);
	if (f["--issue"] && !issueOf(s, f["--issue"][0])) return refuse(`${key} has no I-${f["--issue"][0]}`);
	const replaced = f["--replaces"] ? decisionsOf(s).find((d) => d.n === Number(f["--replaces"][0])) : null;
	if (f["--replaces"] && !replaced) return refuse(`${key} has no D-${f["--replaces"][0]}`);
	if (replaced && !IN_FORCE.includes(replaced.status)) return refuse(`D-${replaced.n} is ${replaced.status} and cannot be replaced`);
	const text = words.join(" ").trim();
	if (!text) return console.log("decide needs a text");
	const effect = (f["--effect"]?.[0] ?? "").trim();
	const alts = (f["--alt"] ?? []).map(optionOf).filter((o) => o.label);
	const n = (s.decisions ?? []).length + 1;
	(s.decisions ??= []).push({ n, at: new Date().toISOString(), text, status, by, ...(f["--issue"] ? { issue: Number(f["--issue"][0]) } : {}), ...(effect ? { effect } : {}), ...(alts.length ? { alts } : {}), ...(replaced ? { replaces: replaced.n } : {}) });
	if (replaced) Object.assign(s.decisions[replaced.n - 1], { n: replaced.n, by: replaced.by, status: "SUPERSEDED", supersededBy: n, supersededAt: now() });
	save(key, s);
	console.log(`${key} decision #${n} (D-${n} ${status} by ${by})${replaced ? `; D-${replaced.n} SUPERSEDED` : ""}`);
} else if (cmd === "ac-set") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	if (!rest[0]?.startsWith("@")) return console.log("ac-set needs @<file> with one AC capability per line");
	const lines = acLines(fromArg(rest[0]));
	if (!lines.length) return refuse("the AC file has no lines; an empty AC is a gate finding, not a ledger");
	const old = new Map((s.ac ?? []).map((row) => [row.text, row]));
	s.ac = lines.map((text, i) => ({ n: i + 1, state: old.get(text)?.state ?? "TODO", text, evidence: old.get(text)?.evidence ?? "" }));
	s.source = { acHash: acHash(lines), jiraUpdated: rest[1] ?? null, at: now() };
	save(key, s);
	console.log(`${key}: ${lines.length} AC rows, hash ${s.source.acHash}${rest[1] ? "" : " (no Jira update time given)"}`);
} else if (cmd === "stale") {
	const sprintAt = fs.existsSync(SPRINT) ? fs.statSync(SPRINT).mtime.toISOString() : null;
	if (!key) {
		const keys = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((k) => fs.existsSync(file(k))) : [];
		console.log(`sprint.md: ${sprintAt ? `written ${age(sprintAt)} ago` : "missing"}`);
		console.log("| Ticket | Stage | Stamped | Jira updated | State |");
		console.log("|---|---|---|---|---|");
		for (const k of keys) {
			const s = load(k);
			if (s.stage === "done") continue;
			const src = s.source;
			const state = !src ? "UNSTAMPED" : src.stale ? `STALE: ${src.stale.reason}` : sprintAt && sprintAt > src.at ? "sprint.md is newer than the stamp" : "fresh as of the stamp";
			console.log(`| ${k} | ${s.stage} | ${src ? age(src.at) : "-"} | ${src?.jiraUpdated ?? "-"} | ${state} |`);
		}
		return;
	}
	const s = load(key);
	if (!s) return console.log(`no status for ${key}`);
	if (!s.source) return refuse(`${key} is UNSTAMPED; run ac-set KEY @file <jiraUpdated> from the live Jira AC`);
	const [updated, acFile] = rest;
	if (!updated) return console.log(JSON.stringify(s.source, null, 2));
	const lines = acFile ? acLines(fromArg(acFile)) : null;
	let reason = null;
	if (lines && acHash(lines) !== s.source.acHash) reason = `Jira AC changed: ${s.ac.length} rows in the ledger, ${lines.length} in Jira now`;
	else if (!lines && !sameTime(updated, s.source.jiraUpdated ?? "")) reason = `Jira updated ${updated}, stamp has ${s.source.jiraUpdated ?? "none"}; pass @file to compare the AC`;
	if (reason) {
		s.source.stale = { at: now(), reason };
		save(key, s);
		return refuse(`${key} STALE: ${reason}`);
	}
	delete s.source.stale;
	s.source.jiraUpdated = updated;
	s.source.checkedAt = now();
	save(key, s);
	console.log(`${key} FRESH${sprintAt && sprintAt > s.source.at ? "; sprint.md was rewritten after the stamp, re-read its row for this ticket" : ""}`);
} else if (cmd === "handoff") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const [who, ...pairs] = rest;
	if (!who || !pairs.length) return console.log(`handoff KEY <who> ${HANDOFF.map((k) => `${k}=..`).join(" ")} | @file.json`);
	const h = pairs[0].startsWith("@") ? JSON.parse(fromArg(pairs[0])) : Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
	const unknown = Object.keys(h).filter((k) => !HANDOFF.includes(k));
	if (unknown.length) return refuse(`unknown handoff field ${unknown.join(", ")}; fields are ${HANDOFF.join(", ")}`);
	const missing = ["status", "summary", "unverified"].filter((k) => !String(h[k] ?? "").trim());
	if (missing.length) return refuse(`handoff is missing ${missing.join(", ")}; write unverified=none when everything was checked`);
	const problem = evidenceProblem(s, h.evidence);
	(s.handoffs ??= []).push({ at: now(), who, ...h, proven: !problem, ...(problem ? { problem } : {}) });
	save(key, s);
	console.log(problem ? `${key} handoff from ${who}: UNPROVEN (${problem}). Report it to the owner as "belum diverifikasi", or verify it and record a new handoff.` : `${key} handoff from ${who}: recorded with proof`);
} else if (cmd === "fail") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const [type, evidence, what = ""] = rest;
	if (!FAILS[type]) return console.log(`type must be one of ${Object.keys(FAILS).join(", ")}`);
	if (!evidence?.trim()) return refuse("a failure needs its evidence: the command and the output that showed it");
	const attempt = (s.failures ?? []).filter((x) => x.type === type && x.what === what).length + 1;
	(s.failures ??= []).push({ at: now(), type, what, evidence, attempt });
	save(key, s);
	if (type === "transient" && attempt <= 2) return console.log(`${key} ${type} #${attempt}: RETRY ${attempt}/2`);
	if (type === "transient") return refuse(`${key} transient #${attempt}: retries are spent. It is not transient; classify it again or escalate`);
	if (attempt >= 2) return refuse(`${key} ${type} #${attempt}: the same failure came back. Check the assumptions or escalate, do not try another method`);
	console.log(`${key} ${type} #${attempt}: NO RETRY - ${FAILS[type]}`);
} else if (cmd === "assume") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const [a, b, c] = rest;
	if (/^\d+$/.test(a ?? "") && ["confirmed", "refuted"].includes(b)) {
		const row = (s.assumptions ?? [])[Number(a) - 1];
		if (!row) return refuse(`${key} has no assumption ${a}`);
		if (!c?.trim()) return refuse(`an assumption is ${b} by evidence; give it`);
		Object.assign(row, { state: b, evidence: c, settledAt: now() });
		save(key, s);
		return console.log(`${key} assumption ${a}: ${b}`);
	}
	if (!a?.trim() || !b?.trim()) return refuse("assume needs the assumption and what would prove it wrong");
	(s.assumptions ??= []).push({ n: s.assumptions.length + 1, at: now(), text: a, falsifier: b, state: "open" });
	save(key, s);
	console.log(`${key} assumption ${s.assumptions.length}: open`);
} else if (cmd === "replan") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const reason = rest.join(" ").trim();
	if (!reason) return console.log("replan needs a reason");
	const budget = Number(s.replanBudget ?? 2);
	const used = (s.replans ?? []).length;
	if (used >= budget) {
		s.waiting = `replan budget spent (${used}/${budget}); the owner decides: ${reason}`;
		save(key, s);
		return refuse(`${key} replan budget spent (${used}/${budget}); stop and take it to the owner`);
	}
	(s.replans ??= []).push({ at: now(), reason });
	save(key, s);
	console.log(`${key} replan ${used + 1}/${budget}`);
} else if (cmd === "finding") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	if (/^\d+$/.test(rest[0] ?? "") && rest[1] === "resolve") {
		const n = Number(rest[0]);
		const finding = (s.findings ?? [])[n - 1];
		if (!finding) return refuse(`${key} has no finding #${n}`);
		if (finding.resolved) return refuse(`${key} finding #${n} is already resolved`);
		const why = rest.slice(2).join(" ").trim();
		if (!why) return refuse("resolve needs the reason the finding no longer applies");
		finding.resolved = { at: now(), why };
		save(key, s);
		return console.log(`${key} finding #${n} resolved`);
	}
	const severity = optValue("--severity") || "non-blocking";
	if (!SEVERITIES.includes(severity)) return refuse(`--severity must be one of ${SEVERITIES.join(", ")}`);
	const at = rest.indexOf("--severity");
	const text = (at >= 0 ? [...rest.slice(0, at), ...rest.slice(at + 2)] : rest).join(" ").trim();
	if (!text) return console.log("finding needs a text");
	(s.findings ??= []).push({ at: now(), severity, text });
	save(key, s);
	console.log(`${key} reviewer finding #${s.findings.length} (${severity})`);
} else if (cmd === "lgtm") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const text = rest.join(" ").trim();
	if (!text) return console.log("lgtm needs the part that is fine");
	(s.lgtm ??= []).push({ at: now(), text });
	save(key, s);
	console.log(`${key} lgtm #${s.lgtm.length}`);
} else if (cmd === "verdict") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const { flags: f, words } = takeFlags(rest, ["--ticket", "--pr"]);
	const verdict = words[0];
	if (!VERDICTS.includes(verdict)) return refuse(`verdict must be one of ${VERDICTS.join(", ")}`);
	const blockers = (s.findings ?? []).filter((f) => f.severity === "blocker" && !f.resolved).length;
	if (verdict === "approve" && blockers) return refuse(`${key} has ${blockers} unresolved blocker finding(s); approve needs none (status.cjs finding ${key} <n> resolve "<why>")`);
	const prs = f["--pr"]?.filter(Boolean) ?? [s.pr?.be, s.pr?.fe].filter(Boolean);
	s.verdict = { at: now(), value: verdict, ticket: f["--ticket"]?.[0] || key, prs };
	save(key, s);
	console.log(`${key} verdict: ${verdict}`);
} else if (cmd === "issue") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	if (/^\d+$/.test(rest[0] ?? "")) {
		const x = issueOf(s, rest[0]);
		if (!x) return refuse(`${key} has no I-${rest[0]}`);
		if (x.status !== "open") return refuse(`I-${x.n} is already resolved by D-${x.resolvedBy}`);
		const [, verb, arg, ...more] = rest;
		if (verb === "escalate") {
			if (!["sous", "owner"].includes(arg)) return refuse("escalate to sous or owner");
			const why = more.join(" ").trim();
			if (!why) return refuse("an escalation needs the reason the level below could not resolve it");
			x.level = arg;
			(x.escalations ??= []).push({ at: now(), to: arg, why });
			if (arg === "owner") {
				s.waiting = `I-${x.n}: ${line(x.text)}${x.options?.length ? ` [${x.options.join("|")}]` : ""}`;
				s.draft = true;
			}
			save(key, s);
			return console.log(`${key} I-${x.n}: escalated to ${arg}${arg === "owner" ? "; waiting on the owner" : ""}`);
		}
		if (verb === "resolve") {
			const d = decisionsOf(s).find((y) => y.n === Number(arg));
			if (!d) return refuse(`${key} has no D-${arg}; record the decision first with decide ... --issue ${x.n}`);
			if (!IN_FORCE.includes(d.status)) return refuse(`D-${d.n} is ${d.status.toLowerCase()} and cannot resolve an issue`);
			Object.assign(x, { status: "resolved", resolvedBy: d.n, resolvedAt: now() });
			if ((s.waiting || "").startsWith(`I-${x.n}:`)) s.waiting = "";
			save(key, s);
			return console.log(`${key} I-${x.n}: resolved by D-${d.n}`);
		}
		return refuse("issue KEY <n> escalate sous|owner \"<why>\" | issue KEY <n> resolve <decisionN>");
	}
	const { flags: f, words } = takeFlags(rest, ["--options"]);
	const [type, ...textWords] = words;
	if (!ISSUE_TYPES.includes(type)) return refuse(`issue type must be one of ${ISSUE_TYPES.join(", ")}`);
	const text = textWords.join(" ").trim();
	if (!text) return refuse("an issue needs a text");
	const n = (s.issues ?? []).length + 1;
	const parsed = f["--options"] ? f["--options"][0].split("|").map(optionOf).filter((o) => o.label) : [];
	const options = parsed.map((o) => o.label);
	const effects = parsed.some((o) => o.effect) ? parsed.map((o) => o.effect) : [];
	(s.issues ??= []).push({ n, at: now(), type, text, level: "arbiter", status: "open", ...(options.length ? { options } : {}), ...(effects.length ? { effects } : {}) });
	save(key, s);
	console.log(`${key} I-${n}: ${type} open at level arbiter`);
} else if (cmd === "round") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	const why = rest.join(" ").trim();
	const r = (s.rounds ??= { used: 0, max: 2 });
	r.used = Number(r.used ?? 0);
	r.max = Number(r.max ?? 2);
	if (r.used >= r.max) {
		const spent = (s.issues ?? []).find((x) => x.status === "open" && x.text.startsWith("review rounds spent"));
		if (spent) return refuse(`${key} review rounds spent (${r.used}/${r.max}); I-${spent.n} is already with the owner`);
		const n = (s.issues ?? []).length + 1;
		const text = `review rounds spent (${r.used}/${r.max})${why ? `: ${why}` : ""}`;
		(s.issues ??= []).push({ n, at: now(), type: "BLOCKER", text, level: "owner", status: "open", escalations: [{ at: now(), to: "owner", why: "round budget spent" }] });
		s.waiting = `I-${n}: ${text}`;
		s.draft = true;
		save(key, s);
		return refuse(`${key} review rounds spent (${r.used}/${r.max}); I-${n} is with the owner and the PR opens as draft`);
	}
	r.used++;
	(r.log ??= []).push({ at: now(), used: r.used, max: r.max, ...(why ? { why } : {}) });
	save(key, s);
	console.log(`${key} round ${r.used}/${r.max}`);
} else if (cmd === "lock" || cmd === "unlock") {
	const name = key;
	const ownerRaw = rest[0];
	const owner = /^card-/i.test(ownerRaw ?? "") ? `CARD-${ownerRaw.slice(5).toLowerCase()}` : ownerRaw;
	if (!/^[a-z-]+$/.test(name ?? "") || !owner || owner.startsWith("--")) return console.log(`usage: status.cjs ${cmd} <name> KEY${cmd === "lock" ? " [--wait <seconds>] [--pid <n>]" : ""}`);
	if (cmd === "unlock") {
		const h = readLock(name);
		if (!h) return console.log(`${name} is not held`);
		if (h.owner !== owner) return refuse(`${name} is held by ${h.owner}, not ${owner}`);
		fs.rmSync(lockFile(name), { force: true });
		return console.log(`released ${name} for ${owner}`);
	}
	const wait = Number(optValue("--wait") || 0);
	const pid = Number(optValue("--pid")) || null;
	const deadline = Date.now() + wait * 1000;
	let got = tryLock(name, owner, pid);
	while (!got.got && Date.now() < deadline) {
		sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
		got = tryLock(name, owner, pid);
	}
	if (!got.got) return refuse(`${name} is held by ${got.holder?.owner ?? "?"} since ${stamp(got.holder?.at)}; run lock again (or --wait <seconds>)`);
	if (got.broke) console.log(`broke stale ${name} lock held by ${got.broke.owner ?? "?"}`);
	console.log(got.again ? `${name} already held by ${owner}` : `acquired ${name} for ${owner}`);
} else if (cmd === "render") {
	const s = load(key);
	if (!s) return console.log(`no status for ${key}; run init first`);
	stampBoard(key, s);
	save(key, s);
	renderBoard(key, s);
	console.log(`${key}: rendered ${s.blackboard}`);
} else if (cmd === "metrics") {
	const keys = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((k) => fs.existsSync(file(k))) : [];
	const rows = keys.map(load).filter((s) => s.stage === "done").map((s) => ({ s, c: s.closing ?? closing(s, s.updatedAt) }));
	if (!rows.length) return console.log("no closed tickets");
	const dash = (v) => (v === null || v === undefined ? "-" : v);
	console.log("| Ticket | Type | Kind | Fix rounds | Failures | Replans | Hours | Reviewer findings |");
	console.log("|---|---|---|---|---|---|---|---|");
	for (const { s, c } of rows) {
		const failures = Object.entries(c.failures).map(([k, v]) => `${k} ${v}`).join(", ") || "0";
		console.log(`| ${s.key} | ${s.type ?? "-"} | ${s.kind ?? "build"} | ${s.history ? c.fixRounds : "-"} | ${failures} | ${c.replans} | ${dash(c.hours)} | ${(s.findings ?? []).length} |`);
	}
	const groups = {};
	for (const row of rows) (groups[`${row.s.type ?? "untyped"} / ${row.s.kind ?? "build"}`] ??= []).push(row);
	const mean = (list, pick) => (list.length ? Math.round((list.reduce((sum, row) => sum + pick(row), 0) / list.length) * 10) / 10 : "-");
	console.log("\n| Work type | Tickets | Mean fix rounds | Mean reviewer findings | Mean hours |");
	console.log("|---|---|---|---|---|");
	for (const [name, list] of Object.entries(groups)) {
		const tracked = list.filter((row) => row.s.history);
		const timed = list.filter((row) => row.c.hours !== null);
		console.log(`| ${name} | ${list.length} | ${mean(tracked, (row) => row.c.fixRounds)} | ${mean(list, (row) => (row.s.findings ?? []).length)} | ${mean(timed, (row) => row.c.hours)} |`);
	}
} else {
	console.log("usage: status.cjs [show KEY | init KEY title bePort fePort beDir feDir | set KEY k=v... | ac KEY n STATE text evidence | ac-set KEY @file [jiraUpdated] | stale [KEY jiraUpdated [@file]] | handoff KEY who k=v...|@file.json | fail KEY type evidence [what] | assume KEY text falsifier | assume KEY n confirmed|refuted evidence | replan KEY reason | finding KEY [--severity blocker|non-blocking|nit] text | finding KEY n resolve why | lgtm KEY text | verdict KEY approve|request-change [--ticket KEY] [--pr url]... | metrics | brief KEY text|@file | decide KEY text [--status SHOV|USULAN|DECIDED] [--by owner|arbiter|sous|agent] [--issue n] [--effect text] [--alt \"option::effect\"]... [--replaces n] | issue KEY TYPE text [--options \"A::effect|B::effect\"] | issue KEY n escalate sous|owner why | issue KEY n resolve decisionN | round KEY [why] | lock name KEY [--wait s] [--pid n] | unlock name KEY | render KEY | sync [KEY] | remote | handover KEY --to machine [--note text] | pull KEY [--force]]");
}
