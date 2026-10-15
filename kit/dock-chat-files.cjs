'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILES_DIR = 'dock-chat-files';
const MAX_FILES = 4;
const IMAGE_BYTES = 5 * 1024 * 1024;
const FILE_BYTES = 8 * 1024 * 1024;
const TRIES = 2;
const FETCH_TIMEOUT_MS = 60000;
const NAME_MAX = 80;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const TOTAL_MAX_BYTES = 500 * 1024 * 1024;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function safeName(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop();
  const kept = base.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
  if (!kept) return 'file';
  if (kept.length <= NAME_MAX) return kept;
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(kept);
  const tail = ext ? ext[0] : '';
  return kept.slice(0, NAME_MAX - tail.length) + tail;
}

const segment = (value) => {
  const kept = String(value == null ? '' : value).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80).replace(/[. ]+$/, '');
  if (!kept) return '_';
  return DEVICE_NAME.test(kept) ? `_${kept}` : kept;
};

const logId = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function download(att, msg, sendBinary, cap) {
  let last = 'no answer';
  for (let attempt = 0; attempt < TRIES; attempt++) {
    try {
      const r = await sendBinary('/chat/attachment', { sessionId: msg.sessionId, replyTo: msg.id, id: att.id }, FETCH_TIMEOUT_MS, cap);
      if (!r || r.skipped) return { error: 'DOCK is not configured' };
      if (r.status !== 200) { last = `status ${r.status}`; if (r.status >= 400 && r.status < 500) break; continue; }
      const declared = Number(r.headers && r.headers['content-length']);
      if (Number.isFinite(declared) && declared !== att.size) return { error: 'size mismatch' };
      if (r.buffer.length !== att.size) return { error: 'size mismatch' };
      const header = r.headers && r.headers['x-dock-sha256'];
      const digest = sha256(r.buffer);
      if (digest !== att.sha256 || (header && header !== digest)) return { error: 'hash mismatch' };
      return { buffer: r.buffer };
    } catch (e) {
      last = e && e.message ? e.message : 'request failed';
    }
  }
  return { error: last };
}

function writeFresh(file, buffer) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let stale = null;
  try { stale = fs.lstatSync(file); } catch {}
  if (stale) {
    if (!stale.isFile()) throw new Error('refusing to write through a link');
    if (sha256(fs.readFileSync(file)) === sha256(buffer)) return;
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, flags, 0o600);
  try { fs.writeSync(fd, buffer); } finally { fs.closeSync(fd); }
}

function plainDirectory(dir) {
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('refusing to use a link as a folder');
}

async function fetchAttachments(msg, { sendBinary, stateDir, log = () => {} }) {
  const list = msg && Array.isArray(msg.attachments) ? msg.attachments : [];
  if (!list.length) return { dir: null, files: [], failed: [] };
  const dir = path.join(stateDir, FILES_DIR, segment(msg.sessionId));
  const target = path.join(dir, segment(msg.id));
  const out = { dir: target, files: [], failed: [] };
  fs.mkdirSync(target, { recursive: true });
  for (const folder of [path.join(stateDir, FILES_DIR), dir, target]) plainDirectory(folder);
  for (const [i, att] of list.entries()) {
    const name = safeName(att && att.name);
    const fail = (reason) => { out.failed.push(name); log(`attachment ${logId(att && att.id)} (${name}) refused: ${reason}`); };
    if (i >= MAX_FILES) { fail('more than 4 files'); continue; }
    const image = IMAGE_MIMES.has(att.mime);
    const cap = image ? IMAGE_BYTES : FILE_BYTES;
    if (!Number.isInteger(att.size) || att.size < 0 || att.size > cap) { fail('size over the limit'); continue; }
    const got = await download(att, msg, sendBinary, cap);
    if (!got.buffer) { fail(got.error); continue; }
    const file = path.join(target, `${i + 1}-${name}`);
    try {
      writeFresh(file, got.buffer);
    } catch (e) {
      try { fs.rmSync(file, { force: true }); } catch {}
      fail('could not write the file');
      continue;
    }
    out.files.push({ path: file, name, mime: String(att.mime), size: att.size, image, base64: image ? got.buffer.toString('base64') : null });
    log(`attachment ${logId(att.id)} (${name}) saved, ${att.size} bytes`);
  }
  return out;
}

function attachmentNote(result) {
  const lines = [];
  if (result.files.length) {
    lines.push('Attached files (saved on this machine):');
    for (const f of result.files) lines.push(`- ${f.path} (${f.mime}, ${f.size} bytes)`);
  }
  if (result.failed.length) lines.push(`Could not be downloaded: ${result.failed.join(', ')}`);
  return lines.join('\n');
}

function treeInfo(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) bytes += fs.statSync(full).size;
    }
  };
  try { walk(dir); } catch {}
  return bytes;
}

function pruneFiles(stateDir, now) {
  const root = path.join(stateDir, FILES_DIR);
  const at = Number(now);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try { folders.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch {}
  }
  const remove = (f) => { try { fs.rmSync(f.full, { recursive: true, force: true }); } catch {} };
  const kept = [];
  for (const f of folders) (at - f.mtime > KEEP_MS ? remove : (x) => kept.push(x))(f);
  kept.sort((a, b) => a.mtime - b.mtime);
  let total = kept.reduce((n, f) => { f.bytes = treeInfo(f.full); return n + f.bytes; }, 0);
  for (const f of kept) {
    if (total <= TOTAL_MAX_BYTES) break;
    remove(f);
    total -= f.bytes;
  }
}

const ATTACH_BYTES = 10 * 1024 * 1024;
const ATTACH_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain', html: 'text/html', zip: 'application/zip' };

// A file the agent asked to send with a DOCK_ATTACH line: it must be a regular file inside cwd (after symlinks), small, and of a listed type.
function resolveAttach(requested, cwd) {
  try {
    const root = fs.realpathSync(cwd);
    const file = fs.realpathSync(path.resolve(root, String(requested)));
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'outside the working folder' };
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!ATTACH_TYPES[ext]) return { error: 'file type not allowed' };
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > ATTACH_BYTES) return { error: 'larger than 10 MB' };
    return { file, name: safeName(path.basename(file)), mime: ATTACH_TYPES[ext] };
  } catch (e) {
    return { error: e && e.code === 'ENOENT' ? 'not found' : 'not readable' };
  }
}

module.exports = { fetchAttachments, attachmentNote, pruneFiles, safeName, resolveAttach, ATTACH_BYTES };
