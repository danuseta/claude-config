// Downloads the files of one Discord thread through DOCK, which holds the bot token (Settings), so an agent can read
// evidence a teammate posted (a PDF, a screenshot) without any Discord credential of its own.
//   node discord-files.cjs <thread id | discord.com/channels/... link> [out dir, default ./discord-<thread id>]
// Prints each message (author, time, text) and the saved path of every file. The DOCK ingest URL and token come from
// the environment, kit/dock.json, or on Linux ~/.config/claude-config/secrets.env; they are never printed.
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function threadIdOf(input) {
	const text = String(input || "").trim();
	const link = text.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)/);
	const id = link ? link[1] : text;
	return /^\d{5,25}$/.test(id) ? id : null;
}

function envFile(file) {
	const values = {};
	try {
		for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
			const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
			if (m) values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
		}
	} catch {}
	return values;
}

function dockConfig(env = process.env, home = os.homedir()) {
	let file = {};
	try { file = JSON.parse(fs.readFileSync(path.join(__dirname, "dock.json"), "utf8")); } catch {}
	const secrets = process.platform === "win32" ? {} : envFile(path.join(home, ".config", "claude-config", "secrets.env"));
	const url = (env.DOCK_INGEST_URL || file.url || secrets.DOCK_INGEST_URL || "").replace(/\/+$/, "");
	const token = env.DOCK_INGEST_TOKEN || file.token || secrets.DOCK_INGEST_TOKEN || "";
	return url && token ? { url, token } : null;
}

// A file name that stays inside the out dir; two files with one name get a number.
function safeName(name, taken) {
	const base = String(name || "file").split(/[\\/]/).pop().replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || "file";
	let out = base;
	for (let n = 2; taken.has(out); n += 1) out = base.replace(/(\.[^.]*)?$/, `-${n}$1`);
	taken.add(out);
	return out;
}

async function main() {
	const id = threadIdOf(process.argv[2]);
	if (!id) {
		console.error("usage: node discord-files.cjs <thread id | discord.com/channels/<server>/<thread> link> [out dir]");
		process.exit(1);
	}
	const cfg = dockConfig();
	if (!cfg) {
		console.error("DOCK is not configured on this machine (DOCK_INGEST_URL and DOCK_INGEST_TOKEN)");
		process.exit(1);
	}
	const res = await fetch(`${cfg.url}/discord-thread`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
		body: JSON.stringify({ threadId: id }),
		signal: AbortSignal.timeout(30000),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || !json.result) {
		console.error(`DOCK answered ${res.status}${json.error ? `: ${json.error}` : ""}`);
		process.exit(1);
	}
	const out = path.resolve(process.argv[3] || `discord-${id}`);
	fs.mkdirSync(out, { recursive: true });
	const taken = new Set();
	let saved = 0;
	for (const message of json.result.messages) {
		console.log(`[${message.at}] ${message.author}: ${message.text || "(no text)"}`);
		for (const file of message.files) {
			if (file.size > MAX_FILE_BYTES) { console.log(`  skipped ${file.name}: larger than 25 MB`); continue; }
			const dl = await fetch(file.url, { signal: AbortSignal.timeout(60000) });
			if (!dl.ok) { console.log(`  failed ${file.name}: ${dl.status}`); continue; }
			const target = path.join(out, safeName(file.name, taken));
			fs.writeFileSync(target, Buffer.from(await dl.arrayBuffer()));
			console.log(`  saved ${target}`);
			saved += 1;
		}
	}
	console.log(`${saved} file(s) in ${out}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
else module.exports = { threadIdOf, dockConfig, safeName };
