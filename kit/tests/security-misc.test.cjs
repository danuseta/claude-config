'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf } = require('./helpers.cjs');

const files = require(path.join(KIT, 'dock-chat-files.cjs'));
const catalog = require(path.join(KIT, 'dock-chat-catalog.cjs'));
const chat = require(path.join(KIT, 'dock-chat.cjs'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const att = (id, name, bytes) => ({ id, name, mime: 'text/plain', size: bytes.length, sha256: sha(bytes) });
const body = Buffer.from('hello');
const sendBinary = async () => ({ status: 200, buffer: body, headers: { 'content-length': String(body.length) } });

test('a session or message id that is a Windows device name or ends in dots or spaces becomes a plain folder name', async () => {
  const state = tmp('files-dev');
  try {
    for (const [sessionId, id] of [['CON', 'nul'], ['com1.', 'LPT1.txt'], ['aux  ', 'x. . ']]) {
      const r = await files.fetchAttachments({ id, sessionId, attachments: [att('a', 'n.txt', body)] }, { sendBinary, stateDir: state });
      assert.equal(r.files.length, 1, JSON.stringify(r.failed));
      const rel = path.relative(path.join(state, 'dock-chat-files'), r.dir).split(path.sep);
      assert.equal(rel.length, 2);
      for (const part of rel) {
        assert.ok(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(part), part);
        assert.ok(!/[. ]$/.test(part), part);
        assert.ok(part.length > 0);
      }
    }
  } finally { rmrf(state); }
});

const plant = (outside, target, types) => {
  for (const type of types) {
    try { fs.symlinkSync(outside, target, type); return type; } catch {}
  }
  return null;
};

test('a file is created exclusively and never written through a hard link or a stale file planted at its path', async () => {
  const state = tmp('files-hard');
  try {
    const msg = { id: 5, sessionId: 's', attachments: [att('a', 'n.txt', body)] };
    const first = await files.fetchAttachments(msg, { sendBinary, stateDir: state });
    const target = first.files[0].path;
    const outside = path.join(state, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    fs.rmSync(target);
    fs.linkSync(outside, target);
    const again = await files.fetchAttachments(msg, { sendBinary, stateDir: state });
    assert.equal(again.files.length, 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep', 'the planted link target is untouched');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    assert.equal(fs.statSync(target).nlink, 1, 'the file at the path is a fresh one, not the planted link');
    fs.writeFileSync(target, 'stale');
    const third = await files.fetchAttachments(msg, { sendBinary, stateDir: state });
    assert.equal(third.files.length, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  } finally { rmrf(state); }
});

test('a file is never written through a symlink planted at its path', async (t) => {
  const state = tmp('files-link');
  try {
    const msg = { id: 5, sessionId: 's', attachments: [att('a', 'n.txt', body)] };
    const first = await files.fetchAttachments(msg, { sendBinary, stateDir: state });
    const target = first.files[0].path;
    const outside = path.join(state, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    fs.rmSync(target);
    if (!plant(outside, target, ['file'])) return t.skip('this host cannot create a file symlink (Windows without Developer Mode); the exclusive-create behaviour is asserted by the hard link test');
    const again = await files.fetchAttachments(msg, { sendBinary, stateDir: state });
    assert.equal(again.files.length, 0);
    assert.deepEqual(again.failed, ['n.txt']);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  } finally { rmrf(state); }
});

test('a folder that is a link or junction is refused and nothing is written through it', async (t) => {
  const state = tmp('files-dirlink');
  try {
    const msg = { id: 5, sessionId: 's', attachments: [att('a', 'n.txt', body)] };
    const first = await files.fetchAttachments(msg, { sendBinary, stateDir: state });
    const outside = path.join(state, 'outside-dir');
    fs.mkdirSync(outside);
    fs.rmSync(first.dir, { recursive: true, force: true });
    const kind = plant(outside, first.dir, process.platform === 'win32' ? ['dir', 'junction'] : ['dir']);
    if (!kind) return t.skip('this host cannot create a directory link or junction');
    await assert.rejects(() => files.fetchAttachments(msg, { sendBinary, stateDir: state }), /link/);
    assert.deepEqual(fs.readdirSync(outside), [], `${kind}: nothing written outside`);
  } finally { rmrf(state); }
});

test('childEnv drops the bridge-only credentials and keeps what Claude Code needs to sign in', () => {
  const base = { PATH: 'p', DOCK_INGEST_TOKEN: 'a', BRAIN_TOKEN: 'b', CODER_AGENT_TOKEN: 'c', CODER_SESSION_TOKEN: 'd', DOCK_MASK_EXTRA: 'e', DOCK_SOME_SECRET: 'f', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'key', ANTHROPIC_BASE_URL: 'u', CODER_AGENT_URL: 'url' };
  const env = chat.childEnv({ configDir: null }, base);
  for (const k of ['DOCK_INGEST_TOKEN', 'BRAIN_TOKEN', 'CODER_AGENT_TOKEN', 'CODER_SESSION_TOKEN', 'DOCK_MASK_EXTRA', 'DOCK_SOME_SECRET']) assert.ok(!(k in env), k);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.ANTHROPIC_API_KEY, 'key');
  assert.equal(env.ANTHROPIC_BASE_URL, 'u');
  assert.equal(env.CODER_AGENT_URL, 'url');
  assert.equal(env.PATH, 'p');
  assert.equal(chat.childEnv({ configDir: null, passEnv: ['BRAIN_TOKEN'] }, base).BRAIN_TOKEN, 'b');
});

test('catalogue command names and model values the server would change are not uploaded', () => {
  const c = catalog.compactCatalog({
    commands: [{ name: 'ok-cmd', description: 'x' }, { name: 'sk-abcdefghijklmnop1234', description: 'x' }],
    models: [{ value: 'sonnet', displayName: 'S' }, { value: 'sk-abcdefghijklmnop1234', displayName: 'T' }],
  }, []);
  assert.deepEqual(c.commands.map((x) => x.name), ['ok-cmd']);
  assert.deepEqual(c.models.map((x) => x.value), ['sonnet']);
});
