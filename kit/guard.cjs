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
// Simple commands, split on the shell's separators. Good enough to read what a command line asks for.
const segments = (command) => command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
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

	function check(command, cwd) {
		const unattended = env.DOCK_CHAT_TURN === "1";
		let dir = toWin(cwd || "");
		const killing = /\b(kill-port|fkill|taskkill|Stop-Process|kill|pkill|killall)\b/i.test(command);
		for (const segment of segments(command)) {
			const w = words(segment);
			if (/^(cd|pushd|Set-Location|sl)$/i.test(w[0] ?? "") && w[1]) {
				dir = P.resolve(dir, toWin(w[1]));
				continue;
			}
			if (!unattended && !inWorkspace(` ${dir}`) && !inWorkspace(` ${segment}`)) continue;

			const git = w.findIndex((x) => /(^|[\\/])git(\.exe)?$/i.test(x));
			let at = dir;
			let verbAt = -1;
			if (git >= 0) {
				verbAt = git + 1;
				while (verbAt < w.length && w[verbAt].startsWith("-")) {
					if (w[verbAt] === "-C" && w[verbAt + 1]) at = P.resolve(at, toWin(w[verbAt + 1]));
					verbAt += w[verbAt] === "-C" || w[verbAt] === "-c" ? 2 : 1;
				}
			}
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
			if (verb === "add" && args.some((x) => x === "." || x === "-A" || x === "--all" || x === "*")) return { rule: "git-add-all", why: "git add . / -A is not allowed here. Stage each path by name, then check git diff --cached --name-only" };
			if (verb === "push") {
				const targets = args.filter((x) => !x.startsWith("-")).slice(1).map((r) => r.split(":").pop().replace(/^refs\/heads\//, ""));
				if (!targets.length || targets.includes("HEAD")) targets.push(currentBranch(at));
				const hit = targets.find((x) => PROTECTED.includes(x));
				if (hit) return { rule: "push-protected", why: `pushing to ${hit} is not allowed. Push the working branch and merge through a PR` };
				const force = args.find((x) => /^--force/.test(x) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x) || /^\+\S/.test(x));
				if (force) return { rule: "force-push", why: `force push (${force}) is not allowed. Push the working branch normally` };
				if (args.some((x) => x === "--delete" || x === "-d" || /^:[^\s:]/.test(x))) return { rule: "delete-branch", why: "deleting a remote branch is not allowed here" };
			}
			if (verb === "branch" && args.some((x) => x === "-D" || (x === "--delete" && args.some((y) => y === "--force" || y === "-f")))) return { rule: "delete-branch", why: "git branch -D is not allowed here" };
			const discarding = (verb === "reset" && args.includes("--hard"))
				|| (verb === "clean" && !args.some((x) => x === "-n" || x === "--dry-run"))
				|| (verb === "checkout" && args.includes("."))
				|| (verb === "restore" && args.includes(".") && !(args.includes("--staged") && !args.includes("--worktree")));
			if (discarding && underRoot(at) && !inWorktree(at)) return { rule: "discard-local", why: `git ${verb} would throw away local work in a main clone. Do it inside a wt-* worktree, or ask the owner` };
			const gh = w.findIndex((x) => /(^|[\\/])gh(\.exe)?$/i.test(x));
			if (gh >= 0) {
				const rest = w.slice(gh + 1);
				if (/\bpr (merge|close)\b|\brepo delete\b|\brelease delete\b/.test(rest.join(" "))) return { rule: "gh-destructive", why: "merging or closing a PR and deleting a repo or release is the owner's call, not an unattended step" };
				const api = rest.indexOf("api");
				if (api >= 0 && rest.some((x, i) => /^(-X|--method)$/i.test(x) && /^DELETE$/i.test(rest[i + 1] ?? "")) || rest.some((x) => /^-XDELETE$/i.test(x))) return { rule: "delete-branch", why: "gh api -X DELETE is not allowed here" };
			}

			const bare = words(segment.replace(/["']/g, " "));
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

			const lead = leadCommand(w);
			if (/^(mongosh|mongo)$/.test(lead) && /\b(dropDatabase|drop|deleteMany)\b|\bremove\s*\(/.test(command)) return { rule: "database-destroy", why: "dropping or deleting Mongo data is not allowed here" };
			if (lead === "mongorestore" && has(/^--drop$/)) return { rule: "database-destroy", why: "mongorestore --drop is not allowed here" };
			if (lead === "redis-cli" && /\bFLUSH(ALL|DB)\b/i.test(command)) return { rule: "database-destroy", why: "flushing Redis is not allowed here" };
			if (/mongo-restore-seed/.test(segment)) return { rule: "database-destroy", why: "the seed script replaces the dev database" };
			if (MACHINE_CONTROL.has(lead)) return { rule: "machine-control", why: `${lead} controls the machine, not the project` };
			if (/\.config\/claude-config\b/.test(segment)) return { rule: "machine-control", why: "the machine's secret store is not for the agent to read" };
		}
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

function main() {
	let payload;
	try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
	const command = payload?.tool_input?.command;
	if (typeof command !== "string" || !command.trim()) return;
	const out = answer(command, payload.cwd, { agent: payload.agent_type ?? "lead" });
	if (out) process.stdout.write(out);
}

if (require.main === module) {
	try { main(); } catch {}
} else {
	module.exports = { check: (command, cwd) => createGuard().check(command, cwd), createGuard, answer };
}
