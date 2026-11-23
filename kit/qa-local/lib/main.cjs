"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const stack = require("./stack.cjs");
const { judge, acStatus } = require("./judge.cjs");
const report = require("./report.cjs");
const progress = require("./progress.cjs");

const { resolveLocalPaths } = require("./paths.cjs");

const HOME = os.homedir();
const LOCAL_PATHS = resolveLocalPaths();
const QA_CODE = LOCAL_PATHS.code;
const QA_LOCAL = LOCAL_PATHS.data;
const KIT = LOCAL_PATHS.kit;
const KIT_PATHS = loadKitPaths();
const PROJECTS = KIT_PATHS.root;
const PW_CANDIDATES = LOCAL_PATHS.pwCandidates;
const PW_CLI = process.env.QA_LOCAL_PW_CLI || PW_CANDIDATES.find((f) => fs.existsSync(f)) || PW_CANDIDATES[0];
const QA_NODE_MODULES = path.resolve(PW_CLI, "..", "..", "..");
const MAIN_BE = path.join(PROJECTS, "ms-admin-worker-backend");
const MAIN_FE = path.join(PROJECTS, "ms-client-dashboard-frontend");
const BOOT_TIMEOUT_MS = Number(process.env.QA_LOCAL_BOOT_TIMEOUT_MS || 300000);
const LOGIN_TIMEOUT_MS = Number(process.env.QA_LOCAL_LOGIN_TIMEOUT_MS || 300000);
const PW_TIMEOUT_MS = Number(process.env.QA_LOCAL_PW_TIMEOUT_MS || 1800000);
const REASON_CODES = ["BE_ONLY", "MCP_LUAR", "DEPENDENSI", "DATA_PRASYARAT", "PIHAK_KETIGA", "AKUN_KEDUA", "FE_LINKED", "PARSIAL", "LAINNYA"];
const EXIT = { LOLOS: 0, REVISION: 1, INPUT: 2, ESCALATED: 3, INFRA: 4, BUSY: 5 };

const USAGE = `usage: qonflo-qa-local <KEY> [--be <worktree> --fe <worktree>] [--keep-stack]
       qonflo-qa-local <KEY> --no-stack --be-url <http://localhost:PORT> --fe-url <http://localhost:PORT>
       qonflo-qa-local <KEY> --triage-stop <CODE> "<reason>" [--fe <FE-KEY> [--fe-status "<status>"]]
       qonflo-qa-local --stop <run folder>
       qonflo-qa-local --help

Runs the Playwright specs in ${QA_LOCAL}/tests/<KEY>/ against a local stack and writes
${QA_LOCAL}/runs/<KEY>/<UTC timestamp>/ with videos/<TC-id>.webm, results.json, summary.md
and a verdict prediction (LOLOS, REVISION, ESCALATED or FOLLOWS_FE).

Inputs (written by an agent step first, see ${QA_CODE}/README.md):
  tests/<KEY>/ac.json     key, summary, fetchedAt, ac[] from Jira customfield_10332, tcs[]
  tests/<KEY>/TC.md       test cases in the QA agent's TC format
  tests/<KEY>/*.spec.ts   one Playwright test per TC, title starting with the TC id

Options:
  --be <dir>        backend worktree (absolute, relative, or a folder name under ${PROJECTS})
  --fe <dir>        frontend worktree
                    default: ${PROJECTS}/wt-<number>*-be|fe when exactly one matches,
                    else the main clones as they are (no branch switch)
  --keep-stack      leave the started backend and frontend running; stop later with --stop
  --no-stack        start nothing; use --be-url and --fe-url (localhost only)
  --stop <dir>      stop the processes recorded in <run folder>/stack.json
  --triage-stop <CODE> "<reason>"
                    record a run that stopped at triage or review: verdict ESCALATED with a v2 reason code
                    (${REASON_CODES.join(", ")}); starts no stack and no Playwright
                    with FE_LINKED, --fe <FE-KEY> names the paired FE ticket the BE ticket follows: verdict
                    FOLLOWS_FE and followsFe {key, status}; --fe-status is that ticket's Jira status

Users: local@test.com (QONFLO_PASS_FILE or ~/.qonflo-pass) and local2@test.com
(QONFLO_PASS_FILE_2, else the same file). Logins go through ${KIT}/login-state.cjs.

Exit codes: 0 LOLOS, 1 REVISION, 2 missing input or refused, 3 ESCALATED,
4 ESCALATED because the stack, login or Playwright failed, 5 another run is active.
`;

class UsageError extends Error {}

function loadKitPaths() {
	try {
		return require(path.join(KIT, "paths.cjs")).resolvePaths();
	} catch {
		return { root: path.join(HOME, "projects"), protectedPorts: [], ticketPortBase: { be: 3200, fe: 5300 } };
	}
}

function log(msg) {
	process.stdout.write(`[qa-local] ${msg}\n`);
}

function fail(code, msg) {
	process.stderr.write(`qonflo-qa-local: ${msg}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const o = { key: null, be: null, fe: null, feStatus: null, keepStack: false, noStack: false, beUrl: null, feUrl: null, help: false, stop: null, triageStop: null };
	const value = (i, name) => {
		if (i >= argv.length || argv[i].startsWith("--")) throw new UsageError(`${name} needs a value`);
		return argv[i];
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") o.help = true;
		else if (a === "--be") o.be = value(++i, a);
		else if (a === "--fe") o.fe = value(++i, a);
		else if (a === "--be-url") o.beUrl = value(++i, a);
		else if (a === "--fe-url") o.feUrl = value(++i, a);
		else if (a === "--fe-status") o.feStatus = value(++i, a);
		else if (a === "--stop") o.stop = value(++i, a);
		else if (a === "--triage-stop") {
			o.triageStop = { code: value(++i, a), reason: value(++i, "--triage-stop <CODE> needs a reason;") };
		} else if (a === "--keep-stack") o.keepStack = true;
		else if (a === "--no-stack") o.noStack = true;
		else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
		else if (!o.key) o.key = a;
		else throw new UsageError(`unexpected argument ${a}`);
	}
	return o;
}

function listSpecs(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listSpecs(p));
		else if (/\.spec\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
	}
	return out;
}

function howToCreate(key, dir) {
	return [
		`inputs for ${key} are not ready in ${dir}.`,
		`An agent step creates them before this command runs (it reads Jira; this command never does):`,
		`  1. ${dir}/ac.json  {"key":"${key}","summary":"...","fetchedAt":"<ISO>","source":"jira customfield_10332",`,
		`                     "ac":[{"n":1,"text":"..."}],"tcs":[{"id":"TC-01","title":"...","ac":[1],"user":"local"}]}`,
		`  2. ${dir}/TC.md    test cases in the QA agent's TC format`,
		`  3. ${dir}/*.spec.ts  one Playwright test per TC, title starting with its TC id ("TC-01 ...")`,
		`The prompt for that step is in ${QA_CODE}/README.md ("Agent step").`,
	].join("\n");
}

function loadInputs(key) {
	const dir = path.join(QA_LOCAL, "tests", key);
	const acFile = path.join(dir, "ac.json");
	const problems = [];
	let ac = null;
	if (!fs.existsSync(acFile)) problems.push(`missing ${acFile}`);
	else {
		try {
			ac = JSON.parse(fs.readFileSync(acFile, "utf8"));
		} catch (e) {
			problems.push(`${acFile} is not valid JSON: ${e.message}`);
		}
	}
	if (ac) {
		if (String(ac.key || "").toUpperCase() !== key) problems.push(`ac.json key is "${ac.key}", expected "${key}"`);
		if (!Array.isArray(ac.ac) || !ac.ac.length || !ac.ac.every((a) => Number.isInteger(a.n) && typeof a.text === "string")) problems.push(`ac.json needs ac: [{ "n": 1, "text": "..." }, ...]`);
		if (!Array.isArray(ac.tcs) || !ac.tcs.length || !ac.tcs.every((t) => report.TC_RE.test(String(t.id)) && Array.isArray(t.ac))) problems.push(`ac.json needs tcs: [{ "id": "TC-01", "title": "...", "ac": [1] }, ...]`);
		else if (Array.isArray(ac.ac)) {
			const known = new Set(ac.ac.map((a) => a.n));
			for (const t of ac.tcs) for (const n of t.ac) if (!known.has(n)) problems.push(`ac.json ${t.id} points at AC ${n}, which is not in ac[]`);
		}
	}
	const specs = fs.existsSync(dir) ? listSpecs(dir) : [];
	if (!specs.length) problems.push(`no *.spec.ts in ${dir}`);
	if (problems.length) fail(EXIT.INPUT, `${problems.join("\n")}\n\n${howToCreate(key, dir)}`);
	const tcFile = ["TC.md", "tc.md"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p)) || null;
	return { dir, ac, specs, tcFile };
}

function resolveDir(flag, key, suffix, main) {
	if (flag) {
		const raw = flag.replace(/^~(?=$|\/)/, HOME);
		const dir = path.isAbsolute(raw) ? raw : fs.existsSync(path.resolve(raw)) ? path.resolve(raw) : path.join(PROJECTS, raw);
		return { dir, how: "flag" };
	}
	const num = key.split("-").pop();
	const re = new RegExp(`^wt-${num}(?!\\d).*-${suffix}$`);
	const hits = fs.readdirSync(PROJECTS).filter((n) => re.test(n) && fs.statSync(path.join(PROJECTS, n)).isDirectory());
	if (hits.length === 1) return { dir: path.join(PROJECTS, hits[0]), how: `worktree wt-${num}*-${suffix}` };
	return { dir: main, how: hits.length ? `main clone; ${hits.length} worktrees matched (${hits.join(", ")}), pass --${suffix} to pick one` : "main clone; no worktree matched" };
}

function preflightStack(key, opts) {
	const be = resolveDir(opts.be, key, "be", MAIN_BE);
	const fe = resolveDir(opts.fe, key, "fe", MAIN_FE);
	const problems = [];
	for (const [part, d, entry] of [["backend", be, "src/core/app.ts"], ["frontend", fe, "package.json"]]) {
		if (!fs.existsSync(d.dir)) problems.push(`${part} dir ${d.dir} does not exist`);
		else {
			if (!fs.existsSync(path.join(d.dir, entry))) problems.push(`${part} dir ${d.dir} has no ${entry}`);
			if (!fs.existsSync(path.join(d.dir, "node_modules"))) problems.push(`${part} dir ${d.dir} has no node_modules; install its dependencies first`);
		}
	}
	if (fs.existsSync(be.dir)) problems.push(...stack.checkBackendEnv(be.dir).map((p) => `${p}; refusing to start a backend that could write outside this machine`));
	if (problems.length) fail(EXIT.INPUT, problems.join("\n"));
	for (const d of [be, fe]) if (d.how.startsWith("main clone")) log(`warning: ${d.dir} used as it is (${d.how})`);
	return { be, fe };
}

function preflightExternal(opts, guard) {
	if (!opts.beUrl || !opts.feUrl) fail(EXIT.INPUT, "--no-stack needs --be-url and --fe-url");
	for (const u of [opts.beUrl, opts.feUrl]) if (!stack.isLocalUrl(u)) fail(EXIT.INPUT, `${u} is not a localhost URL; this tool only tests the local stack`);
	const fePort = new URL(opts.feUrl).port;
	if (!fePort || guard.has(fePort)) fail(EXIT.INPUT, `frontend port ${fePort || "(none)"} is protected or missing; login-state.cjs logs in only on a ticket port such as 5300+`);
	return { beUrl: opts.beUrl.replace(/\/$/, ""), feUrl: opts.feUrl.replace(/\/$/, ""), fePort: Number(fePort) };
}

function passFiles() {
	const first = process.env.QONFLO_PASS_FILE || path.join(HOME, ".qonflo-pass");
	const second = process.env.QONFLO_PASS_FILE_2 || first;
	for (const f of new Set([first, second])) if (!fs.existsSync(f)) fail(EXIT.INPUT, `no password file ${f}; set QONFLO_PASS_FILE (and QONFLO_PASS_FILE_2 for local2) or create ~/.qonflo-pass`);
	return [
		{ id: "local", email: "local@test.com", passFile: first },
		{ id: "local2", email: "local2@test.com", passFile: second },
	];
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
}

function acquireLock(key) {
	const file = path.join(QA_LOCAL, ".run.lock");
	if (fs.existsSync(file)) {
		let cur = null;
		try {
			cur = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		if (cur && cur.pid && alive(cur.pid)) fail(EXIT.BUSY, `another run is active: ${cur.key} (pid ${cur.pid}); one run at a time`);
		fs.unlinkSync(file);
	}
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, key, at: new Date().toISOString() }) + "\n", { flag: "wx" });
	return file;
}

function releaseLock(file) {
	try {
		const cur = JSON.parse(fs.readFileSync(file, "utf8"));
		if (cur.pid === process.pid) fs.unlinkSync(file);
	} catch {}
}

function triageStop(key, opts) {
	const { code, reason } = opts.triageStop;
	if (!REASON_CODES.includes(code)) fail(EXIT.INPUT, `--triage-stop code must be one of ${REASON_CODES.join(", ")}`);
	if (!reason.trim()) fail(EXIT.INPUT, "--triage-stop needs a reason");
	const feKey = opts.fe ? opts.fe.toUpperCase() : null;
	if (feKey && code !== "FE_LINKED") fail(EXIT.INPUT, "--triage-stop takes --fe only with FE_LINKED");
	if (feKey && !/^[A-Z][A-Z0-9]*-\d+$/.test(feKey)) fail(EXIT.INPUT, `--fe "${opts.fe}" with --triage-stop must be the FE ticket key, like QRD-1582`);
	if (opts.feStatus && !feKey) fail(EXIT.INPUT, "--fe-status needs --fe <FE-KEY>");
	const followsFe = feKey ? { key: feKey, status: opts.feStatus && opts.feStatus.trim() ? opts.feStatus.trim() : null } : null;
	const lockFile = acquireLock(key);
	try {
		const startedAt = new Date().toISOString();
		const stamp = utcStamp();
		const runDir = path.join(QA_LOCAL, "runs", key, stamp);
		fs.mkdirSync(runDir, { recursive: true });
		const prog = progress.create(runDir, { key, runId: stamp, startedAt, tcs: [], external: false });
		for (const id of ["stack", "login", "tests"]) prog.step(id, "skipped");
		const text = followsFe
			? `Follows FE ${followsFe.key}${followsFe.status ? ` (${followsFe.status})` : ""}: the BE ticket takes the result of its FE pair, no test was run. Reason code ${code}: ${reason.trim()}`
			: `Stopped at triage or review, no test was run. Reason code ${code}: ${reason.trim()}`;
		const counts = { Passed: 0, "Passed with Note": 0, Failed: 0, Blocked: 0 };
		const status = followsFe ? "FOLLOWS_FE" : "ESCALATED";
		const rule = followsFe ? "J-FOLLOWS-FE" : "J-ESCALATED";
		const ruleText = followsFe
			? "The BE ticket follows the result of its FE pair (triage-rules.md, \"Pasangan FE dan BE beda tiket\"); nothing was tested here."
			: "The run stopped at triage or review (triage-rules.md, reviewer.md); nothing was tested.";
		const verdict = { prediction: status, rule, ruleText, reasons: [text], reasonCode: code };
		const finishedAt = new Date().toISOString();
		const results = {
			schema: "qonflo-qa-local/1",
			key,
			summary: null,
			runId: stamp,
			startedAt,
			finishedAt,
			target: "local",
			stoppedAt: "triage",
			reasonCode: code,
			reason: reason.trim(),
			...(followsFe ? { followsFe } : {}),
			verdict,
			stack: { mode: "none", be: {}, fe: {}, stopped: [], protectedPorts: [] },
			users: [],
			counts,
			tcs: [],
			ac: [],
			tickets: [{ ticket: key, action: "TEST", round: 1, ticketStatus: status, counts, flaky: 0, transition: "SKIP", reason: text.slice(0, 1000), durationSec: 0 }],
			verdictIn: [],
		};
		fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
		const summary = [
			`# Run summary ${stamp}`,
			"",
			`**${key}**: stopped at triage or review, status **${status}** (rule ${rule}). No stack, no Playwright, no Jira label, no transition, no Confluence row.`,
			"",
			...(followsFe ? [`- Follows FE: ${followsFe.key}${followsFe.status ? ` (${followsFe.status})` : ""}`] : []),
			`- Reason code: ${code}`,
			`- Reason: ${reason.trim().split(/\r?\n/).join(" ")}`,
			"",
		];
		fs.writeFileSync(path.join(runDir, "summary.md"), summary.join("\n"));
		prog.done({ tcs: [], verdict, counts, followsFe });
		log(`run folder ${runDir}`);
		log(`verdict prediction ${status} (rule ${rule}), stopped at triage: ${code}${followsFe ? `, follows ${followsFe.key}` : ""}`);
		return EXIT.ESCALATED;
	} finally {
		releaseLock(lockFile);
	}
}

function utcStamp(d = new Date()) {
	return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function runChild(cmd, args, { cwd, env, logFile, tee, timeoutMs, onSpawn, onLine }) {
	return new Promise((resolve) => {
		const out = fs.createWriteStream(logFile, { flags: "a" });
		let settled = false;
		const settle = (v) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			out.end();
			resolve(v);
		};
		const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		if (onSpawn) onSpawn(child);
		let rest = "";
		const pipe = (src, dst) =>
			src.on("data", (b) => {
				out.write(b);
				if (tee) dst.write(b);
				if (onLine) {
					const lines = (rest + b.toString()).split("\n");
					rest = lines.pop();
					for (const l of lines) onLine(l);
				}
			});
		pipe(child.stdout, process.stdout);
		pipe(child.stderr, process.stderr);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 10000).unref();
		}, timeoutMs);
		child.on("error", (e) => {
			out.write(`spawn error: ${e.message}\n`);
			settle({ code: null, signal: null, timedOut, error: e.message });
		});
		child.on("close", (code, signal) => settle({ code, signal, timedOut }));
	});
}

async function bootStack(ctx, dirs, guard) {
	const bases = KIT_PATHS.ticketPortBase || { be: 3200, fe: 5300 };
	const bePort = await stack.freePort(Math.max(3200, Number(bases.be) || 3200), guard);
	const fePort = await stack.freePort(Math.max(5300, Number(bases.fe) || 5300), guard, [bePort]);
	for (const p of [bePort, fePort]) if (guard.has(String(p))) throw new Error(`refused protected port ${p}`);
	log(`ports: backend ${bePort}, frontend ${fePort}`);
	const preload = path.join(KIT, "ai-preload.cjs");
	const beArgs = fs.existsSync(preload) ? ["tsx", "--require", preload, "src/core/app.ts"] : ["tsx", "src/core/app.ts"];
	const be = stack.start({ name: "be", cwd: dirs.be.dir, args: beArgs, env: stack.backendEnv(dirs.be.dir, bePort), log: path.join(ctx.runDir, "logs", "be.log"), port: bePort, marker: "tsx" });
	ctx.started.push(be);
	stack.record(ctx.runDir, ctx.started);
	log(`backend started from ${dirs.be.dir} (pgid ${be.pgid})`);
	const viteConfig = path.join(KIT, "vite.wt.config.mjs");
	const feArgs = fs.existsSync(viteConfig) ? ["vite", "--config", viteConfig, "--port", String(fePort), "--strictPort"] : ["vite", "--port", String(fePort), "--strictPort"];
	const feEnv = { ...process.env, VITE_QONFLO_API_URL: `http://localhost:${bePort}`, WT_VITE_CACHE: path.join(QA_LOCAL, ".cache", "vite", path.basename(dirs.fe.dir)) };
	const fe = stack.start({ name: "fe", cwd: dirs.fe.dir, args: feArgs, env: feEnv, log: path.join(ctx.runDir, "logs", "fe.log"), port: fePort, marker: "vite" });
	ctx.started.push(fe);
	stack.record(ctx.runDir, ctx.started);
	log(`frontend started from ${dirs.fe.dir} (pgid ${fe.pgid})`);
	const beUrl = `http://localhost:${bePort}`;
	const feUrl = `http://localhost:${fePort}`;
	await Promise.all([
		stack.waitHttp(`${beUrl}/`, be, { timeoutMs: BOOT_TIMEOUT_MS, ok: (s) => s < 500 }),
		stack.waitHttp(`${feUrl}/`, fe, { timeoutMs: BOOT_TIMEOUT_MS, ok: (s) => s >= 200 && s < 400 }),
	]);
	log("stack answers");
	return { beUrl, feUrl, fePort };
}

async function loginAll(ctx, users) {
	const states = {};
	for (const u of users) {
		const out = path.join(PROJECTS, ".playwright", "auth", `local-${ctx.urls.fePort}.json`);
		const before = Date.now();
		const logFile = path.join(ctx.runDir, "logs", `login-${u.id}.log`);
		log(`login ${u.email}`);
		const r = await runChild(process.execPath, [path.join(KIT, "login-state.cjs"), String(ctx.urls.fePort), u.email], {
			cwd: PROJECTS,
			env: { ...process.env, QONFLO_PASS_FILE: u.passFile },
			logFile,
			tee: false,
			timeoutMs: LOGIN_TIMEOUT_MS,
		});
		if (r.code !== 0) throw new Error(`login as ${u.email} failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}); see ${logFile}`);
		if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < before - 1000) throw new Error(`login as ${u.email} wrote no fresh ${out}`);
		const dest = path.join(ctx.runDir, "auth", `${u.id}.json`);
		fs.copyFileSync(out, dest);
		fs.chmodSync(dest, 0o600);
		states[u.id] = dest;
	}
	return states;
}

async function runPlaywright(ctx) {
	const reportFile = path.join(ctx.runDir, "pw-report.json");
	const env = {
		...process.env,
		NODE_PATH: [QA_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
		QA_KEY: ctx.key,
		QA_TESTS_DIR: ctx.inputs.dir,
		QA_RUN_DIR: ctx.runDir,
		QA_REPORT_FILE: reportFile,
		QA_FE_URL: ctx.urls.feUrl,
		QA_BE_URL: ctx.urls.beUrl,
		QA_STATE_LOCAL: ctx.states.local,
		QA_STATE_LOCAL2: ctx.states.local2,
		FORCE_COLOR: "0",
		CI: "1",
	};
	log("playwright: workers=1, video on");
	ctx.progress.testsStarted();
	const r = await runChild(process.execPath, [PW_CLI, "test", "--config", path.join(QA_CODE, "playwright.config.ts")], {
		cwd: QA_LOCAL,
		env,
		logFile: path.join(ctx.runDir, "logs", "playwright.log"),
		tee: true,
		timeoutMs: PW_TIMEOUT_MS,
		onSpawn: (c) => {
			ctx.pwChild = c;
		},
		onLine: (l) => ctx.progress.line(l),
	});
	let json = null;
	try {
		json = JSON.parse(fs.readFileSync(reportFile, "utf8"));
	} catch {}
	if (!json) throw new Error(`Playwright exited ${r.code}${r.timedOut ? " after the time limit" : ""} without a JSON report; see logs/playwright.log`);
	const topErrors = (json.errors || []).map((e) => e.message || e.value).filter(Boolean);
	return { code: r.code, timedOut: r.timedOut, json, topErrors };
}

function cleanup(ctx) {
	if (ctx.cleaned) return;
	ctx.cleaned = true;
	if (ctx.pwChild && ctx.pwChild.exitCode === null) {
		try {
			ctx.pwChild.kill("SIGTERM");
		} catch {}
	}
	if (ctx.opts.keepStack && ctx.started.length) {
		ctx.stopped = ctx.started.map((p) => `${p.name}: kept running (pgid ${p.pgid}, port ${p.port}); stop with qonflo-qa-local --stop ${ctx.runDir}`);
	} else {
		ctx.stopped = stack.stopAll(ctx.started);
	}
	for (const line of ctx.stopped) log(line);
	fs.rmSync(path.join(ctx.runDir, "auth"), { recursive: true, force: true });
	if (ctx.lockFile) releaseLock(ctx.lockFile);
}

function installCleanup(ctx) {
	process.on("exit", () => cleanup(ctx));
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => {
			log(`${sig}: stopping`);
			cleanup(ctx);
			process.exit(130);
		});
	}
	process.on("uncaughtException", (e) => {
		process.stderr.write(`qonflo-qa-local: ${e.stack || e.message}\n`);
		cleanup(ctx);
		process.exit(EXIT.INFRA);
	});
}

function finish(ctx) {
	const acDoc = ctx.inputs.ac;
	const tcs = ctx.pw ? report.collect(ctx.pw.json, ctx.runDir, acDoc) : [];
	const infraError = ctx.infraError || (ctx.pw && ctx.pw.topErrors.length ? `Playwright errors outside tests: ${ctx.pw.topErrors.join(" | ").slice(0, 2000)}` : null);
	const acRows = acStatus(acDoc.ac, tcs);
	const verdict = judge({ infraError, tcs, acRows });
	const part = (name, d) => {
		const proc = ctx.started.find((p) => p.name === name);
		const url = name === "be" ? ctx.urls && ctx.urls.beUrl : ctx.urls && ctx.urls.feUrl;
		return { dir: d ? d.dir : null, how: d ? d.how : "external URL", ...report.gitInfo(d && fs.existsSync(d.dir) ? d.dir : null), port: proc ? proc.port : null, url: url || null, log: proc ? path.relative(ctx.runDir, proc.log) : null };
	};
	const results = {
		schema: "qonflo-qa-local/1",
		key: ctx.key,
		summary: acDoc.summary || null,
		runId: ctx.stamp,
		startedAt: ctx.startedAt,
		finishedAt: new Date().toISOString(),
		target: "local",
		acSource: { file: path.relative(QA_LOCAL, path.join(ctx.inputs.dir, "ac.json")), fetchedAt: acDoc.fetchedAt || null, source: acDoc.source || null },
		tcFile: ctx.inputs.tcFile ? path.relative(QA_LOCAL, ctx.inputs.tcFile) : null,
		verdict,
		stack: { mode: ctx.opts.noStack ? "external" : "started", be: part("be", ctx.dirs && ctx.dirs.be), fe: part("fe", ctx.dirs && ctx.dirs.fe), stopped: ctx.stopped || [], protectedPorts: [...ctx.guard] },
		users: ["local@test.com", "local2@test.com"],
		counts: report.counts(tcs),
		tcs,
		ac: acRows,
		infraError,
		playwright: ctx.pw ? { exitCode: ctx.pw.code, timedOut: ctx.pw.timedOut } : null,
	};
	report.write(ctx.runDir, results);
	return results;
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		if (e instanceof UsageError) fail(EXIT.INPUT, `${e.message}\n\n${USAGE}`);
		throw e;
	}
	if (opts.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (opts.stop) {
		for (const line of stack.stopRecorded(path.resolve(opts.stop))) log(line);
		return 0;
	}
	if (!opts.key) fail(EXIT.INPUT, `missing <KEY>\n\n${USAGE}`);
	const key = opts.key.toUpperCase();
	if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) fail(EXIT.INPUT, `"${opts.key}" is not a ticket key like QRD-1286`);
	if (!opts.noStack && (opts.beUrl || opts.feUrl)) fail(EXIT.INPUT, "--be-url and --fe-url work only with --no-stack");
	if (opts.noStack && (opts.be || opts.fe || opts.keepStack)) fail(EXIT.INPUT, "--no-stack does not take --be, --fe or --keep-stack");
	if (opts.feStatus && !opts.triageStop) fail(EXIT.INPUT, "--fe-status works only with --triage-stop");
	if (opts.triageStop) return triageStop(key, opts);
	const inputs = loadInputs(key);
	if (!fs.existsSync(PW_CLI)) fail(EXIT.INPUT, `no Playwright runner at ${PW_CLI}; it looks in ~/qa/node_modules and ~/.claude/kit/qa-local/node_modules; run ccfg update (or personalize.sh --only=qa) again`);
	if (!fs.existsSync(path.join(KIT, "login-state.cjs"))) fail(EXIT.INPUT, `no ${path.join(KIT, "login-state.cjs")}`);
	const users = passFiles();
	const guard = stack.protectedPorts(KIT_PATHS.protectedPorts || []);
	const external = opts.noStack ? preflightExternal(opts, guard) : null;
	const dirs = opts.noStack ? null : preflightStack(key, opts);
	const lockFile = acquireLock(key);
	const stamp = utcStamp();
	const runDir = path.join(QA_LOCAL, "runs", key, stamp);
	for (const d of ["logs", "videos", "auth"]) fs.mkdirSync(path.join(runDir, d), { recursive: true });
	fs.chmodSync(path.join(runDir, "auth"), 0o700);
	const ctx = { key, stamp, runDir, opts, inputs, dirs, guard, lockFile, started: [], startedAt: new Date().toISOString(), urls: external, states: null, pw: null, pwChild: null, infraError: null, stopped: null, cleaned: false };
	ctx.progress = progress.create(runDir, { key, runId: stamp, startedAt: ctx.startedAt, tcs: inputs.ac.tcs, external: opts.noStack });
	installCleanup(ctx);
	log(`run folder ${runDir}`);
	try {
		if (!opts.noStack) {
			ctx.progress.step("stack", "running");
			ctx.urls = await bootStack(ctx, dirs, guard);
			ctx.progress.step("stack", "done");
		}
		ctx.progress.step("login", "running");
		ctx.states = await loginAll(ctx, users);
		ctx.progress.step("login", "done");
		ctx.pw = await runPlaywright(ctx);
		ctx.progress.step("tests", "done");
	} catch (e) {
		ctx.infraError = e.message;
		log(`error: ${e.message}`);
	}
	cleanup(ctx);
	ctx.progress.step("judge", "running");
	const results = finish(ctx);
	ctx.progress.done(results);
	log(`verdict prediction ${results.verdict.prediction} (rule ${results.verdict.rule})`);
	log(`summary ${path.join(runDir, "summary.md")}`);
	if (results.verdict.prediction === "LOLOS") return EXIT.LOLOS;
	if (results.verdict.prediction === "REVISION") return EXIT.REVISION;
	return results.infraError ? EXIT.INFRA : EXIT.ESCALATED;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		process.stderr.write(`qonflo-qa-local: ${e.stack || e.message}\n`);
		process.exit(EXIT.INFRA);
	}
);
