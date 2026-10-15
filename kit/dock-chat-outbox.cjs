'use strict';
// Deltas and uploads the bridge could not deliver within the outage window, kept on disk and resent by the main loop.
// One JSON file per entry in <stateDir>/dock-chat-outbox, oldest name first: { msg: { sessionId, id }, body, files: [{ name, mime, base64 }] }.
// body is null when only files are left. Bounded: past MAX_ENTRIES files or MAX_BYTES in total the oldest are dropped.
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 50;
const MAX_BYTES = 64 * 1024 * 1024;
let seq = 0;

const dirOf = (stateDir) => path.join(stateDir, 'dock-chat-outbox');
const names = (stateDir) => { try { return fs.readdirSync(dirOf(stateDir)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } };

function add(stateDir, { msg, body, files }, { log = () => {}, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
	const dir = dirOf(stateDir);
	fs.mkdirSync(dir, { recursive: true });
	let text = JSON.stringify({ msg, body, files: files.map((f) => ({ name: f.name, mime: f.mime, base64: Buffer.from(f.bytes).toString('base64') })) });
	if (text.length > maxBytes) { log(`outbox: files of message ${msg.id} are over the size bound and were dropped`); text = JSON.stringify({ msg, body, files: [] }); }
	const name = `${String(Date.now()).padStart(15, '0')}-${String(seq++ % 1e6).padStart(6, '0')}.json`;
	fs.writeFileSync(path.join(dir, `${name}.tmp`), text);
	fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
	const all = names(stateDir).map((n) => ({ n, size: fs.statSync(path.join(dir, n)).size }));
	let total = all.reduce((sum, e) => sum + e.size, 0);
	while (all.length > 1 && (all.length > maxEntries || total > maxBytes)) {
		const oldest = all.shift();
		total -= oldest.size;
		try { fs.rmSync(path.join(dir, oldest.n), { force: true }); } catch {}
		log(`outbox: over the bound, dropped the oldest entry ${oldest.n}`);
	}
}

const pending = (stateDir) => names(stateDir).length;

// Sends the entries in order through deliver(entry) -> Promise<true|false>; stops at the first one that is not delivered. One run at a time.
let running = false;
async function flush(stateDir, deliver, log = () => {}) {
	if (running || !pending(stateDir)) return 0;
	running = true;
	let sent = 0;
	try {
		for (const n of names(stateDir)) {
			const file = path.join(dirOf(stateDir), n);
			let entry;
			try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log(`outbox: unreadable entry ${n} removed`); try { fs.rmSync(file, { force: true }); } catch {} continue; }
			if (!entry || !entry.msg) { log(`outbox: entry ${n} has no message and was removed`); try { fs.rmSync(file, { force: true }); } catch {} continue; }
			const files = (Array.isArray(entry.files) ? entry.files : []).map((f) => ({ name: f.name, mime: f.mime, bytes: Buffer.from(String(f.base64), 'base64') }));
			if (!(await deliver({ msg: entry.msg, body: entry.body || null, files }))) break;
			try { fs.rmSync(file, { force: true }); } catch {}
			sent++;
		}
	} catch (e) { log(`outbox: ${e.message}`); } finally { running = false; }
	return sent;
}

module.exports = { add, flush, pending, dirOf, MAX_ENTRIES, MAX_BYTES };
