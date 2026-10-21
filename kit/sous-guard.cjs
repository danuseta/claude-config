// PreToolUse guards for the sous-* agents, wired from each agent's `hooks:` frontmatter. guard.cjs stays the global guard; these only narrow.
//   sous-guard.cjs path <root>...          Edit/Write/NotebookEdit: only under a root, never package.json, lockfiles, .github, .husky, .git,
//                                          .env*, CLAUDE.md, AGENTS.md, node_modules, secrets, or the generated blackboard files
//   sous-guard.cjs path --read <root>...   Read/Grep/Glob: only under a root, never a secret file
//   sous-guard.cjs bash <root>...          Bash for agents that only read: one simple command, read-only file commands under a root,
//                                          read-only git inside a worktree, read-only gh
//   sous-guard.cjs runner <root>...        Agent/Task: only sous-* agents and browser-verifier. Bash: what `bash` allows, plus the kit's
//                                          status, prep, worktree, stack and demo scripts
//   sous-guard.cjs verify <root>...        Bash for sous-verifier: [cd <root> &&] one test or type-check command (vitest, jest, tsc, eslint,
//                                          playwright, npm|pnpm|yarn test/run, node --test), read-only file commands and git; no installs,
//                                          dev servers, inline node code or network tools
//   sous-guard.cjs publish                 Bash for sous-publisher: git inside a worktree, add per path, commit -m, push of the current
//                                          feat|fix/<KEY>-... branch, gh pr create|list|view; never add -A or ., never develop/main/master
//   sous-guard.cjs jira [--record]         createJiraIssue / editJiraIssue for sous-jira: project QRD, content fields only, edits only on
//                                          tickets sous-jira created (the PostToolUse --record call keeps that list)
// Roots: @wt (every <root>/wt-* worktree), @root, @evidence, @board (<evidence>/blackboard), @config. Values come from paths.cjs.
// Answers like guard.cjs: a deny JSON on stdout, nothing when allowed. A guard that cannot read its input denies.
// SOUS_GUARD_NOLOG=1 keeps a deny out of kit/guard.log (tests).
// Test: echo '{"tool_name":"Write","tool_input":{"file_path":"E:/qonflo/wt-1-be/package.json"}}' | node sous-guard.cjs path @wt
const fs = require("fs");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");

const PROTECTED = [/(^|\/)\.git(\/|$)/, /(^|\/)\.husky(\/|$)/, /(^|\/)\.github(\/|$)/, /(^|\/)\.claude(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.env[^/]*$/, /(^|\/)\.npmrc$/, /(^|\/)\.nvmrc$/, /(^|\/)package\.json$/, /(^|\/)package-lock\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)yarn\.lock$/, /(^|\/)CLAUDE\.md$/i, /(^|\/)AGENTS\.md$/i];
const SECRETS = [/(^|\/)\.env(?!\.example$)[^/]*$/, /(^|\/)\.npmrc$/, /(^|\/)\.ssh(\/|$)/, /(^|\/)id_[^/]*$/, /(^|\/)\.credentials\.json$/, /(^|\/)\.git-credentials$/, /\.pem$/, /\.key$/, /(^|\/)secrets?\.(env|local\.json)$/, /(^|\/)\.netrc$/, /(^|\/)dock(-chat)?\.json$/, /(^|\/)elevenlabs-keys\.json$/];
const GENERATED = /^[^/]+\/(status|decisions|issues|NOW)\.md$/i;
const AGENTS = new Set(["sous-planner", "sous-ticket-worker", "sous-reviewer", "sous-verifier", "sous-arbiter", "sous-publisher", "sous-analyst", "sous-pr-reviewer", "sous-explorer", "sous-jira", "browser-verifier"]);
const READ_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "du", "diff", "read", "tree"]);
const FIND_DENY = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "merge-base", "ls-files", "blame"]);
const GH_READ = new Set(["pr list", "pr view", "pr diff", "pr checks", "pr status", "run list", "run view", "repo view"]);
const TEST_TOOLS = new Set(["vitest", "jest", "tsc", "eslint", "playwright"]);
const PKG_DENY = /^(i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|ln|publish|exec|dlx|x|create|init|dev|start|serve|preview|watch|deploy)(:|$)/;
const KIT_NODE = new Set(["status.cjs", "demo-upload.cjs", "paths.cjs", "doctor.cjs"]);
const KIT_BASH = { "prep-ticket.sh": null, "stack.sh": new Set(["status", "up", "down"]), "wt.sh": new Set(["add", "check"]) };
const PROTECTED_BRANCHES = new Set(["develop", "development", "main", "master"]);
const BRANCH = /^(feat|fix)\/[A-Z][A-Z0-9]*-\d+(-[A-Za-z0-9._-]+)?$/;
const JIRA_PROJECT = "QRD";
const JIRA_EDIT_FIELDS = new Set(["summary", "description", "priority", "labels", "components", "duedate"]);
const SPRINT = /sprint|^QRD\d+$/i;

function createSousGuard({ platform = process.platform, paths = resolvePaths(), cwd = process.cwd(), ledgerFile = path.join(__dirname, "sous-jira-created.log") } = {}) {
	const win = platform === "win32";
	const P = win ? path.win32 : path.posix;
	const fwd = (p) => String(p).replace(/\\/g, "/");
	const norm = (p, base = cwd) => {
		let s = fwd(p).replace(/^~(?=\/|$)/, fwd(require("os").homedir()));
		if (win) s = s.replace(/^\/([a-zA-Z])(\/|$)/, "$1:/");
		s = fwd(P.resolve(fwd(base), s)).replace(/\/+$/, "");
		if (platform === process.platform) try { s = fwd(fs.realpathSync.native(s)).replace(/\/+$/, ""); } catch {}
		return win ? s.toLowerCase() : s;
	};
	const root = norm(paths.root);
	const named = { "@root": root, "@evidence": norm(paths.evidence), "@board": norm(`${paths.evidence}/blackboard`), "@config": norm(paths.configDir) };
	const board = named["@board"];
	const kit = norm(paths.kitDir);
	const inside = (p, r) => p === r || p.startsWith(r + "/");
	// The root a path falls under, or null. @wt is the worktree folder itself: <root>/wt-<name>.
	const rootOf = (p, roots) => {
		for (const r of roots) {
			if (r === "@wt") {
				const m = inside(p, root) ? p.slice(root.length + 1).split("/")[0] : "";
				if (/^wt-[^/]+$/.test(m)) return `${root}/${m}`;
			} else if (named[r] && inside(p, named[r])) return named[r];
			else if (!named[r] && r !== "@wt" && inside(p, norm(r))) return norm(r);
		}
		return null;
	};
	const rel = (p, r) => (p === r ? "" : p.slice(r.length + 1));
	const secret = (p) => SECRETS.find((re) => re.test(p));

	function filePath(tool, input, read) {
		const raw = input.file_path || input.notebook_path || input.path || (read ? cwd : "");
		if (!raw) return { why: "no file path" };
		const p = norm(raw);
		return { p, raw };
	}

	function checkPath(tool, input, roots, read) {
		const { p, raw, why } = filePath(tool, input, read);
		if (why) return why;
		const r = rootOf(p, roots);
		if (!r) return `${raw} is outside the folders this agent may ${read ? "read" : "write"} (${roots.join(", ")})`;
		const sub = rel(p, r);
		if (read) return secret(p) ? `${raw} is a secret file` : null;
		const hit = PROTECTED.find((re) => re.test(sub)) || secret(p);
		if (hit) return `${raw} is protected (package files, lockfiles, CI, git, env and agent rules belong to the owner); report it as BLOCKED`;
		if (inside(p, board) && GENERATED.test(rel(p, board))) return `${raw} is generated from the ledger; change it with status.cjs (decide, issue, round, set) and \`status.cjs render\``;
		return null;
	}

	// One simple command: no ; & | < > ` $ or newline outside single quotes, no $ or backtick inside double quotes.
	function simple(cmd) {
		let q = null;
		for (let i = 0; i < cmd.length; i++) {
			const c = cmd[i];
			if (q === "'") { if (c === "'") q = null; }
			else if (q === '"') { if (c === "\\") i++; else if (c === '"') q = null; else if (c === "$" || c === "`") return "$ and backticks are not allowed inside double quotes"; }
			else if (c === "\\") { if (cmd[i + 1] === "\n") return "newlines are not allowed"; i++; }
			else if (c === "'" || c === '"') q = c;
			else if (";&|<>()`$\n".includes(c)) return `operator ${JSON.stringify(c)} is not allowed: one simple command per call, no pipes, redirection or variables`;
		}
		return q ? "unterminated quote" : null;
	}
	const split = (cmd) => {
		const out = [];
		const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
		let m;
		while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
		return out;
	};
	const words = (cmd) => {
		const w = split(cmd);
		while (w[0] === "rtk" || w[0] === "proxy") w.shift();
		return w;
	};

	function checkRead(w, roots) {
		const [cmd, ...args] = w;
		if (cmd === "find" && args.some((a) => FIND_DENY.has(a))) return "find: -exec, -delete and -fprint are not allowed";
		let named_ = false;
		for (const a of args) {
			if (a === "-" || (a.startsWith("-") && !a.includes("="))) continue;
			const v = a.startsWith("-") ? a.slice(a.indexOf("=") + 1) : a;
			if (!/[\\/]/.test(v) && !/^~/.test(v) && !fs.existsSync(P.resolve(cwd, v))) continue;
			named_ = true;
			const p = norm(v);
			if (!rootOf(p, roots)) return `${cmd}: ${v} is outside the folders this agent may read`;
			if (secret(p)) return `${cmd}: ${v} is a secret file`;
		}
		if (!named_ && !rootOf(norm(cwd), roots)) return `${cmd}: name a path under the folders this agent may read`;
		return null;
	}

	function checkGitRead(w, roots = ["@wt"]) {
		if (w[1] !== "-C" || !w[2]) return "git runs as git -C <folder> <subcommand>";
		if (!rootOf(norm(w[2]), roots)) return `git -C ${w[2]} is outside the folders this agent may read`;
		const sub = w[3];
		if (sub === "branch" && w.slice(4).join(" ") === "--show-current") return null;
		if (sub === "remote" && w.slice(4).join(" ") === "get-url origin") return null;
		if (!GIT_READ.has(sub)) return `git ${sub ?? ""} is not a read-only git command`;
		if (w.some((a) => /^--(output|ext-diff)/.test(a))) return "git option not allowed";
		return null;
	}

	function checkGhRead(w) {
		const pos = w.slice(1).filter((a) => !a.startsWith("-"));
		if (GH_READ.has(pos.slice(0, 2).join(" "))) return null;
		return "gh: only pr list/view/diff/checks/status, run list/view and repo view";
	}

	function checkKit(w) {
		const [prog, file, sub] = w;
		const base = file ? fwd(file).split("/").pop() : "";
		const own = file && norm(file) === `${kit}/${win ? base.toLowerCase() : base}`;
		const kitNode = /(^|\/)kit-node$/.test(fwd(prog)) && norm(prog) === `${kit}/bin/kit-node`;
		if (prog === "node" || kitNode) {
			if (kitNode ? KIT_NODE.has(file) : own && KIT_NODE.has(base)) return null;
			return "node only runs the kit's status.cjs, demo-upload.cjs, paths.cjs and doctor.cjs";
		}
		if (prog === "bash" && own && Object.hasOwn(KIT_BASH, base)) {
			const allowed = KIT_BASH[base];
			return !allowed || allowed.has(sub) ? null : `${base} ${sub ?? ""} is not for an agent`;
		}
		return "";
	}

	function checkBash(cmd, roots, runner) {
		const bad = simple(cmd);
		if (bad) return bad;
		const w = words(cmd);
		if (!w.length) return "empty command";
		if (w[0] === "git") return checkGitRead(w, roots);
		if (w[0] === "gh") return checkGhRead(w);
		if (READ_CMDS.has(w[0])) return checkRead(w, roots);
		if (runner) {
			const k = checkKit(w);
			if (k !== "") return k;
		}
		return `${w[0]} is not allowed here: read-only file commands, read-only git inside a worktree, read-only gh${runner ? " and the kit scripts" : ""}`;
	}

	// The verifier's tests: `cd <worktree> && <command>`, the command one of the test, type-check and read-only tools, every path inside a root.
	function checkVerify(cmd, roots) {
		let dir = cwd;
		let rest = cmd;
		const cd = /^\s*cd\s+("[^"$`]*"|'[^']*'|[^\s;&|<>()`$]+)\s*&&\s*/.exec(cmd);
		if (cd) { dir = split(cd[1])[0]; rest = cmd.slice(cd[0].length); }
		const bad = simple(rest);
		if (bad) return bad;
		const here = norm(dir);
		if (!rootOf(here, roots)) return `run inside a ticket worktree: cd ${paths.root}/wt-<name> && <command>`;
		const w = words(rest);
		while (w.length && (/^(NO_COLOR|FORCE_COLOR|CI|TZ)=[^\s]*$/.test(w[0]) || w[0] === "rtk")) w.shift();
		if (!w.length) return "empty command";
		for (const a of w.slice(1)) {
			const v = a.startsWith("-") ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "") : a;
			if (!v || (!/[\\/]/.test(v) && !/^~/.test(v) && !fs.existsSync(P.resolve(here, v)))) continue;
			const p = norm(v, here);
			if (!rootOf(p, roots)) return `${w[0]}: ${v} is outside the folders this agent may use`;
			if (secret(p)) return `${w[0]}: ${v} is a secret file`;
		}
		const [prog, ...args] = w;
		const pos = args.filter((a) => !a.startsWith("-"));
		if (prog === "git") return checkGitRead(w, roots);
		if (READ_CMDS.has(prog)) return prog === "find" && args.some((a) => FIND_DENY.has(a)) ? "find: -exec, -delete and -fprint are not allowed" : null;
		if (TEST_TOOLS.has(prog)) return null;
		if (prog === "npx" || (prog === "pnpm" && pos[0] === "exec") || (prog === "yarn" && pos[0] === "exec")) {
			const tool = prog === "npx" ? pos[0] : pos[1];
			const before = args.slice(0, args.indexOf(tool));
			return TEST_TOOLS.has(tool) && !before.some((a) => /^(-p|--package|-y|--yes)(=|$)/.test(a)) ? null : `${prog}: only ${[...TEST_TOOLS].join(", ")}, without installing a package`;
		}
		if (prog === "npm" || prog === "pnpm" || prog === "yarn") {
			const sub = pos[0] === "run" || pos[0] === "run-script" ? pos[1] : pos[0];
			if (!sub || PKG_DENY.test(sub)) return `${prog} ${pos[0] ?? ""}: no installs, dev servers or publishing; tests and type checks only`;
			if (pos[0] === "run" || pos[0] === "run-script" || pos[0] === "test" || pos[0] === "t" || prog !== "npm") return null;
			return `npm ${pos[0]} is not a test command`;
		}
		if (prog === "node") {
			if (args.some((a) => /^(-e|--eval|-p|--print|-r|--require|--import|-i|--interactive)(=|$)/.test(a))) return "node: no inline code or preloads; run --test or a test file";
			return args.includes("--test") || pos.length ? null : "node: run --test or a test file";
		}
		return `${prog} is not allowed for the verifier: tests, type checks, read-only file commands and read-only git`;
	}

	function checkPublish(cmd) {
		const bad = simple(cmd);
		if (bad) return bad;
		const w = words(cmd);
		if (w[0] === "git") {
			if (w[1] !== "-C" || !w[2]) return "git runs as git -C <worktree> <subcommand>";
			const wt = rootOf(norm(w[2]), ["@wt"]);
			if (!wt) return `git only inside a ticket worktree (${paths.root}/wt-*), not ${w[2]}`;
			const [sub, ...args] = w.slice(3);
			if (sub === "add") {
				if (!args.length) return "git add needs the paths to stage";
				if (args.some((a) => a.startsWith("-") || a === "." || a === "*" || a === ":/" || norm(a, w[2]) === wt)) return "git add stages named paths only: never -A, --all, -u or .";
				return null;
			}
			if (sub === "commit") {
				for (let i = 0; i < args.length; i += 2) if (args[i] !== "-m" || args[i + 1] === undefined) return "git commit takes -m <message> only";
				if (!args.length) return "git commit needs -m";
				if (/co-authored-by|generated with \[?claude/i.test(args.join(" "))) return "no AI attribution in a commit message";
				return null;
			}
			if (sub === "push") {
				const rest = args.filter((a) => a !== "-u");
				if (rest.length !== 2 || rest[0] !== "origin") return "push is git -C <worktree> push [-u] origin <branch>";
				const br = rest[1];
				if (PROTECTED_BRANCHES.has(br) || !BRANCH.test(br)) return `branch ${br} is not a ticket branch (feat|fix/<KEY>-<slug>)`;
				let cur = "";
				try { cur = require("child_process").execFileSync("git", ["-C", w[2], "branch", "--show-current"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch {}
				return cur === br ? null : `only the current branch can be pushed (${cur || "detached"})`;
			}
			return checkGitRead(w);
		}
		if (w[0] === "gh" && w[1] === "pr" && w[2] === "create") {
			const f = {};
			const args = w.slice(3);
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--draft") { f.draft = true; continue; }
				if (!["--repo", "--base", "--head", "--title", "--body-file"].includes(args[i]) || args[i + 1] === undefined || f[args[i]]) return `gh pr create: argument not allowed: ${args[i]}`;
				f[args[i]] = args[++i];
			}
			if (["--repo", "--base", "--head", "--title", "--body-file"].some((k) => !f[k])) return "gh pr create needs --repo --base --head --title --body-file";
			if (!BRANCH.test(f["--head"])) return `head ${f["--head"]} is not a ticket branch (feat|fix/<KEY>-<slug>)`;
			if (PROTECTED_BRANCHES.has(f["--head"])) return "head cannot be a protected branch";
			if (!rootOf(norm(f["--body-file"]), ["@evidence"])) return "the PR body file lives under the evidence folder";
			try { if (/co-authored-by|generated with \[?claude/i.test(fs.readFileSync(norm(f["--body-file"]), "utf8"))) return "no AI attribution in a PR body"; } catch {}
			return null;
		}
		if (w[0] === "gh") return checkGhRead(w);
		return `${w[0]} is not allowed for the publisher`;
	}

	const created = () => {
		try { return new Set(fs.readFileSync(ledgerFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).key)); } catch { return new Set(); }
	};
	const sprintField = (k) => /sprint/i.test(k) || ["assignee", "reporter", "customfield_10020"].includes(k);
	function checkJira(tool, ti) {
		if (/createJiraIssue$/.test(tool)) {
			if (ti.projectKey !== JIRA_PROJECT) return `only project ${JIRA_PROJECT}`;
			if (ti.transition) return "no workflow transition at creation";
			if (ti.assignee_account_id) return "leave the ticket unassigned";
			const extra = ti.additional_fields || {};
			const bad = Object.keys(extra).find(sprintField);
			if (bad) return `field not allowed: ${bad}`;
			if ((extra.labels || []).some((l) => SPRINT.test(String(l)))) return "no sprint labels";
			if (ti.parent && !created().has(String(ti.parent))) return `parent ${ti.parent} was not created by sous-jira`;
			return null;
		}
		if (/editJiraIssue$/.test(tool)) {
			const key = String(ti.issueIdOrKey || "");
			if (!created().has(key)) return `${key} was not created by sous-jira; only those can be edited`;
			const bad = Object.keys(ti.fields || {}).filter((k) => !JIRA_EDIT_FIELDS.has(k));
			if (bad.length) return `fields not allowed: ${bad.join(", ")} (allowed: ${[...JIRA_EDIT_FIELDS].join(", ")})`;
			if ((ti.fields?.labels || []).some((l) => SPRINT.test(String(l)))) return "no sprint labels";
			return null;
		}
		return `tool not allowed: ${tool}`;
	}
	function record(response) {
		const seen = new Set();
		const walk = (x) => {
			if (typeof x === "string") { try { return walk(JSON.parse(x)); } catch { return null; } }
			if (!x || typeof x !== "object" || seen.has(x)) return null;
			seen.add(x);
			if (typeof x.key === "string" && new RegExp(`^${JIRA_PROJECT}-\\d+$`).test(x.key) && ("id" in x || "self" in x)) return x.key;
			for (const v of Object.values(x)) { const k = walk(v); if (k) return k; }
			return null;
		};
		const key = walk(response);
		if (key) fs.appendFileSync(ledgerFile, JSON.stringify({ key, at: new Date().toISOString() }) + "\n");
		return key;
	}

	// The deny reason for one hook payload, or null.
	function check(mode, args, payload) {
		const tool = payload.tool_name || "";
		const ti = payload.tool_input || {};
		const read = args[0] === "--read";
		const roots = read ? args.slice(1) : args;
		if (mode === "path") return checkPath(tool, ti, roots, read || /^(Read|Grep|Glob)$/.test(tool));
		if (mode === "bash") return tool === "Bash" ? checkBash(String(ti.command || ""), roots, false) : null;
		if (mode === "runner") {
			if (tool === "Agent" || tool === "Task") return AGENTS.has(ti.subagent_type) ? null : `subagent type not allowed: ${ti.subagent_type || "(none)"}; a runner calls sous-* agents and browser-verifier only`;
			return tool === "Bash" ? checkBash(String(ti.command || ""), roots, true) : null;
		}
		if (mode === "verify") return tool === "Bash" ? checkVerify(String(ti.command || ""), roots) : null;
		if (mode === "publish") return tool === "Bash" ? checkPublish(String(ti.command || "")) : null;
		if (mode === "jira") return checkJira(tool, ti);
		return `unknown guard mode ${mode}`;
	}
	return { check, record, norm };
}

const deny = (why) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `sous guard: ${why}` } });

function main() {
	const [mode, ...args] = process.argv.slice(2);
	let payload;
	try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return process.stdout.write(deny("could not read the hook input")); }
	const g = createSousGuard({ cwd: payload.cwd || process.cwd() });
	if (mode === "jira" && args[0] === "--record") return void g.record(payload.tool_response);
	const why = g.check(mode, args, payload);
	if (why) {
		if (process.env.SOUS_GUARD_NOLOG !== "1") try { fs.appendFileSync(path.join(__dirname, "guard.log"), `${new Date().toISOString()} DENY sous-${mode} ${payload.agent_type ?? "-"} :: ${String(payload.tool_input?.command ?? payload.tool_input?.file_path ?? payload.tool_name).replace(/\s+/g, " ").slice(0, 300)}\n`); } catch {}
		process.stdout.write(deny(why));
	}
}

if (require.main === module) {
	try { main(); } catch (e) { process.stdout.write(deny(`internal error (${e.message}); refusing`)); }
} else {
	module.exports = { createSousGuard, deny };
}
