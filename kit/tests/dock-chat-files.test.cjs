'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { KIT, tmp, rmrf } = require('./helpers.cjs');

const files = require(path.join(KIT, 'dock-chat-files.cjs'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const att = (id, name, mime, bytes) => ({ id, name, mime, size: bytes.length, sha256: sha(bytes) });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function store(map) {
  const calls = [];
  const sendBinary = async (route, body) => {
    calls.push({ route, body });
    const entry = map[body.id];
    return entry ? { status: 200, buffer: entry, headers: { 'content-length': String(entry.length) } } : { status: 404, buffer: Buffer.from('{}'), headers: {} };
  };
  return { sendBinary, calls };
}

test('safeName keeps [A-Za-z0-9._-] of the basename, at most 80 chars, never a path', () => {
  assert.equal(files.safeName('../../etc/passwd'), 'passwd');
  assert.equal(files.safeName('C:\\Users\\x\\my file (1).png'), 'myfile1.png');
  assert.equal(files.safeName('..'), 'file');
  assert.equal(files.safeName('.hidden'), 'hidden');
  assert.equal(files.safeName(''), 'file');
  assert.equal(files.safeName(undefined), 'file');
  const long = files.safeName(`${'a'.repeat(200)}.png`);
  assert.ok(long.length <= 80);
  assert.ok(long.endsWith('.png'));
  assert.ok(!/[\\/]/.test(files.safeName('a/b\\c')));
});

test('fetchAttachments downloads into <state>/dock-chat-files/<session>/<message>/<n>-<name>, images get base64', async () => {
  const state = tmp('files-ok');
  try {
    const text = Buffer.from('hello notes');
    const s = store({ a1: PNG, a2: text });
    const msg = { id: 77, sessionId: 'sess-1', attachments: [att('a1', 'shot.png', 'image/png', PNG), att('a2', '../../notes.md', 'text/markdown', text)] };
    const r = await files.fetchAttachments(msg, { sendBinary: s.sendBinary, stateDir: state, log: () => {} });
    assert.deepEqual(s.calls, [
      { route: '/chat/attachment', body: { sessionId: 'sess-1', replyTo: 77, id: 'a1' } },
      { route: '/chat/attachment', body: { sessionId: 'sess-1', replyTo: 77, id: 'a2' } },
    ]);
    const base = path.join(state, 'dock-chat-files', 'sess-1');
    assert.equal(r.dir, path.join(base, '77'));
    assert.deepEqual(r.failed, []);
    assert.equal(r.files.length, 2);
    assert.equal(r.files[0].path, path.join(base, '77', '1-shot.png'));
    assert.equal(r.files[0].name, 'shot.png');
    assert.equal(r.files[0].image, true);
    assert.equal(r.files[0].base64, PNG.toString('base64'));
    assert.equal(r.files[0].mime, 'image/png');
    assert.equal(r.files[0].size, PNG.length);
    assert.equal(r.files[1].path, path.join(base, '77', '2-notes.md'));
    assert.equal(r.files[1].image, false);
    assert.equal(r.files[1].base64, null);
    assert.deepEqual(fs.readFileSync(r.files[1].path), text);
  } finally { rmrf(state); }
});

test('hash mismatch, size mismatch, bad status and oversize are refused and nothing is left on disk', async () => {
  const state = tmp('files-bad');
  try {
    const good = Buffer.from('good');
    const s = store({ h: Buffer.from('tampered'), z: Buffer.from('short'), g: good, big: Buffer.alloc(10) });
    const bigImage = { id: 'big', name: 'huge.png', mime: 'image/png', size: 5 * 1024 * 1024 + 1, sha256: sha(Buffer.alloc(10)) };
    const msg = { id: 1, sessionId: 's', attachments: [
      { id: 'h', name: 'a.txt', mime: 'text/plain', size: 8, sha256: sha(Buffer.from('original')) },
      { id: 'z', name: 'b.txt', mime: 'text/plain', size: 99, sha256: sha(Buffer.from('short')) },
      { id: 'missing', name: 'c.txt', mime: 'text/plain', size: 3, sha256: sha(Buffer.from('abc')) },
      att('g', 'ok.txt', 'text/plain', good),
    ] };
    const r = await files.fetchAttachments(msg, { sendBinary: s.sendBinary, stateDir: state, log: () => {} });
    assert.deepEqual(r.files.map((f) => path.basename(f.path)), ['4-ok.txt']);
    assert.deepEqual(r.failed, ['a.txt', 'b.txt', 'c.txt']);
    assert.deepEqual(fs.readdirSync(path.join(state, 'dock-chat-files', 's', '1')), ['4-ok.txt']);
    const big = await files.fetchAttachments({ id: 2, sessionId: 's', attachments: [bigImage] }, { sendBinary: s.sendBinary, stateDir: state, log: () => {} });
    assert.deepEqual(big.failed, ['huge.png']);
    assert.equal(s.calls.filter((c) => c.body.id === 'big').length, 0);
  } finally { rmrf(state); }
});

test('two tries per file, a throw on the first is retried', async () => {
  const state = tmp('files-retry');
  try {
    const body = Buffer.from('retry me');
    let n = 0;
    const sendBinary = async () => { n++; if (n === 1) throw new Error('timeout'); return { status: 200, buffer: body, headers: {} }; };
    const r = await files.fetchAttachments({ id: 2, sessionId: 's', attachments: [att('r', 'r.txt', 'text/plain', body)] }, { sendBinary, stateDir: state, log: () => {} });
    assert.equal(n, 2);
    assert.equal(r.files.length, 1);
    let m = 0;
    const never = async () => { m++; throw new Error('down'); };
    const f = await files.fetchAttachments({ id: 3, sessionId: 's', attachments: [att('r', 'r.txt', 'text/plain', body)] }, { sendBinary: never, stateDir: state, log: () => {} });
    assert.equal(m, 2);
    assert.deepEqual(f.failed, ['r.txt']);
    assert.deepEqual(f.files, []);
  } finally { rmrf(state); }
});

test('at most 4 files per message; the rest are reported as failed', async () => {
  const state = tmp('files-cap');
  try {
    const b = Buffer.from('x');
    const list = [1, 2, 3, 4, 5, 6].map((i) => att(`f${i}`, `f${i}.txt`, 'text/plain', b));
    const s = store(Object.fromEntries(list.map((a) => [a.id, b])));
    const r = await files.fetchAttachments({ id: 9, sessionId: 's', attachments: list }, { sendBinary: s.sendBinary, stateDir: state, log: () => {} });
    assert.equal(r.files.length, 4);
    assert.deepEqual(r.failed, ['f5.txt', 'f6.txt']);
    assert.equal(s.calls.length, 4);
  } finally { rmrf(state); }
});

test('no attachments: dir null, nothing requested; unsafe session and message values never escape the files folder', async () => {
  const state = tmp('files-none');
  try {
    const s = store({});
    for (const msg of [{ id: 1, sessionId: 's' }, { id: 1, sessionId: 's', attachments: [] }, null]) {
      const r = await files.fetchAttachments(msg, { sendBinary: s.sendBinary, stateDir: state, log: () => {} });
      assert.deepEqual(r, { dir: null, files: [], failed: [] });
    }
    assert.equal(s.calls.length, 0);
    const b = Buffer.from('x');
    const s2 = store({ a: b });
    const r = await files.fetchAttachments({ id: '../9', sessionId: '../../outside', attachments: [att('a', 'a.txt', 'text/plain', b)] }, { sendBinary: s2.sendBinary, stateDir: state, log: () => {} });
    const root = path.join(state, 'dock-chat-files') + path.sep;
    assert.ok(r.dir.startsWith(root));
    assert.ok(r.files[0].path.startsWith(root));
    assert.equal(s2.calls[0].body.sessionId, '../../outside');
  } finally { rmrf(state); }
});

test('log lines carry names, sizes and ids only, never file bytes', async () => {
  const state = tmp('files-log');
  try {
    const lines = [];
    const secret = Buffer.from('SECRET-CONTENT-123');
    const s = store({ a: secret });
    await files.fetchAttachments({ id: 4, sessionId: 's', attachments: [att('a', 'a.txt', 'text/plain', secret), att('gone', 'gone.txt', 'text/plain', secret)] }, { sendBinary: s.sendBinary, stateDir: state, log: (l) => lines.push(String(l)) });
    assert.ok(lines.length > 0);
    assert.ok(!lines.join('\n').includes('SECRET-CONTENT'));
  } finally { rmrf(state); }
});

test('attachmentNote lists every saved file with path, mime and size, and the failures', () => {
  assert.equal(files.attachmentNote({ dir: null, files: [], failed: [] }), '');
  const note = files.attachmentNote({
    dir: '/d',
    files: [{ path: '/d/1/1-a.png', name: 'a.png', mime: 'image/png', size: 16, image: true, base64: 'AAAA' }, { path: '/d/1/2-n.md', name: 'n.md', mime: 'text/markdown', size: 11, image: false, base64: null }],
    failed: ['x.pdf'],
  });
  assert.equal(note, 'Attached files (saved on this machine):\n- /d/1/1-a.png (image/png, 16 bytes)\n- /d/1/2-n.md (text/markdown, 11 bytes)\nCould not be downloaded: x.pdf');
  assert.equal(files.attachmentNote({ dir: null, files: [], failed: ['x.pdf', 'y.txt'] }), 'Could not be downloaded: x.pdf, y.txt');
  assert.ok(!note.includes('AAAA'));
});

function makeSession(root, name, ageDays, bytes, now) {
  const dir = path.join(root, name, '1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'f.bin'), Buffer.alloc(bytes));
  const when = new Date(now - ageDays * 86400000);
  fs.utimesSync(dir, when, when);
  fs.utimesSync(path.join(root, name), when, when);
}

test('pruneFiles deletes session folders untouched for 7 days and keeps fresh ones', () => {
  const state = tmp('files-prune');
  try {
    const now = Date.now();
    const root = path.join(state, 'dock-chat-files');
    makeSession(root, 'old', 8, 10, now);
    makeSession(root, 'fresh', 1, 10, now);
    files.pruneFiles(state, new Date(now));
    assert.deepEqual(fs.readdirSync(root), ['fresh']);
    files.pruneFiles(path.join(state, 'nothing-here'), now);
  } finally { rmrf(state); }
});

test('pruneFiles drops the oldest folders first while the total is over 500 MB', () => {
  const state = tmp('files-prune-size');
  try {
    const now = Date.now();
    const root = path.join(state, 'dock-chat-files');
    const mb = 1024 * 1024;
    makeSession(root, 'a-oldest', 3, 200 * mb, now);
    makeSession(root, 'b-middle', 2, 200 * mb, now);
    makeSession(root, 'c-newest', 1, 200 * mb, now);
    files.pruneFiles(state, now);
    assert.deepEqual(fs.readdirSync(root).sort(), ['b-middle', 'c-newest']);
  } finally { rmrf(state); }
});

test('works with the real sendBinary against a local fake DOCK (token never reaches the log)', async () => {
  const state = tmp('files-real');
  const body = Buffer.from('over the wire');
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'x-dock-sha256': sha(body) });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const keys = ['DOCK_INGEST_URL', 'DOCK_INGEST_TOKEN', 'DOCK_PROXY', 'DOCK_KIT_STATE_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.DOCK_INGEST_URL = `http://127.0.0.1:${server.address().port}/ingest/orchestrator`;
  process.env.DOCK_INGEST_TOKEN = 'dock_ing_secret_token_value';
  delete process.env.DOCK_PROXY;
  process.env.DOCK_KIT_STATE_DIR = state;
  try {
    const { sendBinary } = require(path.join(KIT, 'dock-push.cjs'));
    const lines = [];
    const r = await files.fetchAttachments({ id: 5, sessionId: 'sx', attachments: [att('w', 'wire.txt', 'text/plain', body)] }, { sendBinary: (route, b) => sendBinary(route, b, 5000), stateDir: state, log: (l) => lines.push(String(l)) });
    assert.equal(r.files.length, 1);
    assert.deepEqual(fs.readFileSync(r.files[0].path), body);
    assert.equal(seen[0].url, '/ingest/orchestrator/chat/attachment');
    assert.equal(seen[0].auth, 'Bearer dock_ing_secret_token_value');
    assert.ok(!lines.join('\n').includes('secret_token'));
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    rmrf(state);
  }
});
