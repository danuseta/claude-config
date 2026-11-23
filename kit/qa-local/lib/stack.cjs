"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ALWAYS_PROTECTED = ["3000", "3001", "5173", "5174", "5000", "3100", "13337", "13339", "8099", "27017", "6379", "1055"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "mongo", "redis"]);

function protectedPorts(extra = []) {
	return new Set([...ALWAYS_PROTECTED, ...extra.map(String)]);
}

function answers(port, host) {
	return new Promise((resolve) => {
		const s = net.connect({ port, host });
		const done = (v) => {
			s.destroy();
			resolve(v);
		};
		s.setTimeout(800, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

function canListen(port, host) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", (e) => resolve(e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL" ? null : false));
		srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
	});
}

async function isFree(port) {
	for (const host of ["127.0.0.1", "::1"]) if (await answers(port, host)) return false;
	for (const host of ["0.0.0.0", "::"]) if ((await canListen(port, host)) === false) return false;
	return true;
}

async function freePort(base, guard, avoid = [], span = 200) {
	for (let p = base; p < base + span; p++) {
		if (guard.has(String(p)) || avoid.includes(p)) continue;
		if (await isFree(p)) return p;
	}
	throw new Error(`no free port in ${base}-${base + span - 1}`);
}

function readEnvFile(file) {
	const values = {};
	if (!fs.existsSync(file)) return values;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (m) values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return values;
}

function mongoHosts(conn) {
	const m = String(conn || "").match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/);
	return m ? m[1].split(",").map((h) => h.trim().replace(/:\d+$/, "")) : null;
}

function urlHost(u) {
	try {
		return new URL(u).hostname;
	} catch {
		return null;
	}
}

function checkBackendEnv(beDir) {
	const file = path.join(beDir, ".env");
	const env = readEnvFile(file);
	if (!Object.keys(env).length) return [`no ${file}; the backend cannot start without it`];
	const out = [];
	const hosts = mongoHosts(env.MONGO_CONN_STRING);
	if (!hosts || !hosts.every((h) => LOCAL_HOSTS.has(h))) out.push(`MONGO_CONN_STRING in ${file} does not point at this machine`);
	if (env.REDIS_HOST && !LOCAL_HOSTS.has(env.REDIS_HOST)) out.push(`REDIS_HOST in ${file} is not this machine`);
	if (env.REDIS_URL && !LOCAL_HOSTS.has(urlHost(env.REDIS_URL))) out.push(`REDIS_URL in ${file} is not this machine`);
	return out;
}

function backendEnv(beDir, port) {
	const fileEnv = readEnvFile(path.join(beDir, ".env"));
	const env = { ...process.env };
	for (const k of Object.keys(fileEnv)) if (k !== "PORT") delete env[k];
	env.PORT = String(port);
	return env;
}

function isLocalUrl(u) {
	const h = urlHost(u);
	return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function start({ name, cwd, args, env, log, port, marker }) {
	const pnpm = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"));
	const cmd = pnpm ? "pnpm" : "npx";
	const argv = pnpm ? ["exec", ...args] : ["--no", "--", ...args];
	const fd = fs.openSync(log, "a");
	const child = spawn(cmd, argv, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
	fs.closeSync(fd);
	if (!child.pid) throw new Error(`${name}: could not start ${cmd} in ${cwd}`);
	const proc = {
		name,
		pid: child.pid,
		pgid: child.pid,
		cwd: fs.realpathSync(cwd),
		cmd: [cmd, ...argv].join(" "),
		log,
		port,
		marker,
		startedAt: new Date().toISOString(),
		exited: null,
	};
	child.on("exit", (code, signal) => {
		proc.exited = { code, signal };
	});
	child.on("error", (e) => {
		proc.exited = { code: null, signal: null, error: e.message };
	});
	child.unref();
	return proc;
}

function record(runDir, procs) {
	const plain = procs.map(({ name, pid, pgid, cwd, cmd, log, port, marker, startedAt }) => ({ name, pid, pgid, cwd, cmd, log, port, marker, startedAt }));
	fs.writeFileSync(path.join(runDir, "stack.json"), JSON.stringify(plain, null, 2) + "\n");
}

async function waitHttp(url, proc, { timeoutMs, ok }) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (proc.exited) throw new Error(`${proc.name} exited before it answered on ${url} (code ${proc.exited.code}, signal ${proc.exited.signal}${proc.exited.error ? ", " + proc.exited.error : ""}); see ${proc.log}`);
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
			if (ok(res.status)) return res.status;
		} catch {}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`${proc.name} did not answer on ${url} within ${Math.round(timeoutMs / 1000)} s; see ${proc.log}`);
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function groupMembers(pgid) {
	const out = [];
	let entries = [];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return out;
	}
	for (const d of entries) {
		if (!/^\d+$/.test(d)) continue;
		try {
			const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
			const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (rest[0] !== "Z" && Number(rest[2]) === pgid) out.push(Number(d));
		} catch {}
	}
	return out;
}

function cwdOf(pid) {
	try {
		return fs.realpathSync(`/proc/${pid}/cwd`);
	} catch {
		return null;
	}
}

function ownsGroup(proc) {
	return groupMembers(proc.pgid).some((pid) => {
		const c = cwdOf(pid);
		return c && (c === proc.cwd || c.startsWith(proc.cwd + path.sep));
	});
}

function stopOne(proc, graceMs = 10000) {
	if (!proc.pgid || proc.pgid <= 1 || proc.pgid === process.pid) return `${proc.name}: not stopped, bad process group ${proc.pgid}`;
	if (!ownsGroup(proc)) return `${proc.name}: already stopped (pgid ${proc.pgid}, port ${proc.port})`;
	try {
		process.kill(-proc.pgid, "SIGTERM");
	} catch (e) {
		if (e.code !== "ESRCH") return `${proc.name}: SIGTERM failed: ${e.message}`;
	}
	const until = Date.now() + graceMs;
	while (Date.now() < until && groupMembers(proc.pgid).length) sleepSync(250);
	if (groupMembers(proc.pgid).length) {
		try {
			process.kill(-proc.pgid, "SIGKILL");
		} catch {}
		sleepSync(500);
		return `${proc.name}: stopped with SIGKILL (pgid ${proc.pgid}, port ${proc.port})`;
	}
	return `${proc.name}: stopped (pgid ${proc.pgid}, port ${proc.port})`;
}

function stopAll(procs) {
	return procs.slice().reverse().map((p) => stopOne(p));
}

function stopRecorded(runDir) {
	const file = path.join(runDir, "stack.json");
	if (!fs.existsSync(file)) return [`no ${file}`];
	return stopAll(JSON.parse(fs.readFileSync(file, "utf8")));
}

module.exports = {
	ALWAYS_PROTECTED,
	protectedPorts,
	isFree,
	freePort,
	readEnvFile,
	checkBackendEnv,
	backendEnv,
	isLocalUrl,
	start,
	record,
	waitHttp,
	stopOne,
	stopAll,
	stopRecorded,
	groupMembers,
};
