// PreToolUse guards for the sous-* agents, wired from each agent's `hooks:` frontmatter. guard.cjs stays the global guard; these only narrow.
//   sous-guard.cjs path <root>...          Edit/Write/NotebookEdit: only under a root, never package.json, lockfiles, .github, .husky, .git,
//                                          .env*, CLAUDE.md, AGENTS.md, node_modules, secrets, or the generated blackboard files
//   sous-guard.cjs path --read <root>...   Read/Grep/Glob: only under a root, never a secret file
//   sous-guard.cjs bash <root>...          Bash for agents that only read: one simple command, read-only file commands under a root,
//                                          read-only git inside a worktree, read-only gh
//   sous-guard.cjs runner <root>...        Agent/Task: only sous-* agents and browser-verifier, plus a custom agent listed in kit/agents-allow.json
//                                          whose file has a fail-closed hooks block. Bash: what `bash` allows, plus the kit's
//                                          status, prep, worktree, stack and demo scripts
//   sous-guard.cjs verify <root>...        Bash for sous-verifier: [cd <root> &&] one test or type-check command (vitest, jest, tsc, eslint,
//                                          playwright, npm|pnpm|yarn test/run, node --test), read-only file commands and git; no installs,
//                                          dev servers, inline node code or network tools
//   sous-guard.cjs browser <root>...       Bash for browser-verifier: [cd <root> &&] [timeout <n>] playwright-cli to localhost or
//                                          127.0.0.1 only, the kit's status.cjs, paths.cjs, login-state.cjs and stack.sh, read-only file
//                                          commands, mkdir and ffmpeg/ffprobe under a root; no network tools, git, gh, kill, env, nested
//                                          shells, and no .env, .ssh, .claude or .config path
//   sous-guard.cjs video <root>...         Bash for sous-video: [cd <@video> &&] npm i|ci and npx remotion|tsc inside the ticket's video
//                                          folder, node on a script there or in the demo-video skill, python on the skill's scripts (with
//                                          ELEVENLABS_API_KEY="$(node K/el-rotate.cjs get)" as the only substitution), el-rotate.cjs park,
//                                          login-state.cjs, cp/rm into the folder, what `browser` allows for playwright-cli, mkdir and
//                                          ffmpeg/ffprobe inside the folder, read-only file commands; nothing else
//   sous-guard.cjs publish                 Bash for sous-publisher: git inside a worktree, add per path, commit -m, push of the current
//                                          feat|fix/<KEY>-... branch, gh pr create|list|view; never add -A or ., never develop/main/master.
//                                          gh pr create only on this machine's BE or FE repo, with a base from paths.cjs bases or the
//                                          ticket ledger's stackedOn branch for that repo
//   sous-guard.cjs jira [--record]         createJiraIssue / editJiraIssue for sous-jira: project QRD, label sous, content fields only, edits
//                                          only on tickets sous-jira created (the PostToolUse --record call keeps that list), label kept
// Roots: @wt (every <root>/wt-* worktree), @root, @evidence, @board (<evidence>/blackboard), @shots (<root>/<MMDD> screenshot folders),
// @config (only kit/, skills/, agents/ and rules/ of the config dir), @video (<root>/../qonflo-out/<MMDD>/<KEY>, a ticket's demo
// video folder), @skill (the demo-video skill: <root>/.claude/skills/demo-video or <config>/skills/demo-video). Values come from paths.cjs.
// Answers like guard.cjs: a deny JSON on stdout, nothing when allowed. A guard that cannot read its input denies.
// SOUS_GUARD_NOLOG=1 keeps a deny out of kit/guard.log (tests).
// Test: echo '{"tool_name":"Write","tool_input":{"file_path":"E:/qonflo/wt-1-be/package.json"}}' | node sous-guard.cjs path @wt
const fs = require("fs");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");

const PROTECTED = [/(^|\/)\.git(\/|$)/, /(^|\/)\.husky(\/|$)/, /(^|\/)\.github(\/|$)/, /(^|\/)\.claude(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.env[^/]*$/, /(^|\/)\.npmrc$/, /(^|\/)\.nvmrc$/, /(^|\/)package\.json$/, /(^|\/)package-lock\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)yarn\.lock$/, /(^|\/)CLAUDE\.md$/i, /(^|\/)AGENTS\.md$/i];
const SECRETS = [/(^|\/)\.env(?!\.example$)[^/]*$/, /(^|\/)\.npmrc$/, /(^|\/)\.ssh(\/|$)/, /(^|\/)id_[^/]*$/, /(^|\/)\.credentials\.json$/, /(^|\/)\.git-credentials$/, /\.pem$/, /\.key$/, /(^|\/)secrets?\.(env|local\.json)$/, /(^|\/)\.netrc$/, /(^|\/)dock(-chat)?\.json$/, /(^|\/)elevenlabs-keys\.json$/];
const GENERATED = /^[^/]+\/((tickets\/[^/]+\/)?(status|decisions|issues|NOW)|EPIC)\.md$/i;
const AGENTS = new Set(["sous-intake", "sous-planner","sous-ticket-worker", "sous-reviewer", "sous-verifier", "sous-arbiter", "sous-publisher", "sous-analyst", "sous-pr-reviewer", "sous-explorer", "sous-jira", "sous-video", "browser-verifier"]);
const READ_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "du", "diff", "read", "tree"]);
const FIND_DENY = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-L", "-follow"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "merge-base", "ls-files", "blame"]);
const GH_READ = new Set(["pr list", "pr view", "pr diff", "pr checks", "pr status", "run list", "run view", "repo view"]);
const TEST_TOOLS = new Set(["vitest", "jest", "tsc", "eslint", "playwright"]);
const PKG_DENY = /^(i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|ln|publish|exec|dlx|x|create|init|dev|start|serve|preview|watch|deploy)(:|$)/;
const KIT_NODE = new Set(["status.cjs", "demo-upload.cjs", "paths.cjs", "doctor.cjs", "login-state.cjs"]);
const KIT_BASH = { "prep-ticket.sh": null, "stack.sh": new Set(["status", "up", "down"]), "wt.sh": new Set(["add", "check"]) };
const PROTECTED_BRANCHES = new Set(["develop", "development", "main", "master"]);
const BRANCH = /^(feat|fix)\/[A-Z][A-Z0-9]*-\d+(-[A-Za-z0-9._-]+)?$/;
const JIRA_PROJECT = "QRD";
const JIRA_LABEL = "sous";
const JIRA_EDIT_FIELDS = new Set(["summary", "description", "priority", "labels", "components", "duedate"]);
const SPRINT = /sprint|^QRD\d+$/i;
const CONFIG_READ = ["kit", "skills", "agents", "rules"];
const BROWSER_DENY = new Set(["git", "gh", "curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "mongosh", "mongo", "redis-cli", "kill", "pkill", "killall", "sudo", "chmod", "chown", "printenv", "env", "eval", "sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"]);
const BROWSER_KIT = new Set(["status.cjs", "paths.cjs", "login-state.cjs", "stack.sh"]);
const PROTECTED_TEXT = /(^|[\\/=])\.(env|ssh|claude|bashrc|profile|config)([^A-Za-z0-9]|$)/i;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i;
const VIDEO_DELEGATE = new Set(["playwright-cli", "ffmpeg", "ffprobe", "mkdir"]);
const VIDEO_ENV = /^(NO_COLOR|FORCE_COLOR|CI|npm_config_cache|DEMO_FE|DEMO_API|DEMO_PASSWORD_FILE)=/;
const EL_KEY = /^ELEVENLABS_API_KEY="\$\(node ([^\s"'$`()]+) get\)" +/;

function createSousGuard({ platform = process.platform, paths = resolvePaths(), cwd = process.cwd(), ledgerFile = path.join(__dirname, "sous-jira-created.log"), allowFile = path.join(paths.kitDir, "agents-allow.json") } = {}) {
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
	const named = { "@root": root, "@evidence": norm(paths.evidence), "@board": norm(`${paths.evidence}/blackboard`) };
	const configRoots = [...new Set([norm(paths.kitDir), ...CONFIG_READ.map((d) => norm(`${paths.configDir}/${d}`))])];
	const board = named["@board"];
	const kit = norm(paths.kitDir);
	const videoBase = norm(`${paths.root}/../qonflo-out`);
	const skillRoots = [...new Set([norm(`${paths.root}/.claude/skills/demo-video`), norm(`${paths.configDir}/skills/demo-video`)])];
	const inside = (p, r) => p === r || p.startsWith(r + "/");
	// The root a path falls under, or null. @wt is the worktree folder itself: <root>/wt-<name>.
	const rootOf = (p, roots) => {
		for (const r of roots) {
			if (r === "@wt" || r === "@shots") {
				const m = inside(p, root) ? p.slice(root.length + 1).split("/")[0] : "";
				if (r === "@wt" ? /^wt-[^/]+$/.test(m) : /^\d{4}$/.test(m)) return `${root}/${m}`;
			} else if (r === "@config" || r === "@skill") {
				const c = (r === "@config" ? configRoots : skillRoots).find((x) => inside(p, x));
				if (c) return c;
			} else if (r === "@video") {
				const [day, key] = inside(p, videoBase) ? p.slice(videoBase.length + 1).split("/") : [];
				if (/^\d{4}$/.test(day || "") && /^[A-Z][A-Z0-9]*-\d+$/i.test(key || "")) return `${videoBase}/${day}/${key}`;
			} else if (named[r] && inside(p, named[r])) return named[r];
			else if (!named[r] && !r.startsWith("@") && inside(p, norm(r))) return norm(r);
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

	// Flags that turn a read command into one that runs a program, writes a file or follows links out of a root.
	function readFlags(cmd, args) {
		const short = (a, c) => /^-[A-Za-z0-9]+$/.test(a) && a.includes(c);
		let bad;
		if (cmd === "find" && (bad = args.find((a) => FIND_DENY.has(a)))) return `find ${bad}: -exec, -delete, -fprint, -L and the like are not allowed`;
		if (cmd === "rg" && (bad = args.find((a) => /^--(pre|pre-glob|search-zip)(=|$)/.test(a) || short(a, "z")))) return `rg ${bad} is not allowed: it runs a program on the files`;
		if (cmd === "tree" && (bad = args.find((a) => short(a, "o") || /^--output(=|$)/.test(a)))) return `tree ${bad} is not allowed: it writes a file`;
		if (cmd === "grep" && (bad = args.find((a) => short(a, "R") || a === "--dereference-recursive"))) return `grep ${bad} is not allowed: it follows links; use -r`;
		return null;
	}

	function checkRead(w, roots) {
		const [cmd, ...args] = w;
		const flag = readFlags(cmd, args);
		if (flag) return flag;
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
			if ((kitNode ? file : base) === "status.cjs" && sub === "set" && w.slice(4).some((a) => /^rounds\./.test(a) || /^draft=(?!true$)/.test(a))) return "rounds.max and draft=false are the owner's to set, not an agent's";
			if (kitNode ? KIT_NODE.has(file) : own && KIT_NODE.has(base)) return null;
			return "node only runs the kit's status.cjs, demo-upload.cjs, paths.cjs, doctor.cjs and login-state.cjs";
		}
		if (prog === "bash" && own && Object.hasOwn(KIT_BASH, base)) {
			const allowed = KIT_BASH[base];
			return !allowed || allowed.has(sub) ? null : `${base} ${sub ?? ""} is not for an agent`;
		}
		return "";
	}

	function checkGitRm(w) {
		if (w[1] !== "-C" || !w[2]) return "git runs as git -C <worktree> <subcommand>";
		const wt = rootOf(norm(w[2]), ["@wt"]);
		if (!wt) return `git rm only inside a ticket worktree (${paths.root}/wt-*), not ${w[2]}`;
		const args = w.slice(4);
		const files = args[0] === "--" ? args.slice(1) : args;
		if (!files.length) return "git rm needs the files to delete";
		if (files.some((a) => a.startsWith("-") || a === "." || a === "*" || a === ":/" || /[*?[\]]/.test(a))) return "git rm deletes named files only: no flags, no . and no globs";
		if (files.some((a) => norm(a, w[2]) === wt || !inside(norm(a, w[2]), wt))) return "git rm only deletes files inside the ticket worktree";
		return null;
	}

	function checkBash(cmd, roots, runner) {
		const bad = simple(cmd);
		if (bad) return bad;
		const w = words(cmd);
		if (!w.length) return "empty command";
		if (w[0] === "git") return runner && w[3] === "rm" ? checkGitRm(w) : checkGitRead(w, roots);
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
		if (READ_CMDS.has(prog)) return readFlags(prog, args);
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

	// browser-verifier: the browser on this machine's own servers, the kit's ledger and login scripts, reads, and the video encode.
	function checkBrowser(cmd, roots) {
		let rest = cmd;
		let here = cwd;
		const cd = /^\s*cd\s+("[^"$`]*"|'[^']*'|[^\s;&|<>()`$]+)\s*&&\s*/.exec(cmd);
		if (cd) {
			here = split(cd[1])[0];
			if (!rootOf(norm(here), roots)) return `cd only into the folders this agent may use (${roots.join(", ")})`;
			rest = cmd.slice(cd[0].length);
		}
		const bad = simple(rest);
		if (bad) return bad;
		const w = words(rest);
		if (w[0] === "timeout" && /^\d+[smh]?$/.test(w[1] || "")) w.splice(0, 2);
		while (w[0] === "rtk" || w[0] === "proxy") w.shift();
		if (!w.length) return "empty command";
		const prog = fwd(w[0]).split("/").pop();
		if (BROWSER_DENY.has(prog) && !(prog === "bash" && w[1])) return `${prog} is not allowed for the browser verifier`;
		for (const a of w) {
			const v = /^-[^=]*=/.test(a) || /^[A-Za-z_.]+=/.test(a) ? a.slice(a.indexOf("=") + 1) : a;
			if (PROTECTED_TEXT.test(v) && !(/[\\/]/.test(v) && inside(norm(v), kit))) return `${v} touches a protected path (.env, .ssh, .claude, .config)`;
		}
		if (prog === "playwright-cli") {
			const pos = w.slice(1).filter((a) => !a.startsWith("-"));
			const url = w.join(" ").match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g)?.find((u) => !LOCAL_URL.test(u)) || (/^(open|goto|tab-new)$/.test(pos[0] || "") && pos[1] && !LOCAL_URL.test(pos[1]) ? pos[1] : "");
			return url ? `playwright-cli only opens localhost or 127.0.0.1, not ${url}` : null;
		}
		if (prog === "node" || prog === "kit-node" || prog === "bash") {
			const k = checkKit(w);
			const file = prog === "kit-node" ? w[1] : fwd(w[1] || "").split("/").pop();
			return k === null && BROWSER_KIT.has(file) ? null : `${prog} only runs the kit's ${[...BROWSER_KIT].join(", ")}${k ? ` (${k})` : ""}`;
		}
		if (READ_CMDS.has(prog)) return checkRead(w, roots);
		if (prog === "mkdir" || prog === "ffmpeg" || prog === "ffprobe") {
			const args = w.slice(1);
			if (prog === "mkdir" && args.some((a) => a.startsWith("-") && a !== "-p")) return "mkdir takes -p and folders only";
			const remote = args.find((a) => /^[A-Za-z][A-Za-z0-9+.-]+:/.test(a));
			if (remote) return `${prog}: ${remote} is not a local file`;
			const out = args.find((a) => !a.startsWith("-") && (prog === "mkdir" || /[\\/]|\.[A-Za-z0-9]{2,5}$/.test(a)) && !rootOf(norm(a, here), roots));
			if (out) return `${prog}: ${out} is outside the folders this agent may use`;
			return prog === "mkdir" && !args.some((a) => !a.startsWith("-")) ? "mkdir needs a folder" : null;
		}
		return `${prog} is not allowed for the browser verifier: playwright-cli, the kit's ledger, login and stack scripts, read-only file commands, mkdir and ffmpeg`;
	}

	// sous-video: the demo-video skill's pipeline inside one ticket's video folder (@video). Writes land only there.
	function checkVideo(cmd, roots) {
		let rest = cmd;
		let here = cwd;
		const cd = /^\s*cd\s+("[^"$`]*"|'[^']*'|[^\s;&|<>()`$]+)\s*&&\s*/.exec(cmd);
		if (cd) {
			here = split(cd[1])[0];
			if (!rootOf(norm(here), ["@video"])) return `cd only into the ticket's video folder (${paths.root}/../qonflo-out/<MMDD>/<KEY>)`;
			rest = cmd.slice(cd[0].length);
		}
		const el = EL_KEY.exec(rest);
		if (el) {
			if (norm(el[1], here) !== `${kit}/el-rotate.cjs`) return "ELEVENLABS_API_KEY only comes from the kit's el-rotate.cjs get";
			rest = rest.slice(el[0].length);
		}
		const bad = simple(rest);
		if (bad) return bad;
		const w = words(rest);
		if (w[0] === "timeout" && /^\d+[smh]?$/.test(w[1] || "")) w.splice(0, 2);
		while (w[0] === "rtk" || w[0] === "proxy") w.shift();
		const envs = [];
		while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) envs.push(w.shift());
		if (!w.length) return "empty command";
		const prog = fwd(w[0]).split("/").pop();
		const args = w.slice(1);
		const pathy = (v) => /[\\/]/.test(v) || /^~/.test(v);
		const under = (v, rs) => rootOf(norm(v, here), rs);
		const skillScript = (f) => skillRoots.some((r) => inside(f, `${r}/scripts`));
		const outside = (list, rs) => list.find((a) => {
			const v = a.startsWith("-") ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "") : a;
			return v && (pathy(v) || fs.existsSync(P.resolve(fwd(here), v))) && (!under(v, rs) || secret(norm(v, here)));
		});
		if (BROWSER_DENY.has(prog)) return `${prog} is not allowed for sous-video`;
		for (const a of [...envs, ...w]) {
			const v = /^-[^=]*=/.test(a) || /^[A-Za-z_.]+=/.test(a) ? a.slice(a.indexOf("=") + 1) : a;
			if (PROTECTED_TEXT.test(v) && !(pathy(v) && (inside(norm(v, here), kit) || under(v, ["@skill"])))) return `${v} touches a protected path (.env, .ssh, .claude, .config)`;
		}
		for (const e of envs) {
			const name = e.slice(0, e.indexOf("="));
			const v = e.slice(e.indexOf("=") + 1);
			if (!VIDEO_ENV.test(e)) return `${name}= is not allowed here`;
			if (/^DEMO_(FE|API)$/.test(name) && !LOCAL_URL.test(v)) return `${name} must be a localhost or 127.0.0.1 URL`;
			if (name === "npm_config_cache" && !under(v, ["@video"])) return "npm_config_cache goes inside the video folder";
		}
		const py = /^(python3?|py)$/.test(prog);
		if (el && !py) return "ELEVENLABS_API_KEY goes only to the skill's tts.py and align.py";
		if (VIDEO_DELEGATE.has(prog)) return envs.length || el ? `${prog} takes no variables here` : checkBrowser(cmd, ["@video"]);
		if (READ_CMDS.has(prog)) return envs.length ? `${prog} takes no variables here` : checkRead(w, roots);
		if (prog === "node") {
			const [file, sub, ...more] = args;
			if (!file || file.startsWith("-")) return "node runs a script file only: no flags, inline code or preloads";
			const f = norm(file, here);
			if (f === `${kit}/el-rotate.cjs`) {
				if (sub === "park" && more.length <= 1 && more.every((a) => /^\d+$/.test(a))) return null;
				return sub === "get" ? `el-rotate.cjs get prints the key: use it only as ELEVENLABS_API_KEY="$(node ${paths.kitDir}/el-rotate.cjs get)" python <skill script>` : "el-rotate.cjs: only get (inside ELEVENLABS_API_KEY=...) and park";
			}
			if (f === `${kit}/login-state.cjs`) return /^\d+$/.test(sub || "") && !more.length ? null : "login-state.cjs takes the FE port only";
			if (!/\.[cm]?js$/.test(f) || !(rootOf(f, ["@video"]) || skillScript(f))) return `node runs scripts inside the video folder or the demo-video skill's scripts only, not ${file}`;
			const o = outside(args.slice(1), ["@video"]);
			return o ? `node: ${o} is outside the video folder` : null;
		}
		if (py) {
			const [file] = args;
			if (!file || file.startsWith("-") || !/\.py$/i.test(file) || !skillScript(norm(file, here))) return "python runs the demo-video skill's scripts only, with no flag before the script";
			if (el && !/\/(tts|align)\.py$/.test(norm(file, here))) return "ELEVENLABS_API_KEY goes only to the skill's tts.py and align.py";
			const o = outside(args.slice(1), ["@video"]);
			return o ? `python: ${o} is outside the video folder` : null;
		}
		if (prog === "npm" || prog === "npx") {
			if (!rootOf(norm(here), ["@video"])) return `${prog} runs inside the video folder only: cd <video folder> && ${prog} ...`;
			if (prog === "npm") {
				const pos = args.filter((a) => !a.startsWith("-"));
				if (!/^(i|install|ci)$/.test(pos[0] || "") || pos.length > 1) return "npm: only npm i or npm ci of the copied template, no package named";
				const flag = args.find((a) => a.startsWith("-") && !/^--(no-audit|no-fund|prefer-offline|silent)$/.test(a));
				return flag ? `npm ${flag} is not allowed` : null;
			}
			if (!(args[0] === "tsc" || (args[0] === "remotion" && /^(render|still|compositions)$/.test(args[1] || "")))) return "npx runs only remotion render|still|compositions and tsc of the installed template, without installing a package";
			const o = outside(args.slice(1), ["@video"]);
			return o ? `npx: ${o} is outside the video folder` : null;
		}
		if (prog === "cp" || prog === "rm") {
			if (envs.length) return `${prog} takes no variables here`;
			const flags = args.filter((a) => a.startsWith("-"));
			const files = args.filter((a) => !a.startsWith("-"));
			if (flags.some((f) => !(prog === "cp" ? /^-[rRfp]+$/ : /^-[rRf]+$/).test(f))) return `${prog} takes ${prog === "cp" ? "-r -f -p" : "-r -f"} only`;
			if (!files.length || (prog === "cp" && files.length < 2)) return `${prog} needs its paths`;
			const writes = prog === "cp" ? [files.pop()] : files;
			const out = writes.find((f) => !under(f, ["@video"]));
			if (out) return `${prog}: ${out} is outside the video folder`;
			const src = files.find((f) => !under(f, roots) || secret(norm(f, here)));
			return prog === "cp" && src ? `cp: ${src} is outside the folders this agent may read` : null;
		}
		return `${prog} is not allowed for sous-video: npm i|ci and npx remotion|tsc in the video folder, node and python on the skill's scripts, el-rotate.cjs park, login-state.cjs, cp/rm into the folder, playwright-cli, mkdir, ffmpeg, ffprobe and read-only file commands`;
	}

	// The GitHub owner/name of this machine's BE and FE repos: paths.cjs `github`, else the origin remote of each repo folder.
	let ghRepos;
	const repoNames = () => {
		if (ghRepos) return ghRepos;
		ghRepos = {};
		for (const side of ["be", "fe"]) {
			let name = paths.github?.[side] || "";
			if (!name && paths.repos?.[side]) {
				try {
					const url = require("child_process").execFileSync("git", ["-C", paths.repos[side], "remote", "get-url", "origin"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
					name = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url)?.[1] || "";
				} catch {}
			}
			if (name) ghRepos[side] = name;
		}
		return ghRepos;
	};

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
			if (sub === "rm") return checkGitRm(w);
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
			const repos = repoNames();
			const side = Object.keys(repos).find((k) => repos[k].toLowerCase() === f["--repo"].toLowerCase());
			if (!side) return `repo ${f["--repo"]} is not this machine's BE or FE repo (${Object.values(repos).join(", ") || "none found"})`;
			const bases = paths.bases || ["develop"];
			const key = f["--head"].split("/")[1].match(/^[A-Z][A-Z0-9]*-\d+/)[0];
			let stacked = "";
			try { stacked = JSON.parse(fs.readFileSync(`${paths.evidence}/${key}/status.json`, "utf8")).stackedOn?.[side]?.branch || ""; } catch {}
			if (!bases.includes(f["--base"]) && f["--base"] !== stacked) return `base ${f["--base"]} is not a configured base (${bases.join(", ")})${stacked ? ` or the stack parent's branch ${stacked}` : ""}`;
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
			if (!Array.isArray(extra.labels) || !extra.labels.includes(JIRA_LABEL)) return `additional_fields.labels must include "${JIRA_LABEL}"`;
			if (extra.labels.some((l) => SPRINT.test(String(l)))) return "no sprint labels";
			if (ti.parent && !created().has(String(ti.parent))) return `parent ${ti.parent} was not created by sous-jira`;
			return null;
		}
		if (/editJiraIssue$/.test(tool)) {
			const key = String(ti.issueIdOrKey || "");
			if (!created().has(key)) return `${key} was not created by sous-jira; only those can be edited`;
			const bad = Object.keys(ti.fields || {}).filter((k) => !JIRA_EDIT_FIELDS.has(k));
			if (bad.length) return `fields not allowed: ${bad.join(", ")} (allowed: ${[...JIRA_EDIT_FIELDS].join(", ")})`;
			if (ti.fields && "labels" in ti.fields && (!Array.isArray(ti.fields.labels) || !ti.fields.labels.includes(JIRA_LABEL))) return `labels must keep "${JIRA_LABEL}"`;
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

	// A custom agent from DOCK's library (kit/agents.cjs) is dispatchable when listed in agents-allow.json and its file carries a hooks block
	// whose every command runs sous-guard.cjs and fails closed.
	function customAllowed(slug) {
		if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug) || slug.startsWith("sous-")) return false;
		let allow, text;
		try { allow = JSON.parse(fs.readFileSync(allowFile, "utf8")); text = fs.readFileSync(path.join(paths.configDir, "agents", `${slug}.md`), "utf8").replace(/\r\n/g, "\n"); } catch { return false; }
		if (!Array.isArray(allow) || !allow.includes(slug)) return false;
		const head = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text);
		const lines = head ? head[1].split("\n") : [];
		const at = lines.indexOf("hooks:");
		if (at < 0) return false;
		const block = [];
		for (const l of lines.slice(at + 1)) { if (!/^\s/.test(l)) break; block.push(l); }
		const commands = block.filter((l) => /^\s+command:/.test(l));
		return commands.length > 0 && commands.every((l) => l.includes(" sous-guard.cjs ") && /\|\| exit 2'$/.test(l.trim()));
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
			// A DOCK turn ends when the runner's caller answers, and that kills whatever still runs in the background.
			if (ti.run_in_background === true) return "no background agents or commands: wait for each one, a DOCK turn that ends kills what still runs";
			if (tool === "Agent" || tool === "Task") return AGENTS.has(ti.subagent_type) || customAllowed(ti.subagent_type) ? null : `subagent type not allowed: ${ti.subagent_type || "(none)"}; a runner calls sous-* agents, browser-verifier and the guarded custom agents of kit/agents-allow.json only`;
			return tool === "Bash" ? checkBash(String(ti.command || ""), roots, true) : null;
		}
		if (mode === "verify") return tool === "Bash" ? checkVerify(String(ti.command || ""), roots) : null;
		if (mode === "browser") return tool === "Bash" ? checkBrowser(String(ti.command || ""), roots) : null;
		if (mode === "video") return tool === "Bash" ? checkVideo(String(ti.command || ""), roots) : null;
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
	module.exports = { createSousGuard, deny, AGENTS };
}
