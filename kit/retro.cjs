// Sprint retro for sous: the numbers behind a Keep / Problem / Try draft, and the draft posted to DOCK.
//   node retro.cjs data "<sprint>" [--keys QRD-1,QRD-2] [--since <ISO> --until <ISO>]
//        -> JSON on stdout: every ledger of the sprint with its closing hours, rounds, failures, findings, owner issues and decisions.
//           Which ledgers: --keys (from Jira: sprint = "<sprint>"), else the keys sprint.md names when its title names this sprint,
//           else the ledgers with activity between --since and --until.
//   node retro.cjs post @<draft.json> [--dry-run]
//        -> POST <DOCK ingest url>/retro with { sprint, items: [{ kind, text, evidence, dest }] }. A line whose evidence names no
//           ticket key is dropped and listed; a bad kind or dest is refused. --dry-run prints the body and sends nothing.
// Refusals print REFUSED and exit 2. QONFLO_EVIDENCE=<dir> points at a scratch copy of the ledgers.
const fs = require("fs");
const path = require("path");

const ROOT = process.env.QONFLO_EVIDENCE || require("./paths.cjs").resolvePaths().evidence;
const KINDS = ["keep", "problem", "try"];
const DESTS = ["kit", "memory", "dock", "note"];
const KEY = /\b(?:[A-Z][A-Z0-9]*-\d+|CARD-[a-z0-9-]+)\b/;

const refuse = (msg) => {
	console.log(`REFUSED: ${msg}`);
	process.exitCode = 2;
};
const ledgerFile = (key) => path.join(ROOT, key, "status.json");
const load = (key) => {
	try { return JSON.parse(fs.readFileSync(ledgerFile(key), "utf8")); } catch { return null; }
};
const allKeys = () => (fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((k) => fs.existsSync(ledgerFile(k))) : []);
const hoursBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 360000) / 10 : null);
const flagOf = (args, name) => {
	const i = args.indexOf(name);
	return i < 0 ? null : args[i + 1] ?? "";
};

// The keys of the sprint and where they came from.
function sprintKeys(sprint, args) {
	const keys = flagOf(args, "--keys");
	if (keys) return { source: "jira", keys: [...new Set(keys.split(",").map((k) => k.trim()).filter(Boolean))] };
	const board = path.join(ROOT, "sprint.md");
	if (fs.existsSync(board)) {
		const text = fs.readFileSync(board, "utf8");
		const title = text.split(/\r?\n/)[0] ?? "";
		if (title.toLowerCase().includes(sprint.toLowerCase())) {
			const named = new Set(text.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? []);
			return { source: "sprint.md", keys: allKeys().filter((k) => named.has(k)) };
		}
	}
	const since = flagOf(args, "--since"), until = flagOf(args, "--until");
	if (since && until) {
		const active = (s) => [s.createdAt, s.updatedAt, ...(s.history ?? []).map((h) => h.at)].some((at) => at && at >= since && at <= until);
		return { source: "dates", keys: allKeys().filter((k) => active(load(k) ?? {})) };
	}
	return null;
}

// One ledger as the retro reads it.
function ticketOf(s) {
	const history = s.history ?? [];
	const start = s.createdAt ?? history[0]?.at ?? null;
	const end = s.closing?.at ?? (s.stage === "done" ? s.updatedAt : null);
	const ownerIssues = (s.issues ?? []).filter((x) => x.level === "owner" || (x.escalations ?? []).some((e) => e.to === "owner")).map((x) => {
		const at = (x.escalations ?? []).find((e) => e.to === "owner")?.at ?? x.at;
		return { n: x.n, type: x.type, text: x.text, escalatedAt: at, resolvedAt: x.resolvedAt ?? null, waitHours: x.resolvedAt ? hoursBetween(at, x.resolvedAt) : null };
	});
	return {
		key: s.key,
		title: s.title ?? "",
		kind: s.kind ?? "ticket",
		stage: s.stage ?? null,
		hours: s.closing?.hours ?? hoursBetween(start, end),
		fixRounds: s.closing?.fixRounds ?? history.filter((h) => h.to === "code" && ["test", "verify", "evidence", "commit", "pr"].includes(h.from)).length,
		rounds: s.rounds ? { used: s.rounds.used ?? 0, max: s.rounds.max ?? 2, why: (s.rounds.log ?? []).map((r) => r.why).filter(Boolean) } : null,
		replans: (s.replans ?? []).map((r) => r.reason),
		failures: (s.failures ?? []).map((f) => ({ type: f.type, what: f.what ?? "", at: f.at })),
		findings: (s.findings ?? []).map((f) => ({ severity: f.severity, text: f.text, resolved: Boolean(f.resolved) })),
		ownerIssues,
		decisions: (s.decisions ?? []).map((d, i) => ({ n: d.n ?? i + 1, status: d.status ?? "DECIDED", by: d.by ?? "owner", text: d.text, ...(d.question ? { question: d.question } : {}), ...(d.rejected?.length ? { rejected: d.rejected } : {}) })),
		verdict: s.verdict?.value ?? null,
		pr: s.pr ?? null,
	};
}

// The draft as DOCK takes it, plus the lines dropped for lacking evidence. Throws on a malformed draft.
function draftBody(draft) {
	if (!draft || typeof draft.sprint !== "string" || !draft.sprint.trim()) throw new Error("the draft needs a sprint name");
	if (!Array.isArray(draft.items)) throw new Error("the draft needs an items array");
	const items = [], dropped = [];
	draft.items.forEach((it, i) => {
		if (!KINDS.includes(it?.kind)) throw new Error(`item ${i + 1}: kind must be one of ${KINDS.join(", ")}`);
		const dest = it.dest ?? (it.kind === "try" ? undefined : "note");
		if (!DESTS.includes(dest)) throw new Error(`item ${i + 1}: dest must be one of ${DESTS.join(", ")}`);
		if (it.kind !== "try" && dest !== "note") throw new Error(`item ${i + 1}: a ${it.kind} line goes to note`);
		const text = String(it.text ?? "").trim();
		if (!text) throw new Error(`item ${i + 1}: text is empty`);
		const evidence = (Array.isArray(it.evidence) ? it.evidence : []).map((e) => String(e).trim()).filter(Boolean);
		if (!evidence.some((e) => KEY.test(e))) return dropped.push(text);
		items.push({ kind: it.kind, text, evidence, dest });
	});
	return { body: { sprint: draft.sprint.trim(), items }, dropped };
}

module.exports = { ticketOf, draftBody, sprintKeys };

if (require.main === module) {
	const [cmd, arg, ...rest] = process.argv.slice(2);
	if (cmd === "data") {
		if (!arg) return refuse('data needs the sprint name, e.g. data "QRD Sprint 26"');
		const found = sprintKeys(arg, rest);
		if (!found) return refuse(`no way to tell which ledgers are in ${arg}: pass --keys from Jira (sprint = "${arg}"), or --since and --until`);
		const tickets = found.keys.map(load).filter(Boolean).map(ticketOf);
		const missing = found.keys.filter((k) => !load(k));
		console.log(JSON.stringify({ sprint: arg, source: found.source, tickets, noLedger: missing }, null, 2));
	} else if (cmd === "post") {
		if (!arg?.startsWith("@")) return refuse("post needs @<draft.json>");
		let out;
		try { out = draftBody(JSON.parse(fs.readFileSync(arg.slice(1), "utf8"))); } catch (e) { return refuse(e.message); }
		for (const t of out.dropped) console.log(`dropped, no ticket evidence: ${t}`);
		if (!out.body.items.length) return refuse("no line with evidence is left; nothing is posted");
		if (rest.includes("--dry-run")) return console.log(JSON.stringify(out.body, null, 2));
		require("./dock-push.cjs").send("/retro", out.body, 15000).then((r) => {
			if (r.skipped) return refuse("DOCK not configured: set DOCK_INGEST_URL and DOCK_INGEST_TOKEN, or kit/dock.json");
			if (r.status >= 300 || r.ok === false) return refuse(`DOCK answered ${r.status}${r.error ? ` ${r.error}` : ""}`);
			console.log(`posted ${out.body.items.length} lines for ${out.body.sprint}: ${r.status}${r.id ? ` id ${r.id}` : ""}`);
		}).catch((e) => refuse(`could not reach DOCK: ${e.message}`));
	} else {
		console.log('usage: retro.cjs data "<sprint>" [--keys K1,K2] [--since ISO --until ISO] | post @<draft.json> [--dry-run]');
	}
}
