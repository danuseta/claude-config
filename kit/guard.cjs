// PreToolUse guard for shell commands in the Qonflo workspace. Reads the hook payload on stdin and answers deny, warn or nothing.
// Limits that used to be sentences in a skill are enforced here, for the lead and for every subagent.
//   deny  git worktree remove with --force, or on a folder whose node_modules is a junction   -> kit/wt.sh unlink, then wt.sh remove
//   deny  recursive delete of a wt-* folder or of its node_modules                            -> kit/wt.sh remove
//   soft  git add . / -A / --all                                                               -> stage per path
//   soft  git push to develop, development, main or master                                     -> push the working branch, merge through a PR
//   soft  a kill command that names port 3000, 3001 or 5173 (the list comes from paths.cjs)     -> kit/stack.sh down <ticket ports>
//   soft  force push, branch delete, gh pr merge/close, gh repo/release delete, git reset --hard / clean / checkout . / restore .
//         in a main clone, recursive delete of home, the projects root, a repo or ~/.claude ~/claude-config ~/brain ~/.config,
//         database drops and flushes, sudo / coder / tailscale / ccfg, ~/.config/claude-config
// A soft rule warns until guard.json's "softUntil" date and denies from that day on. It matches command text, so it closes the
// usual path, not every path: `taskkill /PID <n>` names no port and stays stack.sh's job.
// DOCK_CHAT_TURN=1 (set by dock-chat.cjs for an unattended chat turn) makes every soft rule a deny at once, ignores softUntil, and
// applies the rules in any folder, not only inside the workspace root.
// Test: echo '{"tool_name":"Bash","cwd":"E:/qonflo","tool_input":{"command":"git add ."}}' | node guard.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");

const WORKSPACE = /(^|[\s"'=(])(?:[eE]:[\\/]+|\/[eE]\/)qonflo\b/;
const PROTECTED = ["develop", "development", "main", "master"];
const WRAPPERS = new Set(["rtk", "proxy", "env", "nohup", "time", "exec", "command", "setsid", "xargs", "builtin"]);
const MACHINE_CONTROL = new Set(["sudo", "coder", "tailscale", "ccfg"]);

const config = () => {
	try { return JSON.parse(fs.readFileSync(path.join(__dirname, "guard.json"), "utf8")); } catch { return {}; }
};
const unquote = (t) => t.replace(/^["']|["']$/g, "");
const words = (segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const EVALS = new Set(["eval", "iex", "invoke-expression"]);
const NOISE = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const GIT_BUILTIN = new Set("add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref format-patch fsck gc gitk grep gui hash-object help init interpret-trailers log ls-files ls-remote ls-tree maintenance mailinfo merge merge-base merge-file merge-tree mergetool mktree mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-objects update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs".split(" "));
const DANGER_CFG = /^(remote\..+\.(push|pushurl|url)|url\..+\.(insteadof|pushinsteadof)|push\.default|branch\..+\.(merge|remote)|core\.(sshcommand|hookspath)|credential\.(.+\.)?helper)$/i;
const CONFIG_READ = /^(--get|--get-all|--get-regexp|--get-urlmatch|--unset|--unset-all|--list|-l|--edit|-e|--remove-section|--rename-section)$/;
const CONFIG_VALUE_FLAGS = /^(--file|-f|--blob|--type|--default)$/;
const PUSH_SHAPED = /(^|[\s;&|!])(git\s+)?(push|send-pack)(\s|$)|(^|[\s;&|!])(git\s+)?branch\s+.*(\s-[a-zA-Z]*[dD]|--delete)/;
const NET_TOOLS = new Set(["curl", "wget", "invoke-restmethod", "invoke-webrequest", "iwr", "irm", "http", "https"]);
const GH_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]*@)?(api\.github\.com|github\.com)(?::\d+)?(\/.*)?$/i;
const GH_WRITE_PATH = [/\/pulls\/[^/?]+\/merge(\/|\?|$)/, /\/git\/refs(\/|\?|$)/, /\/branches\/.+\/protection(\/|\?|$)/, /\/merges(\/|\?|$)/, /\/graphql(\/|\?|$)/, /\/git-receive-pack(\/|\?|$)/, /\/dispatches(\/|\?|$)/];
const GH_ALIAS_BAD = /\b(pr\s+(merge|close)|repo\s+delete|release\s+delete|workflow\s+run)\b|\bgit\s+push\b|mergePullRequest|(-X|--method)[\s=]*(DELETE|PUT)/;
const WRITE_METHOD = /^(PUT|POST|PATCH|DELETE)$/i;
const MAX_DEPTH = 6;
const MAX_UNITS = 300;
const baseName = (t) => String(t).split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();

// The index of the parenthesis closing the one at `open`, or -1. Quotes and nesting are respected.
function matchParen(s, open) {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") i++;
		else if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return -1; i = j; }
		else if (c === '"') { for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++; }
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}

// Scripts a simple command hands to another interpreter: bash -c, eval, powershell -Command, cmd /c, here-strings.
function nestedScripts(ws) {
	const t = ws.map((w) => w.t);
	const found = [];
	const take = (at, join, ps) => {
		const parts = ws.slice(at);
		if (!parts.length) return;
		found.push({ code: join ? parts.map((w) => w.t).join(" ") : parts[0].t, ps, dyn: parts.some((w) => w.dyn) });
	};
	for (let k = 0; k < t.length; k++) {
		const b = baseName(t[k]);
		if (SHELLS.has(b)) { for (let m = k + 1; m < t.length; m++) if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t[m])) { take(m + 1, false, false); break; } }
		else if (EVALS.has(b)) take(k + 1, true, b !== "eval");
		else if (POWERSHELLS.has(b)) {
			for (let m = k + 1; m < t.length; m++) {
				if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(t[m])) { take(m + 1, true, true); break; }
				if (/^-e(c|nc|ncodedcommand)?$/i.test(t[m]) && t[m + 1]) {
					let code = "";
					try { code = Buffer.from(t[m + 1], "base64").toString("utf16le"); } catch {}
					found.push({ code, ps: true, dyn: !code });
					break;
				}
			}
		} else if (b === "cmd") { for (let m = k + 1; m < t.length; m++) if (/^\/[ck]$/i.test(t[m])) { take(m + 1, true, false); break; } }
		else if (t[k] === "<<<") take(k + 1, false, false);
	}
	return found;
}

// Reads a command line into simple commands: quotes and escapes removed, subshells, $( ), backticks and nested shells followed.
// out.units are { text, words, dyn, alt, depth }; words hold the shell's reading of the text, alt the same with backslashes kept
// (a Windows path), dyn marks the words that expand at run time. out.unresolved is set when a part cannot be read.
function parseShell(script, out, rec = 0, ps = false, lvl = 0) {
	if (rec > MAX_DEPTH || out.units.length > MAX_UNITS) { out.unresolved = true; return; }
	const n = script.length;
	let i = 0, start = -1, groups = 0, words = [], cur = null, nested = [];
	const open = () => { if (!cur && !words.length && start < 0) start = i; return cur || (cur = { t: "", lit: "", dyn: false, esc: false }); };
	const add = (c, lit = c) => { const w = open(); w.t += c; w.lit += lit; };
	const endWord = () => { if (cur) { words.push(cur); cur = null; } };
	const endCmd = (end) => {
		endWord();
		let ws = words;
		const text = start < 0 ? "" : script.slice(start, end).trim();
		const subs = nested;
		words = []; nested = []; start = -1;
		while (ws.length && NOISE.has(ws[0].t) && !ws[0].dyn) ws = ws.slice(1);
		if (!ws.length) { for (const code of subs) parseShell(code, out, rec + 1, ps, lvl + groups + 1); return; }
		const unit = { text, words: ws.map((w) => w.t), dyn: ws.map((w) => w.dyn), alt: ws.some((w) => w.esc && w.lit !== w.t) ? ws.map((w) => w.lit) : null, depth: lvl + groups };
		out.units.push(unit);
		for (const code of subs) parseShell(code, out, rec + 1, ps, lvl + groups + 1);
		for (const s of nestedScripts(ws)) {
			if (s.dyn && !s.code.trim()) out.unresolved = true;
			else parseShell(s.code, out, rec + 1, s.ps, lvl + groups + 1);
		}
	};
	const expand = (w, quoted) => {
		const c2 = script[i + 1];
		if (c2 === "(") {
			const j = matchParen(script, i + 1);
			if (j < 0) { out.unresolved = true; w.t += script.slice(i); w.lit += script.slice(i); w.dyn = true; i = n; return; }
			if (script[i + 2] !== "(") nested.push(script.slice(i + 2, j));
			w.dyn = true; w.t += script.slice(i, j + 1); w.lit += script.slice(i, j + 1); i = j + 1;
		} else if (c2 === "{") {
			const j = script.indexOf("}", i);
			const to = j < 0 ? n : j + 1;
			w.dyn = true; w.t += script.slice(i, to); w.lit += script.slice(i, to); i = to;
		} else if (!quoted && c2 === "'") {
			let j = i + 2;
			while (j < n && script[j] !== "'") j += script[j] === "\\" ? 2 : 1;
			w.dyn = true; w.t += script.slice(i, j + 1); w.lit += script.slice(i, j + 1); i = j + 1;
		} else if (c2 !== undefined && /[A-Za-z_@*#?!$0-9-]/.test(c2)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_]/.test(script[j])) j++;
			if (j === i + 1) j++;
			w.dyn = true; w.t += script.slice(i, j); w.lit += script.slice(i, j); i = j;
		} else { w.t += "$"; w.lit += "$"; i++; }
	};
	const tick = (w) => {
		let j = i + 1;
		while (j < n && script[j] !== "`") j += script[j] === "\\" ? 2 : 1;
		if (j >= n) { out.unresolved = true; nested.push(script.slice(i + 1)); w.dyn = true; w.t += script.slice(i); w.lit += script.slice(i); i = n; return; }
		nested.push(script.slice(i + 1, j));
		w.dyn = true; w.t += script.slice(i, j + 1); w.lit += script.slice(i, j + 1); i = j + 1;
	};
	while (i < n) {
		const c = script[i];
		if (c === " " || c === "\t" || c === "\r") { endWord(); i++; }
		else if (c === "\n") { endCmd(i); i++; }
		else if (c === "#" && !cur) { while (i < n && script[i] !== "\n") i++; }
		else if (c === ";") { endCmd(i); i++; }
		else if (c === "(") { endCmd(i); groups++; i++; }
		else if (c === ")") { endCmd(i); if (groups > 0) groups--; i++; }
		else if (c === "|") { endCmd(i); i += script[i + 1] === "|" ? 2 : 1; }
		else if (c === "&") {
			const joined = script[i - 1] === ">" || script[i - 1] === "<" || script[i + 1] === ">";
			if (joined) { add(c); i++; } else { endCmd(i); i += script[i + 1] === "&" ? 2 : 1; }
		}
		else if ((c === "<" || c === ">") && script[i + 1] === "(") {
			const j = matchParen(script, i + 1);
			if (j < 0) { out.unresolved = true; i = n; } else { nested.push(script.slice(i + 2, j)); open().dyn = true; i = j + 1; }
		}
		else if (c === "\\" && !ps) {
			const d = script[i + 1];
			if (d === undefined) { add("\\"); i++; }
			else if (d === "\n") i += 2;
			else if (d === "\r" && script[i + 2] === "\n") i += 3;
			else if (/[A-Za-z0-9_.-]/.test(d)) { const w = open(); w.t += d; w.lit += `\\${d}`; w.esc = true; i += 2; }
			else { add(d); i += 2; }
		}
		else if (c === "`" && ps) { const d = script[i + 1]; if (d === undefined) { add("`"); i++; } else { add(d); i += 2; } }
		else if (c === "`") tick(open());
		else if (c === "'") {
			const w = open();
			i++;
			for (;;) {
				const j = script.indexOf("'", i);
				if (j < 0) { out.unresolved = true; w.t += script.slice(i); w.lit += script.slice(i); i = n; break; }
				w.t += script.slice(i, j); w.lit += script.slice(i, j); i = j + 1;
				if (ps && script[i] === "'") { w.t += "'"; w.lit += "'"; i++; continue; }
				break;
			}
		}
		else if (c === '"') {
			const w = open();
			i++;
			let closed = false;
			while (i < n) {
				const d = script[i];
				if (d === '"') { if (ps && script[i + 1] === '"') { add('"'); i += 2; continue; } closed = true; i++; break; }
				if (d === "\\" && !ps) {
					const e = script[i + 1];
					if (e === "\n") i += 2;
					else if (e !== undefined && '$`"\\'.includes(e)) { add(e); i += 2; }
					else { add("\\"); i++; }
				}
				else if (d === "`" && ps) { const e = script[i + 1]; if (e === undefined) { add("`"); i++; } else { add(e); i += 2; } }
				else if (d === "$") expand(w, true);
				else if (d === "`") tick(w);
				else { add(d); i++; }
			}
			if (!closed) out.unresolved = true;
		}
		else if (c === "$") expand(open(), false);
		else if (c === "{" && /^\{[^\s{}]*(,|\.\.)[^\s{}]*\}/.test(script.slice(i))) { const w = open(); const j = script.indexOf("}", i); w.dyn = true; w.t += script.slice(i, j + 1); w.lit += script.slice(i, j + 1); i = j + 1; }
		else { add(c); i++; }
	}
	endCmd(n);
}

function parseCommand(command) {
	const out = { units: [], unresolved: false };
	parseShell(String(command), out);
	return out;
}

const isJunction = (dir) => {
	try { return fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink(); } catch { return false; }
};
const currentBranch = (dir) => {
	try {
		return require("child_process").execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
	} catch { return null; }
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// platform, paths, env and home are inputs so the Linux rules can be exercised on Windows and the other way round.
function createGuard({ platform = process.platform, paths = resolvePaths(), env = process.env, home = os.homedir() } = {}) {
	const win = platform === "win32";
	const P = win ? path.win32 : path.posix;
	const PORTS = paths.protectedPorts;
	const KIT = String(paths.kitDir).replace(/\\/g, "/");
	const ROOT = String(paths.root).replace(/\\/g, "/").replace(/\/+$/, "");
	const ROOT_RE = new RegExp(`(^|[\\s"'=(])${escapeRe(ROOT)}\\b`);
	const inWorkspace = (s) => WORKSPACE.test(s) || ROOT_RE.test(s);
	const toWin = win ? (p) => p.replace(/^\/([a-zA-Z])\//, "$1:/").replace(/\\/g, "/") : (p) => p;
	const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
	// A glob counts: the shell expands wt-* after this hook has answered.
	const isWorktreeName = (p) => /^wt-[\w.*?-]+$/i.test(P.basename(p));
	// A worktree folder itself, or the node_modules directly inside one. A deeper path such as wt-1/dist is ordinary cleanup.
	const isWorktreeTarget = (x) => {
		const p = toWin(x).replace(/\/+$/, "");
		if (/\.[a-z]{2,5}$/i.test(p)) return false;
		return isWorktreeName(p) || (/^node_modules$/i.test(P.basename(p)) && isWorktreeName(P.dirname(p)));
	};
	const underRoot = (dir) => {
		const d = toWin(dir).replace(/\/+$/, "");
		return same(d, ROOT) || (d.length > ROOT.length && same(d.slice(0, ROOT.length + 1), `${ROOT}/`));
	};
	const inWorktree = (dir) => toWin(dir).split("/").some((seg) => /^wt-[\w.-]+$/i.test(seg));
	const homeDir = toWin(home).replace(/\/+$/, "");
	const keep = [P.resolve("/"), homeDir, ROOT, `${homeDir}/.claude`, `${homeDir}/claude-config`, `${homeDir}/brain`, `${homeDir}/.config`].map((x) => P.resolve(x));
	// Targets a recursive delete must never name: home, the projects root, a repo directly under it, and the config folders worth more than a repo.
	const isKeepTarget = (x, dir) => {
		let t = x.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homeDir);
		if (/\/\.?\*+$/.test(t)) t = t.replace(/\/\.?\*+$/, "") || "/";
		const r = P.resolve(dir || ".", toWin(t));
		return keep.some((k) => same(k, r)) || same(P.dirname(r), P.resolve(ROOT));
	};
	// The command a segment runs, past env assignments, wrappers such as rtk and a leading shell.
	const leadCommand = (w) => {
		let i = 0;
		while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || WRAPPERS.has(w[i]))) i++;
		if (/^(ba|z)?sh$/.test(P.basename(w[i] ?? ""))) while (++i < w.length && w[i].startsWith("-"));
		return P.basename(w[i] ?? "").replace(/\.exe$/i, "");
	};

		let known = {};
		const gitPrefix = (w, dir) => {
			const git = w.findIndex((x) => /(^|[\\/])git(\.exe)?$/i.test(x));
			if (git < 0) return null;
			let at = dir, verbAt = git + 1;
			const cfgs = [];
			while (verbAt < w.length && w[verbAt].startsWith("-")) {
				if (w[verbAt] === "-C" && w[verbAt + 1]) at = P.resolve(at, toWin(w[verbAt + 1]));
				if ((w[verbAt] === "-c" || w[verbAt] === "--config-env") && w[verbAt + 1]) {
					const eq = w[verbAt + 1].indexOf("=");
					cfgs.push(eq < 0 ? { key: w[verbAt + 1].toLowerCase(), value: "" } : { key: w[verbAt + 1].slice(0, eq).toLowerCase(), value: w[verbAt + 1].slice(eq + 1) });
				}
				verbAt += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/.test(w[verbAt]) ? 2 : 1;
			}
			return { git, verbAt, at, cfgs };
		};
		const configSets = (w, gp) => {
			const sets = [...gp.cfgs];
			if (w[gp.verbAt] !== "config") return sets;
			const rest = w.slice(gp.verbAt + 1);
			if (rest.some((x) => CONFIG_READ.test(x))) return sets;
			const pos = [];
			for (let k = 0; k < rest.length; k++) {
				if (CONFIG_VALUE_FLAGS.test(rest[k])) k++;
				else if (!rest[k].startsWith("-")) pos.push(rest[k]);
			}
			if (pos.length >= 2) sets.push({ key: pos[0].toLowerCase(), value: pos.slice(1).join(" ") });
			return sets;
		};
		const repoAliases = (dir) => {
			try {
				const out = require("child_process").execFileSync("git", ["-C", dir, "config", "--get-regexp", "^alias\\."], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
				return aliasMap(out.split("\n").map((l) => { const sp = l.indexOf(" "); return sp < 0 ? null : { key: l.slice(0, sp), value: l.slice(sp + 1) }; }).filter(Boolean));
			} catch (e) { return e && e.status === 1 ? {} : null; }
		};
		const aliasMap = (sets) => {
			const map = {};
			for (const s of sets) if (s.key.startsWith("alias.") && s.key.length > 6) map[s.key.slice(6).toLowerCase()] = s.value;
			return map;
		};
		const pushish = (args) => args.some((x) => x === "push" || x === "HEAD" || x.includes(":") || /^(--force|--force-with-lease|--delete|--mirror|--all|-f|-d|-D)/.test(x) || protectedRef(x.replace(/^\+/, "")));
		const netCheck = (w, lead) => {
			const base = baseName(w[lead] ?? "");
			if (!NET_TOOLS.has(base)) return null;
			const rest = w.slice(lead + 1);
			let at = -1, m = null;
			for (let k = 0; k < rest.length && !m; k++) if ((m = GH_URL.exec(rest[k].replace(/^--url=/i, "")))) at = k;
			if (!m) return null;
			const url = m[2] ?? "/";
			const httpie = base === "http" || base === "https";
			let method = null, data = false, get = false;
			for (let k = 0; k < rest.length; k++) {
				const x = rest[k];
				let r;
				if (/^(-X|--request|--method)$/.test(x) || /^-(method|custommethod)$/i.test(x) || /^-me(t(h(o(d)?)?)?)?$/i.test(x)) { method = rest[++k] ?? ""; continue; }
				if ((r = /^-X(.+)$/.exec(x) || /^(?:--request=|--method=|-method:)(.+)$/i.exec(x))) { method = r[1]; continue; }
				if (/^(-G|--get)$/.test(x)) get = true;
				else if (/^-[A-Za-z]*[dFT][A-Za-z]*$/.test(x) || /^--(data(-[a-z]+)?|form(-string)?|json|upload-file|post-data|post-file|body-data|body-file)(=.*)?$/.test(x) || /^-(body|infile)$/i.test(x) || /^-bo(d(y)?)?$/i.test(x)) data = true;
				else if (httpie && (/^(--form|-f|--json|-j)$/.test(x) || /^[A-Za-z0-9_.-]+(:=|=@|=([^=]|$))/.test(x))) data = true;
			}
			if (httpie && method === null && at > 0 && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/i.test(rest[at - 1])) method = rest[at - 1];
			const write = method !== null ? WRITE_METHOD.test(method) : data && !get;
			if (write && GH_WRITE_PATH.some((re) => re.test(url))) return { rule: "gh-raw-api", why: "a write call to the GitHub API that merges, moves a ref, changes protection or starts a workflow is the owner's call, not an unattended step. Use a GET, or push the working branch and merge through a PR" };
			return null;
		};

		const GH_VALUE_FLAGS = /^(-R|--repo|--hostname)$/;
		const GH_API_SKIP = /^(-H|--header|-q|--jq|-t|--template|--hostname|--cache|-p|--preview)$/;
		const GRAPHQL_DESTRUCTIVE = /\b(mergePullRequest|closePullRequest|deleteRef|deleteBranch|deleteRepository|updateRef|createRef|enablePullRequestAutoMerge|mergeBranch)\b/;
		const abbr = (x, full) => x.startsWith("--") && x.length >= 5 && full.startsWith(x.slice(2).split("=")[0]);
		const protectedRef = (v) => PROTECTED.includes(String(v).replace(/^refs\/heads\//, ""));
		const ghPositions = (rest) => {
			const at = [];
			for (let k = 0; k < rest.length; k++) {
				if (GH_VALUE_FLAGS.test(rest[k])) { k++; continue; }
				if (!rest[k].startsWith("-")) at.push(k);
			}
			return at;
		};
		// gh api <endpoint> with -X/--method, -f/-F fields and --input: what the call does to a pull request or a ref.
		const ghApi = (rest, rdyn, unattended) => {
			let method = null, endpoint = null, body = false, input = false;
			const fields = [];
			for (let k = 0; k < rest.length; k++) {
				const x = rest[k];
				let m;
				if (x === "-X" || x === "--method") { method = rest[++k] ?? ""; continue; }
				if ((m = /^(?:-X|--method=)(.+)$/.exec(x))) { method = m[1]; continue; }
				if (/^(-f|-F|--field|--raw-field)$/.test(x)) { fields.push(rest[++k] ?? ""); body = true; continue; }
				if ((m = /^(?:-[fF]|--field=|--raw-field=)(.+)$/.exec(x))) { fields.push(m[1]); body = true; continue; }
				if (x === "--input") { body = true; input = true; k++; continue; }
				if (x.startsWith("--input=")) { body = true; input = true; continue; }
				if (GH_API_SKIP.test(x)) { k++; continue; }
				if (x.startsWith("-")) continue;
				if (endpoint === null) endpoint = x;
			}
			if (unattended && rdyn.some(Boolean)) return { rule: "gh-unresolved", why: "cannot tell what this gh api call does because part of it expands at run time. Write the endpoint and method out" };
			const verb = String(method ?? (body ? "POST" : "GET")).toUpperCase();
			const ep = String(endpoint ?? "").replace(/^\/+/, "").replace(/\?.*$/, "");
			if (verb === "DELETE") return { rule: "delete-branch", why: "gh api -X DELETE is not allowed here" };
			if (/(^|\/)pulls\/\d+\/merge$/.test(ep)) return { rule: "gh-destructive", why: "merging a PR through the API is the owner's call, not an unattended step" };
			if (ep === "graphql" && fields.some((f) => GRAPHQL_DESTRUCTIVE.test(f))) return { rule: "gh-destructive", why: "merging, closing or deleting through the GraphQL API is the owner's call, not an unattended step" };
			if (unattended && ep === "graphql" && (input || fields.some((f) => /^query=@/.test(f)))) return { rule: "gh-unresolved", why: "a GraphQL query read from a file cannot be inspected here. Pass the query inline with -f query=..." };
			if (verb === "GET") return null;
			if (unattended && /(^|\/)dispatches$/.test(ep)) return { rule: "gh-workflow", why: "dispatching a workflow through the API can merge or push on the server and is not an unattended step" };
			if (/(^|\/)pulls\/\d+$/.test(ep) && fields.some((f) => /^state=closed$/i.test(f))) return { rule: "gh-destructive", why: "closing a PR through the API is the owner's call, not an unattended step" };
			const ref = /(^|\/)git\/refs\/heads\/(.+)$/.exec(ep);
			if (ref && protectedRef(ref[2])) return { rule: "push-protected", why: `updating ${ref[2]} through the API is not allowed. Push the working branch and merge through a PR` };
			if (ref && fields.some((f) => /^force=true$/i.test(f))) return { rule: "force-push", why: "a forced ref update through the API is not allowed" };
			if (/(^|\/)git\/refs$/.test(ep) && fields.some((f) => /^ref=/.test(f) && protectedRef(f.slice(4)))) return { rule: "push-protected", why: "creating a protected ref through the API is not allowed" };
			if (/(^|\/)merges$/.test(ep) && fields.some((f) => /^base=/.test(f) && protectedRef(f.slice(5)))) return { rule: "push-protected", why: "merging into a protected branch through the API is not allowed" };
			return null;
		};

		function inspect(w, dyn, segment, dir, unattended, killing, command, hops = 0) {
			const gp = gitPrefix(w, dir);
			const at = gp ? gp.at : dir;
			const verbAt = gp ? gp.verbAt : -1;
			// Matched without the word git too: scripts call it through a variable ("$G worktree remove").
			const removeAt = w.findIndex((x, i) => x === "worktree" && w[i + 1] === "remove");
			if (removeAt >= 0) {
				const args = w.slice(removeAt + 2);
				if (args.some((x) => x === "--force" || x === "-f")) return { rule: "worktree-remove", hard: true, why: `git worktree remove --force is never allowed. Use: bash ${KIT}/wt.sh unlink <dir>, then wt.sh remove <dir>` };
				for (const target of args.filter((x) => !x.startsWith("-"))) {
					if (/[$`%]/.test(target)) return { rule: "worktree-remove", hard: true, why: `cannot tell which folder "${target}" is. Use: bash ${KIT}/wt.sh remove <dir>` };
					const resolved = P.resolve(at, toWin(target));
					if (isJunction(resolved)) return { rule: "worktree-remove", hard: true, why: `${toWin(resolved)}/node_modules is a junction into the main repo and git deletes through it. Use: bash ${KIT}/wt.sh unlink <dir>, then wt.sh remove <dir>` };
				}
			}
			const verb = verbAt >= 0 ? w[verbAt] : null;
			const args = verbAt >= 0 ? w.slice(verbAt + 1) : [];
			const argDyn = verbAt >= 0 ? dyn.slice(verbAt + 1) : [];
			if (verb && unattended && dyn[verbAt] && pushish(args)) return { rule: "push-unresolved", why: "cannot tell which git command runs here because its name expands at run time. Write the command out" };
			if (verb && hops < 5) {
				const key = verb.toLowerCase();
				let exp = Object.hasOwn(known, key) ? known[key] : undefined;
				if (exp === undefined && unattended && !GIT_BUILTIN.has(verb)) {
					const found = repoAliases(at);
					if (found) exp = Object.hasOwn(found, key) ? found[key] : undefined;
					else if (pushish(args)) return { rule: "git-unknown-verb", why: `"git ${verb}" is not a git command this guard knows and its aliases could not be read. Use git push origin <branch> directly` };
				}
				if (exp !== undefined && exp.startsWith("!")) {
					const sub = parseCommand(`${exp.slice(1)} ${args.join(" ")}`);
					for (const u of sub.units) {
						const hit = inspect(u.words, u.dyn, u.text, at, unattended, killing, command, hops + 1);
						if (hit) return hit;
					}
					if (unattended && sub.unresolved && PUSH_SHAPED.test(exp)) return { rule: "unresolved-command", why: "cannot read this git alias to the end and it pushes. Write the command out plainly" };
				} else if (exp !== undefined) {
					const toks = words(exp);
					const hit = inspect([...w.slice(0, verbAt), ...toks, ...args], [...dyn.slice(0, verbAt), ...toks.map(() => false), ...argDyn], segment, dir, unattended, killing, command, hops + 1);
					if (hit) return hit;
				}
			}
			if (verb === "add" && args.some((x) => x === "." || x === "-A" || x === "--all" || x === "*")) return { rule: "git-add-all", why: "git add . / -A is not allowed here. Stage each path by name, then check git diff --cached --name-only" };
			if (verb === "push" || verb === "send-pack") {
				if (unattended && argDyn.some(Boolean)) return { rule: "push-unresolved", why: "cannot tell where this push goes because part of it expands at run time. Write the branch out: git push origin <branch>" };
				if (unattended && args.some((x) => abbr(x, "receive-pack") || abbr(x, "exec"))) return { rule: "push-exec", why: "git push --receive-pack / --exec runs another program for the push and is not allowed here" };
				if (args.some((x) => abbr(x, "all"))) return { rule: "push-protected", why: "pushing every branch includes the protected ones and is not allowed. Push the working branch by name" };
				let repo = null;
				const positionals = [];
				for (let k = 0; k < args.length; k++) {
					const x = args[k];
					if (abbr(x, "repo")) repo = x.includes("=") ? x.slice(x.indexOf("=") + 1) : (args[++k] ?? "");
					else if (/^(-o|--push-option|--receive-pack|--exec)$/.test(x)) k++;
					else if (!x.startsWith("-")) positionals.push(x);
				}
				const refs = repo === null ? positionals.slice(1) : positionals;
				const targets = refs.map((r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, ""));
				if (!targets.length || targets.includes("HEAD")) targets.push(currentBranch(at));
				const hit = targets.find((x) => PROTECTED.includes(x));
				if (hit) return { rule: "push-protected", why: `pushing to ${hit} is not allowed. Push the working branch and merge through a PR` };
				if (args.some((x) => abbr(x, "mirror"))) return { rule: "force-push", why: "git push --mirror overwrites and deletes remote refs and is not allowed. Push the working branch normally" };
				const force = args.find((x) => /^--force/.test(x) || abbr(x, "force") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x) || /^\+\S/.test(x));
				if (force) return { rule: "force-push", why: `force push (${force}) is not allowed. Push the working branch normally` };
				if (args.some((x) => x === "--delete" || abbr(x, "delete") || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x) || /^:[^\s:]/.test(x))) return { rule: "delete-branch", why: "deleting a remote branch is not allowed here" };
			}
			if (verb === "branch") {
				const shorts = args.filter((x) => /^-[a-zA-Z]+$/.test(x)).join("");
				const longs = args.filter((x) => x.startsWith("--"));
				const del = shorts.includes("D") || shorts.includes("d") || longs.some((x) => abbr(x, "delete"));
				const forced = shorts.includes("f") || longs.some((x) => abbr(x, "force"));
				if (shorts.includes("D") || (del && forced)) return { rule: "delete-branch", why: "git branch -D is not allowed here" };
				if (unattended && del && argDyn.some(Boolean)) return { rule: "branch-unresolved", why: "cannot tell which branch this deletes because part of it expands at run time. Write the branch name out" };
			}
			const discarding = (verb === "reset" && args.includes("--hard"))
				|| (verb === "clean" && !args.some((x) => x === "-n" || x === "--dry-run"))
				|| (verb === "checkout" && args.includes("."))
				|| (verb === "restore" && args.includes(".") && !(args.includes("--staged") && !args.includes("--worktree")));
			if (discarding && underRoot(at) && !inWorktree(at)) return { rule: "discard-local", why: `git ${verb} would throw away local work in a main clone. Do it inside a wt-* worktree, or ask the owner` };
			const gh = w.findIndex((x) => /(^|[\\/])gh(\.exe)?$/i.test(x));
			if (gh >= 0) {
				const rest = w.slice(gh + 1);
				const rdyn = dyn.slice(gh + 1);
				const pos = ghPositions(rest);
				const first = rest[pos[0]], second = rest[pos[1]];
				if ((first === "pr" && /^(merge|close)$/.test(second)) || (first === "repo" && second === "delete") || (first === "release" && second === "delete")) return { rule: "gh-destructive", why: "merging or closing a PR and deleting a repo or release is the owner's call, not an unattended step" };
				if (unattended && first === "workflow" && second === "run") return { rule: "gh-workflow", why: "gh workflow run starts a workflow that can merge or push on the server and is not an unattended step" };
				if (first === "alias" && second === "set" && GH_ALIAS_BAD.test(rest[pos[3]] ?? "")) return { rule: "gh-destructive", why: "a gh alias that merges, closes, deletes or runs a workflow is not allowed" };
				if (unattended && first === "alias" && second === "import") return { rule: "gh-unresolved", why: "gh alias import reads aliases from a file this guard cannot inspect" };
				if (first === "api") {
					const hit = ghApi(rest.slice(pos[0] + 1), rdyn.slice(pos[0] + 1), unattended);
					if (hit) return hit;
				} else if (unattended && (rdyn[pos[0]] || rdyn[pos[1]])) return { rule: "gh-unresolved", why: "cannot tell what this gh command does because part of it expands at run time. Write it out" };
			}
			let lead = 0;
			while (lead < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[lead]) || WRAPPERS.has(w[lead]))) lead++;
			if (unattended) {
				const raw = netCheck(w, lead);
				if (raw) return raw;
			}
			if (unattended && dyn[lead] && w.slice(lead + 1).some((x) => x === "push" || x === "merge" || x === "-D" || x === "--delete")) return { rule: "command-unresolved", why: "cannot tell which command runs here because its name expands at run time. Write the command out" };

			const bare = [...words(segment.replace(/["']/g, " ")), ...w].filter(Boolean);
			const has = (re) => bare.some((x) => re.test(x));
			const recursive = (has(/^rm$/) && has(/^-[a-zA-Z]*[rR][a-zA-Z]*$|^--recursive$/))
				|| (has(/^(Remove-Item|ri|rd|del|erase|rmdir)$/i) && has(/^-(r|rec|recurse)$/i))
				|| (has(/^(rmdir|rd)$/i) && has(/^\/{1,2}s$/i));
			const atRoot = /^[eE]:\/qonflo\/?$/.test(toWin(dir)) || toWin(dir).replace(/\/+$/, "") === ROOT;
			const operands = recursive ? bare.filter((x) => !x.startsWith("-") && !/^\/{1,2}[a-zA-Z]$/.test(x)) : [];
			const target = operands.find((x) => isWorktreeTarget(x) || (atRoot && /^(\.\/)?\*$/.test(x)));
			if (target) return { rule: "rm-worktree", hard: true, why: `deleting ${target} by hand can reach the main repo through a node_modules junction. Use: bash ${KIT}/wt.sh remove <dir>` };
			const keepHit = operands.filter((x) => !WRAPPERS.has(x) && !/^(rm|Remove-Item|ri|rd|del|erase|rmdir)$/i.test(x)).find((x) => isKeepTarget(x, dir));
			if (keepHit) return { rule: "rm-protected", why: `recursive delete of ${keepHit} is not allowed here` };

			const port = PORTS.find((p) => new RegExp(`(^|[^\\d.])${p}(?!\\d)`).test(segment));
			if (port && killing && !/stack\.sh/.test(segment)) return { rule: "owner-port", why: `port ${port} belongs to the owner's own servers. Stop ticket servers with: bash ${KIT}/stack.sh down <ticket ports>` };

			const leadName = leadCommand(w);
			if (/^(mongosh|mongo)$/.test(leadName) && /\b(dropDatabase|drop|deleteMany)\b|\bremove\s*\(/.test(command)) return { rule: "database-destroy", why: "dropping or deleting Mongo data is not allowed here" };
			if (leadName === "mongorestore" && has(/^--drop$/)) return { rule: "database-destroy", why: "mongorestore --drop is not allowed here" };
			if (leadName === "redis-cli" && /\bFLUSH(ALL|DB)\b/i.test(command)) return { rule: "database-destroy", why: "flushing Redis is not allowed here" };
			if (/mongo-restore-seed/.test(segment)) return { rule: "database-destroy", why: "the seed script replaces the dev database" };
			if (MACHINE_CONTROL.has(leadName)) return { rule: "machine-control", why: `${leadName} controls the machine, not the project` };
			if (/\.config\/claude-config\b/.test(segment)) return { rule: "machine-control", why: "the machine's secret store is not for the agent to read" };
			return null;
		}

		function check(command, cwd) {
			const unattended = env.DOCK_CHAT_TURN === "1";
			let dir = toWin(cwd || "");
			const killing = /\b(kill-port|fkill|taskkill|Stop-Process|kill|pkill|killall)\b/i.test(command);
			const parsed = parseCommand(command);
			const sets = [];
			let pushing = false, remoteEdit = false;
			for (const unit of parsed.units) {
				const gp = gitPrefix(unit.words, dir);
				if (gp) sets.push(...configSets(unit.words, gp));
			}
			known = aliasMap(sets);
			for (const unit of parsed.units) {
				const gp = gitPrefix(unit.words, dir);
				const verb = gp ? unit.words[gp.verbAt] : null;
				if (!verb) continue;
				const exp = Object.hasOwn(known, verb.toLowerCase()) ? known[verb.toLowerCase()] : "";
				if (verb === "push" || verb === "send-pack" || PUSH_SHAPED.test(exp)) pushing = true;
				if (verb === "remote" && unit.words.slice(gp.verbAt + 1).some((x) => x === "set-url" || x === "add")) remoteEdit = true;
			}
			if (pushing && (unattended || inWorkspace(` ${dir}`) || inWorkspace(` ${command}`))) {
				const bad = sets.find((s) => DANGER_CFG.test(s.key));
				if (bad) return { rule: "push-redirect", why: `git setting ${bad.key} changes where a push goes or what it runs and cannot be combined with a push. Push with the plain remote and branch` };
				if (unattended && remoteEdit) return { rule: "push-redirect", why: "git remote add / set-url cannot be combined with a push in one command. Run them as separate commands the owner can see" };
			}
			const saved = [];
			let level = 0;
			for (const unit of parsed.units) {
				while (level > unit.depth) { dir = saved.pop() ?? dir; level--; }
				while (level < unit.depth) { saved.push(dir); level++; }
				const segment = unit.text;
				const cdWords = unit.alt || unit.words;
				if (/^(cd|pushd|Set-Location|sl)$/i.test(cdWords[0] ?? "") && cdWords[1]) {
					dir = P.resolve(dir, toWin(cdWords[1]));
					continue;
				}
				if (!unattended && !inWorkspace(` ${dir}`) && !inWorkspace(` ${segment}`)) continue;
				for (const w of unit.alt ? [unit.words, unit.alt] : [unit.words]) {
					const hit = inspect(w, unit.dyn, segment, dir, unattended, killing, command);
					if (hit) return hit;
				}
			}
			if (unattended && parsed.unresolved && /\bgit\b[^\n]*\b(push|branch)\b|\bgh\b/i.test(command)) return { rule: "unresolved-command", why: "cannot read this command line to the end (an unclosed quote or an unreadable nested shell) and it touches git or gh. Write it out plainly" };
			return null;
		}
	return { check };
}

// The hook answer for one command, or null. guard, env and cfg are inputs for tests.
function answer(command, cwd, { guard = createGuard(), env = process.env, cfg = config(), agent = "lead", log = true } = {}) {
	const hit = guard.check(command, cwd);
	if (!hit) return null;
	const deny = hit.hard || env.DOCK_CHAT_TURN === "1" || !cfg.softUntil || new Date().toISOString().slice(0, 10) >= cfg.softUntil;
	if (log) try { fs.appendFileSync(path.join(__dirname, "guard.log"), `${new Date().toISOString()} ${deny ? "DENY" : "WARN"} ${hit.rule} ${agent} :: ${command.replace(/\s+/g, " ").slice(0, 300)}\n`); } catch {}
	const out = deny
		? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `guard: ${hit.why}` }
		: { hookEventName: "PreToolUse", additionalContext: `guard WARNING (${hit.rule}): ${hit.why}. This is refused outright from ${cfg.softUntil}.` };
	return JSON.stringify({ hookSpecificOutput: out });
}

// A guard that cannot do its check blocks the call: exit 2 with the reason on stderr.
function fail(why) {
	process.stderr.write(`guard: ${why}; refusing\n`);
	process.exitCode = 2;
}

function main() {
	let payload;
	try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { return fail(`cannot read the hook input (${e.message})`); }
	const command = payload?.tool_input?.command;
	if (typeof command !== "string" || !command.trim()) return;
	const out = answer(command, payload.cwd, { agent: payload.agent_type ?? "lead" });
	if (out) process.stdout.write(out);
}

if (require.main === module) {
	try { main(); } catch (e) { fail(`internal error (${e.message})`); }
} else {
	module.exports = { check: (command, cwd) => createGuard().check(command, cwd), createGuard, answer };
}
