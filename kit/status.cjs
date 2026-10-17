// Ticket status ledger: one JSON per ticket under E:/qonflo/.evidence/<KEY>/status.json.
//   node status.cjs                      -> table of every ticket
//   node status.cjs show KEY             -> one ticket with its AC lines
//   node status.cjs init KEY "title" bePort fePort beDir feDir
//   node status.cjs set KEY stage=<stage> [waiting="..."] [pr.be=..] [note="..."]
//   node status.cjs ac KEY <n> <PASS|FAIL|TODO> "<text>" ["<evidence>"]
//   node status.cjs brief KEY "<text>" | @<file>   -> the working brief a fresh session starts from
//   node status.cjs decide KEY "<decision and why>" -> appended to decisions[], never overwritten
//   node status.cjs sync [KEY] [--hook]            -> pull PR state from GitHub: fills pr.be / pr.fe, moves commit -> pr when a PR
//                                                     exists and pr -> done when every PR is merged. Two gh calls whatever the ticket count.
//   node status.cjs ac-set KEY @<file> [jiraUpdated] -> AC rows from Jira, one capability per line; stamps the source and locks the row count
//   node status.cjs stale [KEY jiraUpdated [@<file>]] -> compare the stamp with Jira; a stale ledger refuses PASS and done until ac-set runs again
//   node status.cjs handoff KEY <who> status=.. summary=.. evidence=.. where=.. assumptions=.. open=.. unverified=..  | @<file.json>
//   node status.cjs fail KEY <transient|defect|spec|env|permission> "<evidence>" ["<what failed>"] -> typed failure with an attempt count
//   node status.cjs assume KEY "<assumption>" "<what would prove it wrong>"  |  assume KEY <n> <confirmed|refuted> "<evidence>"
//   node status.cjs replan KEY "<reason>"            -> counted against replanBudget (default 2, set KEY replanBudget=<n> at the gate)
//   node status.cjs finding KEY "<text>"             -> a reviewer finding raised after the PR was opened
//   node status.cjs metrics                          -> closing numbers per ticket and per work type
//   node status.cjs remote                           -> the tickets DOCK knows: owner machine, offered to, local ledger or not
//   node status.cjs handover KEY --to <machine> [--note "..."] -> offer a pushed ticket to another machine; save then refuses here
//   node status.cjs pull KEY [--force]               -> accept a ticket offered to this machine and write its ledger here
// Refusals print REFUSED and exit 2. PASS needs evidence that exists and a recorded handoff; done needs a handoff with proof.
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
const file = (key) => path.join(ROOT, key, "status.json");
const load = (key) => (fs.existsSync(file(key)) ? JSON.parse(fs.readFileSync(file(key), "utf8")) : null);
const save = (key, s, allowHanded = false) => {
	const prev = allowHanded ? null : load(key);
	if (prev?.handedTo) return refuse(`${key} was handed over to ${prev.handedTo}; it is changed there. \`status.cjs pull ${key}\` takes it back`);
	fs.mkdirSync(path.dirname(file(key)), { recursive: true });
	s.updatedAt = new Date().toISOString();
	fs.writeFileSync(file(key), JSON.stringify(s, null, 2));
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
		const absolute = /^[A-Za-z]:[\\/]/.test(p);
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

const REPOS = PATHS.repos;
const SYNC_STAMP = path.join(require("os").tmpdir(), "qonflo-ledger-sync.stamp");
const myPulls = (dir) => {
	try {
		const out = require("child_process").execFileSync("gh", ["pr", "list", "--state", "all", "--author", "@me", "--limit", "200", "--json", "number,state,url,headRefName,title"], { cwd: dir, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		return JSON.parse(out);
	} catch { return null; }
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
		if (!s || s.kind === "review" || s.stage === "done" || s.stage === "blocked" || s.handedTo) continue;
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

const [cmd, key, ...rest] = process.argv.slice(2);
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
	const s = load(key) ?? { key, ac: [], createdAt: now() };
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
	const text = rest.join(" ").trim();
	if (!text) return console.log("decide needs a text");
	(s.decisions ??= []).push({ at: new Date().toISOString(), text });
	save(key, s);
	console.log(`${key} decision #${s.decisions.length}`);
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
	const text = rest.join(" ").trim();
	if (!text) return console.log("finding needs a text");
	(s.findings ??= []).push({ at: now(), text });
	save(key, s);
	console.log(`${key} reviewer finding #${s.findings.length}`);
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
	console.log("usage: status.cjs [show KEY | init KEY title bePort fePort beDir feDir | set KEY k=v... | ac KEY n STATE text evidence | ac-set KEY @file [jiraUpdated] | stale [KEY jiraUpdated [@file]] | handoff KEY who k=v...|@file.json | fail KEY type evidence [what] | assume KEY text falsifier | assume KEY n confirmed|refuted evidence | replan KEY reason | finding KEY text | metrics | brief KEY text|@file | decide KEY text | sync [KEY] | remote | handover KEY --to machine [--note text] | pull KEY [--force]]");
}
