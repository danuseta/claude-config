// Starts a dev server in the background with its output in a log the DOCK Dev Servers page shows.
//   node dev-server.cjs <port> -- <command...>      run from the worktree folder
// The log is ~/.local/state/dock/dev-logs/<worktree folder>-<port>.log, emptied at each start.
// This returns at once: the server writes straight to the file, no process stays in between,
// and nothing of its output comes back into the agent's session.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const LOG_DIR = process.env.DOCK_DEV_LOG_DIR || path.join(os.homedir(), ".local", "state", "dock", "dev-logs");
const PROJECTS = process.env.QONFLO_PROJECTS_DIR || path.join(os.homedir(), "projects");

// The worktree folder: the first folder under the projects folder, else the current folder's own name.
function folderOf(cwd) {
	const relative = path.relative(PROJECTS, cwd);
	const first = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep)[0] : "";
	return (first || path.basename(cwd)).replace(/[^A-Za-z0-9._-]/g, "-");
}

function main() {
	const args = process.argv.slice(2);
	const at = args.indexOf("--");
	const port = Number(args[0]);
	const command = at >= 0 ? args.slice(at + 1) : [];
	if (!Number.isInteger(port) || port < 1 || port > 65535 || at !== 1 || command.length === 0) {
		console.error("usage: node dev-server.cjs <port> -- <command...>");
		process.exitCode = 1;
		return;
	}
	fs.mkdirSync(LOG_DIR, { recursive: true });
	const log = path.join(LOG_DIR, `${folderOf(process.cwd())}-${port}.log`);
	const out = fs.openSync(log, "w");
	const child = spawn(command[0], command.slice(1), { cwd: process.cwd(), detached: true, stdio: ["ignore", out, out], env: { ...process.env, PORT: String(port) } });
	child.on("error", (err) => {
		console.error(`could not start ${command[0]}: ${err.message}`);
		process.exitCode = 1;
	});
	child.unref();
	fs.closeSync(out);
	if (child.pid) console.log(`started ${command.join(" ")} on port ${port} (pid ${child.pid}); log ${log}`);
}

main();
