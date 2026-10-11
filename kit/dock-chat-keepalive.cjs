// Keeps the DOCK chat bridge running: one instance per machine, restarted when it exits.
//   node dock-chat-keepalive.cjs          start (does nothing if one is already running)
//   node dock-chat-keepalive.cjs status   say whether it is running
//   node dock-chat-keepalive.cjs stop     stop the keepalive and its bridge
// Started hidden at Windows logon by dock-chat-autostart.vbs. Output goes to dock-chat.log beside this file.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const LOCK = path.join(__dirname, "dock-chat.lock");
const LOG = path.join(__dirname, "dock-chat.log");
const BRIDGE = path.join(__dirname, "dock-chat.cjs");
const RESTART_MS = 15000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function alive(pid) {
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function readLock() {
	try { return JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { return null; }
}
function running() {
	const lock = readLock();
	return lock && alive(lock.keepalive) ? lock : null;
}
function log(line) {
	try {
		if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG_BYTES) fs.renameSync(LOG, LOG + ".1");
		fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

const cmd = process.argv[2] || "start";

if (cmd === "status") {
	const lock = running();
	console.log(lock ? `running: keepalive pid ${lock.keepalive}, bridge pid ${lock.bridge || "-"}, since ${lock.since}` : "not running");
} else if (cmd === "stop") {
	const lock = running();
	if (!lock) console.log("not running");
	else {
		for (const pid of [lock.keepalive, lock.bridge]) { try { if (pid) process.kill(pid); } catch {} }
		try { fs.rmSync(LOCK, { force: true }); } catch {}
		console.log("stopped");
	}
} else if (running()) {
	console.log("already running");
} else {
	const since = new Date().toISOString();
	let child = null;
	let stopping = false;
	const writeLock = () => { try { fs.writeFileSync(LOCK, JSON.stringify({ keepalive: process.pid, bridge: child ? child.pid : null, since })); } catch {} };
	const start = () => {
		child = spawn(process.execPath, [BRIDGE, "run"], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		writeLock();
		log(`keepalive: bridge started, pid ${child.pid}`);
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => log(String(chunk).trimEnd()));
		child.on("exit", (code) => {
			log(`keepalive: bridge exited with ${code}`);
			child = null;
			writeLock();
			if (!stopping) setTimeout(start, RESTART_MS);
		});
	};
	const stop = () => {
		stopping = true;
		try { if (child) child.kill(); } catch {}
		try { fs.rmSync(LOCK, { force: true }); } catch {}
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	start();
}
