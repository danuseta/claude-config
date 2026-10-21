// PreToolUse hook for DOCK chat turns (DOCK_CHAT_TURN=1, set by dock-chat.cjs): grants the work that stays inside the qonflo folder,
// so an unattended turn does not stop on a permission prompt nobody can answer. Outside a DOCK turn it prints nothing.
//   allow  Read / Edit / Write / MultiEdit / NotebookEdit on a path under the root (worktrees and <MMDD> folders included), the
//          evidence folder or ~/qonflo-out; Read also on <config>/kit, skills, agents and rules. Never .git or .claude/settings*.json
//   allow  Bash / PowerShell whose cwd and every path-looking argument resolve inside those folders, after stripping `rtk`,
//          `rtk proxy`, `timeout N` and VAR=value prefixes and following `cd <dir> &&`. Never a command that names coder, tailscale,
//          ssh, scp, sudo, docker, systemctl or another machine tool, a nested shell (`bash -c`, eval), $ or backtick expansion
//   allow  Skill, Agent, Task*, TodoWrite, WebSearch, and the read tools of the Atlassian and Figma MCP servers
// Anything else gets no answer and falls through to the permission mode and the settings rules, so it still asks.
// This hook never denies. Claude Code applies deny over ask over allow across every hook and the settings rules, so a deny from
// guard.cjs, sous-guard.cjs or permissions.deny wins over this allow. Any error prints nothing: failing silent means it asks.
// Test: echo '{"tool_name":"Edit","cwd":"E:/qonflo","tool_input":{"file_path":"E:/qonflo/wt-1-be/src/a.ts"}}' | DOCK_CHAT_TURN=1 node scope-allow.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FREE_TOOLS = new Set(["Skill", "Agent", "Task", "TodoWrite", "WebSearch"]);
const READ_MCP = /^mcp__(claude_ai_Atlassian|claude_ai_Atlassian_Rovo|atlassian|figma)__(get|search|lookup|fetch|atlassianUserInfo|whoami)/;
const MACHINE = new Set(["coder", "tailscale", "ssh", "scp", "sftp", "rsync", "sudo", "su", "doas", "docker", "docker-compose", "podman", "systemctl", "ccfg"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "powershell", "pwsh", "cmd"]);
const EVALS = new Set(["eval", "iex", "invoke-expression"]);
const SHELL_RUN = /^(-[a-z]*c|-command|-encodedcommand|\/c|\/k)$/i;
const CONFIG_READ = ["kit", "skills", "agents", "rules"];
const READ_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "diff", "read", "tree"]);
const PROTECTED = [/(^|\/)\.git(\/|$)/, /(^|\/)\.claude\/settings(\.local)?\.json$/];
const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "inside qonflo" } });

// platform, paths and home are inputs so the Linux rules can be exercised on Windows and the other way round.
function createScopeAllow({ platform = process.platform, paths = resolvePaths(), home = os.homedir() } = {}) {
	const win = platform === "win32";
	const P = win ? path.win32 : path.posix;
	const fwd = (p) => String(p).replace(/\\/g, "/");
	// Resolves against base, follows symlinks of the longest existing prefix when running on that platform.
	const norm = (p, base) => {
		let s = fwd(p).replace(/^~(?=\/|$)/, fwd(home));
		if (win) s = s.replace(/^\/([a-zA-Z])(\/|$)/, "$1:/");
		s = fwd(P.resolve(fwd(base), s)).replace(/\/+$/, "");
		if (platform === process.platform) {
			let head = s, tail = "";
			while (head && !fs.existsSync(head)) {
				const up = fwd(P.dirname(head));
				if (up === head) break;
				tail = `/${P.basename(head)}${tail}`;
				head = up;
			}
			try { s = fwd(fs.realpathSync.native(head)).replace(/\/+$/, "") + tail; } catch {}
		}
		return win ? s.toLowerCase() : s;
	};
	const here = fwd(process.cwd());
	const roots = [paths.root, paths.evidence, `${fwd(home)}/qonflo-out`].map((r) => norm(r, here));
	const configRoots = [paths.kitDir, ...CONFIG_READ.map((d) => `${paths.configDir}/${d}`)].map((r) => norm(r, here));
	const inside = (p, list) => list.some((r) => p === r || p.startsWith(r + "/"));
	const allowedPath = (raw, cwd, read) => {
		const p = norm(raw, cwd);
		if (PROTECTED.some((re) => re.test(p))) return false;
		return inside(p, roots) || (read && inside(p, configRoots));
	};

	// The command split into simple segments, or null when it has expansion, subshells or an unclosed quote.
	function segments(cmd) {
		const out = [];
		let cur = "", q = null;
		for (let i = 0; i < cmd.length; i++) {
			const c = cmd[i];
			if (q === "'") { if (c === "'") q = null; cur += c; continue; }
			if (q === '"') {
				if (c === "$" || c === "`") return null;
				if (c === "\\") { cur += c + (cmd[i + 1] ?? ""); i++; continue; }
				if (c === '"') q = null;
				cur += c;
				continue;
			}
			if (c === "'" || c === '"') { q = c; cur += c; continue; }
			if ("$`(){}".includes(c)) return null;
			if (c === "<" && cmd[i + 1] === "<") return null;
			if (";&|\n".includes(c)) {
				if (c === "&" && cmd[i - 1] === ">") { cur += c; continue; }
				out.push(cur);
				cur = "";
				continue;
			}
			cur += c;
		}
		if (q) return null;
		out.push(cur);
		return out.map((s) => s.trim()).filter(Boolean);
	}
	const words = (seg) => {
		const out = [];
		const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
		let m;
		const s = seg.replace(/\d*>&\d+/g, " ").replace(/&?\d*>>?|</g, " ");
		while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
		return out;
	};
	const looksLikePath = (w) => !/:\/\//.test(w) && (/[\\/]/.test(w) || /^[~.]/.test(w) || /^[a-zA-Z]:/.test(w));
	const base = (w) => fwd(w).split("/").pop().replace(/\.exe$/i, "").toLowerCase();

	function bashAllowed(command, cwd) {
		const segs = segments(command);
		if (!segs || !segs.length) return false;
		let dir = cwd;
		if (!allowedPath(dir, here, false)) return false;
		for (const seg of segs) {
			const w = words(seg);
			while (w.length && (w[0] === "rtk" || w[0] === "proxy" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w.shift();
			if (w[0] === "timeout") {
				w.shift();
				while (w.length && /^-/.test(w[0])) w.shift();
				if (w.length && /^\d+(\.\d+)?[smhd]?$/.test(w[0])) w.shift();
			}
			while (w[0] === "rtk" || w[0] === "proxy") w.shift();
			if (!w.length) continue;
			const names = w.map(base);
			if (names.some((n) => MACHINE.has(n) || EVALS.has(n)) || names[0] === "source" || w[0] === ".") return false;
			if (names.some((n, i) => SHELLS.has(n) && w.slice(i + 1).some((x) => SHELL_RUN.test(x)))) return false;
			const read = READ_CMDS.has(names[0]);
			if (/^(cd|pushd|set-location|sl)$/i.test(w[0])) {
				if (!w[1] || !allowedPath(w[1], dir, false)) return false;
				dir = norm(w[1], dir);
				continue;
			}
			for (const x of w.slice(1)) {
				const v = x.startsWith("-") ? (x.includes("=") ? x.slice(x.indexOf("=") + 1) : "") : x;
				if (v === "/dev/null" || v === "NUL") continue;
				if (v && looksLikePath(v) && !allowedPath(v, dir, read)) return false;
			}
			if (looksLikePath(w[0]) && !allowedPath(w[0], dir, false)) return false;
		}
		return true;
	}

	// True when the call is granted.
	function decide(payload) {
		const tool = String(payload?.tool_name ?? "");
		const input = payload?.tool_input ?? {};
		const cwd = payload?.cwd || here;
		if (FREE_TOOLS.has(tool) || /^Task[A-Z]/.test(tool) || READ_MCP.test(tool)) return true;
		if (FILE_TOOLS.has(tool)) {
			const raw = input.file_path || input.notebook_path;
			return typeof raw === "string" && raw !== "" && allowedPath(raw, cwd, tool === "Read");
		}
		if (tool === "Bash" || tool === "PowerShell") return typeof input.command === "string" && bashAllowed(input.command, cwd);
		return false;
	}
	return { decide };
}

function main() {
	if (process.env.DOCK_CHAT_TURN !== "1") return;
	const payload = JSON.parse(fs.readFileSync(0, "utf8"));
	if (createScopeAllow().decide(payload)) process.stdout.write(ALLOW);
}

if (require.main === module) {
	try { main(); } catch {}
	process.exitCode = 0;
} else {
	module.exports = { createScopeAllow, ALLOW };
}
