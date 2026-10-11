// ElevenLabs key rotation. One JSON store, round-robin on limit.
//   node el-rotate.cjs add <name>        prompt for the key (hidden), store under name
//   node el-rotate.cjs add <name> <key>  non-interactive form
//   node el-rotate.cjs list              show names + masked key + status
//   node el-rotate.cjs remove <name>     drop one entry
//   node el-rotate.cjs clear             empty the store
//   node el-rotate.cjs tts <text> [--voice ID]
//   node el-rotate.cjs get               print the key that will be used next
//
// Rotation: try the current key; on 401/402/403/429 or a quota/rate error,
// park it in cooldowns and move on to the next, until one succeeds or every
// key is parked. Store: elevenlabs-keys.json next to this file. Keys are
// never printed in full.
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const STORE_FILE = path.join(__dirname, "elevenlabs-keys.json");
const API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB";
const DEFAULT_MODEL = "eleven_multilingual_v2";
const LOCK_MAX_DEFAULT = 3600_000; // 1h if the API gives no retry hint
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function emptyStore() {
	return { keys: {}, order: [], current: 0, cooldowns: {} };
}

function load() {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
	} catch (_) {
		return emptyStore();
	}
	if (Array.isArray(data.keys)) return migrateFromArray(data);
	if (!data.keys || typeof data.keys !== "object") data.keys = {};
	if (!Array.isArray(data.order)) data.order = Object.keys(data.keys);
	if (typeof data.current !== "number") data.current = 0;
	if (!data.cooldowns || typeof data.cooldowns !== "object") data.cooldowns = {};
	return data;
}

// Old store shape: keys was an array of bare strings. Give them names.
function migrateFromArray(data) {
	const store = emptyStore();
	(data.keys || []).forEach((key, i) => {
		if (!key) return;
		const name = `key${i + 1}`;
		store.keys[name] = key;
		store.order.push(name);
	});
	store.current = 0;
	for (const [k, v] of Object.entries(data.cooldowns || {})) {
		const name = store.order.find((n) => store.keys[n] === k);
		if (name) store.cooldowns[name] = v;
	}
	return store;
}

function save(data) {
	fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2) + "\n");
}

function mask(key) {
	if (key.length <= 10) return key.slice(0, 3) + "***";
	return key.slice(0, 6) + "..." + key.slice(-4);
}

function lockedUntil(data, name) {
	const until = data.cooldowns[name];
	if (!until) return 0;
	if (until <= Date.now()) {
		delete data.cooldowns[name];
		return 0;
	}
	return until;
}

// Names usable right now, starting from data.current.
function usableOrder(data) {
	const n = data.order.length;
	const out = [];
	for (let i = 0; i < n; i++) {
		const idx = (data.current + i) % n;
		const name = data.order[idx];
		if (data.keys[name] && !lockedUntil(data, name)) out.push(idx);
	}
	return out;
}

function park(data, name, ms) {
	data.cooldowns[name] = Date.now() + (ms || LOCK_MAX_DEFAULT);
}

// Short reason from an error body: the ElevenLabs "code"/"type" if present.
function reasonOf(body) {
	try {
		const j = JSON.parse(body);
		const d = j && j.detail;
		if (d && typeof d === "object") return d.code || d.type || d.status || "";
		if (typeof d === "string") return d.slice(0, 60);
	} catch (_) {}
	return (body || "").slice(0, 60);
}

// Decide if a failed response means "this key is spent" vs a real error.
function isKeyExhausted(status, body) {
	if (status === 401 || status === 403 || status === 429) return true;
	if (status === 402) return true; // payment/quota
	const text = (body || "").toLowerCase();
	return (
		text.includes("quota") ||
		text.includes("rate limit") ||
		text.includes("too many requests") ||
		text.includes("insufficient") ||
		text.includes("credits")
	);
}

// Seconds hint from Retry-After or a "retry_after" field, else null.
function retryHintMs(body, headers) {
	const ra = headers && headers.get && headers.get("retry-after");
	if (ra) {
		const s = Number(ra);
		if (!Number.isNaN(s) && s > 0) return s * 1000;
	}
	try {
		const j = JSON.parse(body);
		const d = j && j.detail;
		if (d && typeof d.retry_after === "number") return d.retry_after * 1000;
	} catch (_) {}
	return null;
}

// Core: run fetchWith(key) across usable keys, rotating on exhaustion.
async function withRotation(fetchWith) {
	const data = load();
	if (data.order.length === 0) {
		throw new Error("no keys in store; run: elabs add <name>");
	}
	const order = usableOrder(data);
	if (order.length === 0) {
		throw new Error("all keys are parked; wait or add keys");
	}

	let lastErr;
	let changed = false;
	for (const idx of order) {
		const name = data.order[idx];
		const key = data.keys[name];
		let res;
		try {
			res = await fetchWith(key);
		} catch (err) {
			lastErr = err;
			continue;
		}
		if (res.ok) {
			if (data.current !== idx) {
				data.current = idx;
				changed = true;
			}
			if (changed) save(data);
			return { res, name };
		}
		const body = await res.text();
		if (isKeyExhausted(res.status, body)) {
			park(data, name, retryHintMs(body, res.headers));
			data.current = (idx + 1) % data.order.length;
			changed = true;
			lastErr = new Error(
				`${name} (${mask(key)}) -> HTTP ${res.status} ${reasonOf(body)}`.trim(),
			);
			continue;
		}
		// Non-key error (bad request etc): stop, do not burn keys.
		if (changed) save(data);
		return { res, name, body };
	}
	save(data);
	throw lastErr || new Error("all keys exhausted");
}

async function tts(text, voice) {
	const { res, name } = await withRotation((key) =>
		fetch(`${API_BASE}/text-to-speech/${voice}`, {
			method: "POST",
			headers: {
				"xi-api-key": key,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({ text, model_id: DEFAULT_MODEL }),
		}),
	);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`TTS failed HTTP ${res.status}: ${body}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	return { buf, name };
}

// Hidden prompt. Falls back to plain readline when stdin is not a TTY.
function promptKey(name) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		if (!process.stdin.isTTY) {
			rl.question(`API key for "${name}": `, (ans) => {
				rl.close();
				resolve(ans.trim());
			});
			return;
		}
		// Suppress echo: intercept the write used to redraw the line.
		const muted = () => {};
		const originalWrite = rl._writeToOutput;
		rl._writeToOutput = function (str) {
			if (str.includes("API key for")) originalWrite.call(rl, str);
			else muted();
		};
		rl.question(`API key for "${name}": `, (ans) => {
			rl.close();
			process.stdout.write("\n");
			resolve(ans.trim());
		});
	});
}

function parseArgs(argv) {
	const args = { pos: [], voice: DEFAULT_VOICE };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--voice") args.voice = argv[++i];
		else args.pos.push(argv[i]);
	}
	return args;
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);

	switch (cmd) {
		case "add": {
			const name = args.pos[0];
			if (!name) {
				console.error("usage: elabs add <name>   (leave key blank to be prompted)");
				process.exitCode = 1;
				break;
			}
			if (!NAME_RE.test(name)) {
				console.error("name must be letters, digits, dot, dash or underscore");
				process.exitCode = 1;
				break;
			}
			let key = args.pos[1];
			if (!key) key = await promptKey(name);
			if (!key) {
				console.error("no key entered");
				process.exitCode = 1;
				break;
			}
			const data = load();
			const existed = Boolean(data.keys[name]);
			data.keys[name] = key;
			if (!data.order.includes(name)) data.order.push(name);
			delete data.cooldowns[name];
			save(data);
			console.log(`${existed ? "updated" : "added"} "${name}" (${mask(key)}), total ${data.order.length}`);
			break;
		}
		case "list": {
			const data = load();
			if (data.order.length === 0) {
				console.log("(empty)");
				break;
			}
			data.order.forEach((name, i) => {
				const lock = lockedUntil(data, name);
				const mark = i === data.current ? " *current" : "";
				const state = lock
					? ` parked ${Math.ceil((lock - Date.now()) / 1000)}s`
					: " ready";
				console.log(`${i}\t${name}\t${mask(data.keys[name])}${mark}${state}`);
			});
			break;
		}
		case "remove": {
			const name = args.pos[0];
			const data = load();
			if (!data.keys[name]) {
				console.error(`no key named "${name}"`);
				process.exitCode = 1;
				break;
			}
			delete data.keys[name];
			delete data.cooldowns[name];
			data.order = data.order.filter((n) => n !== name);
			if (data.current >= data.order.length) data.current = 0;
			save(data);
			console.log(`removed "${name}", total ${data.order.length}`);
			break;
		}
		case "clear": {
			save(emptyStore());
			console.log("cleared");
			break;
		}
		case "get": {
			const data = load();
			const order = usableOrder(data);
			if (order.length === 0) {
				console.error("no usable key");
				process.exitCode = 1;
				break;
			}
			process.stdout.write(data.keys[data.order[order[0]]]);
			break;
		}
		case "tts": {
			const text = args.pos.join(" ");
			if (!text) {
				console.error("usage: elabs tts <text> [--voice ID]");
				process.exitCode = 1;
				break;
			}
			const { buf, name } = await tts(text, args.voice);
			const out = path.join(process.cwd(), "el-tts.mp3");
			fs.writeFileSync(out, buf);
			console.log(`wrote ${out} (${buf.length} bytes) using "${name}"`);
			break;
		}
		default:
			console.log(
				[
					"ElevenLabs key rotation",
					"  add <name> [key]    store a key under a label (prompts if key omitted)",
					"  list                show names + masked key + status",
					"  remove <name>       drop one entry",
					"  clear               empty store",
					"  get                 print next usable key",
					"  tts <text> [--voice ID]",
				].join("\n"),
			);
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exitCode = 1;
});
