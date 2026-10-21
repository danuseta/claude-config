// Health of this machine for the DOCK + sous flow. Prints a table; never prints a secret value, only whether it is there.
//   node doctor.cjs            the table
//   node doctor.cjs --json     the report DOCK takes
//   node doctor.cjs --push     the table, then the report to DOCK's /doctor route (dock-push config)
// Checks: rtk, ffmpeg, ffprobe, dock-config, passEnv, hooks, playwright, chromium, s3-demo, demo-video, elevenlabs, node, python, and a WARN
// per agent file without a hooks block.
// A check with warn: true is not a failure (shown as WARN).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const PATHS = require("./paths.cjs").resolvePaths();

// A non-login shell on Linux leaves ~/.local/bin off PATH, where rtk and ffmpeg live on the workspace.
const probeEnv = () => {
	if (process.platform === "win32") return process.env;
	const extra = [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin")];
	const have = (process.env.PATH || "").split(path.delimiter);
	return { ...process.env, PATH: [...have, ...extra.filter((dir) => !have.includes(dir))].join(path.delimiter) };
};
const run = (cmd, args) => {
	try {
		const shim = process.platform === "win32" && cmd !== "git";
		const out = shim ? execSync(`${cmd} ${args.join(" ")}`, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) : execFileSync(cmd, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: probeEnv() });
		return { ok: true, out: String(out).trim().split(/\r?\n/)[0] };
	} catch (e) {
		return { ok: false, out: String(e.stderr || e.message || "").trim().split(/\r?\n/)[0] };
	}
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const tool = (name, args = ["--version"]) => {
	const r = run(name, args);
	return { name, ok: r.ok, detail: r.ok ? r.out : `not found or failed: ${r.out || name}` };
};

function kitVersion(kitDir) {
	const r = run("git", ["-C", path.dirname(kitDir), "rev-parse", "--short", "HEAD"]);
	if (r.ok && /^[0-9a-f]{6,}$/.test(r.out)) return r.out;
	try { return fs.statSync(path.join(kitDir, "status.cjs")).mtime.toISOString().slice(0, 10); } catch { return "unknown"; }
}

function dockConfig(kitDir, env) {
	const file = readJson(path.join(kitDir, "dock.json")) || {};
	const url = env.DOCK_INGEST_URL || file.url || "";
	const token = env.DOCK_INGEST_TOKEN || file.token || "";
	const from = env.DOCK_INGEST_URL ? "env" : fs.existsSync(path.join(kitDir, "dock.json")) ? "dock.json" : "nowhere";
	let host = "";
	try { host = new URL(url).host; } catch {}
	return { name: "dock-config", ok: Boolean(url && token), detail: url && token ? `url ${host} and a token, from ${from}` : `missing ${[!url && "url", !token && "token"].filter(Boolean).join(" and ")} (${from})` };
}

function passEnv(kitDir, env) {
	const file = readJson(env.DOCK_CHAT_CONFIG || path.join(kitDir, "dock-chat.json"));
	const names = Array.isArray(file?.passEnv) ? file.passEnv.map(String) : [];
	if (!file) return { name: "passEnv", ok: true, detail: "no dock-chat.json; nothing is passed to chat sessions" };
	const missing = names.filter((n) => !env[n]);
	return { name: "passEnv", ok: !missing.length, detail: names.length ? `${names.length - missing.length}/${names.length} set${missing.length ? `; missing: ${missing.join(", ")}` : ""}` : "empty list" };
}

function hooks(configDir) {
	const s = readJson(path.join(configDir, "settings.json"));
	if (!s) return { name: "hooks", ok: false, detail: `no readable settings.json in ${configDir}` };
	const commands = Object.values(s.hooks || {}).flat().flatMap((e) => (e.hooks || []).map((h) => String(h.command || "")));
	const want = { "guard.cjs": /guard\.cjs/, "dock-push.cjs hook": /dock-push\.cjs"?\s+hook/, "status.cjs sync": /status\.cjs"?\s+sync/ };
	const missing = Object.entries(want).filter(([, re]) => !commands.some((c) => re.test(c))).map(([n]) => n);
	const agents = fs.existsSync(path.join(configDir, "agents", "sous-ticket-runner.md")) && fs.existsSync(path.join(configDir, "kit", "sous-guard.cjs"));
	return { name: "hooks", ok: !missing.length && agents, detail: `${commands.length} hook commands${missing.length ? `; missing: ${missing.join(", ")}` : ""}${agents ? "; sous agents and sous-guard installed" : "; sous agents or sous-guard.cjs not installed"}` };
}

// One WARN per agent file without a hooks block: no sous-guard narrows what it may do. DOCK takes at most 40 checks, so past 20 one row sums up.
function agentHooks(configDir) {
	let names = [];
	try { names = fs.readdirSync(path.join(configDir, "agents")).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
	const bare = names.filter((f) => {
		let text = "";
		try { text = fs.readFileSync(path.join(configDir, "agents", f), "utf8").replace(/\r\n/g, "\n"); } catch {}
		const head = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text);
		return !(head && /^hooks:/m.test(head[1]) && /^\s+command:/m.test(head[1]));
	});
	const rows = bare.slice(0, 20).map((f) => ({ name: `agent ${f.slice(0, -3)}`.slice(0, 40), ok: true, warn: true, detail: `agents/${f} has no hooks block; no sous-guard narrows its tools` }));
	if (bare.length > 20) rows.push({ name: "agent hooks", ok: true, warn: true, detail: `${bare.length - 20} more agent files without a hooks block` });
	return rows;
}

function chromium(env, home) {
	const dirs = [env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, "AppData", "Local", "ms-playwright"), path.join(home, ".cache", "ms-playwright"), path.join(home, "Library", "Caches", "ms-playwright")].filter(Boolean);
	for (const d of dirs) {
		let found = [];
		try { found = fs.readdirSync(d).filter((n) => /^(chromium|chrome)/.test(n)); } catch {}
		if (found.length) return { name: "chromium", ok: true, detail: `${found.sort().pop()} in ${d.replace(/\\/g, "/")}` };
	}
	const chrome = process.platform === "win32" ? ["C:/Program Files/Google/Chrome/Application/chrome.exe"] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
	const hit = chrome.find((c) => fs.existsSync(c));
	return hit ? { name: "chromium", ok: true, detail: `installed Chrome at ${hit}` } : { name: "chromium", ok: false, detail: "no Playwright Chromium and no installed Chrome" };
}

function s3Demo(kitDir, dock) {
	const script = fs.existsSync(path.join(kitDir, "demo-upload.cjs"));
	const ok = script && dock.ok;
	return { name: "s3-demo", ok, detail: ok ? "demo-upload.cjs present; the upload goes through DOCK /demo-video, which holds the bucket" : `${script ? "" : "demo-upload.cjs missing; "}${dock.ok ? "" : "DOCK not configured, so no upload"}`.replace(/; $/, "") };
}

function demoSkill(root, configDir) {
	const found = [path.join(root, ".claude", "skills", "demo-video"), path.join(configDir, "skills", "demo-video")].find((d) => fs.existsSync(path.join(d, "SKILL.md")));
	return found ? { name: "demo-video", ok: true, detail: `skill at ${found.replace(/\\/g, "/")}` } : { name: "demo-video", ok: false, detail: `no demo-video/SKILL.md under ${root}/.claude/skills or ${configDir}/skills`.replace(/\\/g, "/") };
}

// Asks el-rotate.cjs for the next key in a child and keeps only whether one came back; the key never leaves this function.
function elKeyOf(kitDir, env) {
	try {
		const out = execFileSync(process.execPath, [path.join(kitDir, "el-rotate.cjs"), "get"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
		return { ok: out.trim().length > 0, error: "no key returned" };
	} catch (e) {
		return { ok: false, error: String(e.stderr || e.message || "").trim().split(/\r?\n/)[0] };
	}
}

function elevenlabs(kitDir, env, dock, elKey) {
	if (!dock.ok) return { name: "elevenlabs", ok: true, warn: true, detail: "DOCK not configured; the ElevenLabs keys live in DOCK" };
	const r = elKey(kitDir, env);
	return { name: "elevenlabs", ok: r.ok, detail: r.ok ? "el-rotate.cjs get gives a key" : `el-rotate.cjs get: ${r.error}` };
}

function report({ env = process.env, kitDir = PATHS.kitDir, configDir = PATHS.configDir, root = PATHS.root, home = os.homedir(), probe = tool, elKey = elKeyOf } = {}) {
	const dock = dockConfig(kitDir, env);
	const python = process.platform === "win32" ? probe("python") : probe("python3");
	const checks = [
		probe("rtk"),
		probe("ffmpeg", ["-version"]),
		probe("ffprobe", ["-version"]),
		dock,
		passEnv(kitDir, env),
		hooks(configDir),
		{ ...probe("playwright-cli"), name: "playwright" },
		chromium(env, home),
		s3Demo(kitDir, dock),
		demoSkill(root, configDir),
		elevenlabs(kitDir, env, dock, elKey),
		{ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: `v${process.versions.node}` },
		{ ...python, name: "python" },
		...agentHooks(configDir),
	];
	return { machine: os.hostname(), os: process.platform, at: new Date().toISOString(), kitVersion: kitVersion(kitDir), checks };
}

function table(r) {
	const rows = r.checks.map((c) => `| ${c.name} | ${c.warn ? "WARN" : c.ok ? "ok" : "FAIL"} | ${String(c.detail).replace(/\|/g, "\\|")} |`);
	return [`doctor ${r.machine} (${r.os}) kit ${r.kitVersion}`, "| Check | State | Detail |", "|---|---|---|", ...rows].join("\n");
}

module.exports = { report, table };

if (require.main === module) {
	const r = report();
	if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
	else console.log(table(r));
	if (process.argv.includes("--push")) {
		require("./dock-push.cjs").send("/doctor", r, 15000).then((res) => {
			if (res.skipped) { console.log("push: DOCK is not configured"); process.exitCode = 1; }
			else if (res.status !== 200) { console.log(`push: DOCK refused the report: ${res.status}${res.error ? " " + res.error : ""}`); process.exitCode = 1; }
			else console.log("push: sent to DOCK /doctor");
		}).catch((e) => { console.log(`push: could not reach DOCK: ${e.message}`); process.exitCode = 1; });
	}
}
