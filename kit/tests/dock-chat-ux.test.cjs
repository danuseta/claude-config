'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const catalog = require('../dock-chat-catalog.cjs');
const files = require('../dock-chat-files.cjs');
const { KIT, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv } = require('./helpers.cjs');

test('machineDefaults reads settings.json, lets the environment win, and falls back to null and "default"', () => {
  const dir = tmp('defaults');
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'high', permissions: { defaultMode: 'acceptEdits' } }));
    assert.deepEqual(catalog.machineDefaults({ configDir: dir }, {}), { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' });
    assert.deepEqual(catalog.machineDefaults({ configDir: dir, permissionMode: 'auto' }, { ANTHROPIC_MODEL: 'sonnet', CLAUDE_CODE_EFFORT_LEVEL: 'low' }), { model: 'sonnet', effort: 'low', permissionMode: 'auto' });
    assert.deepEqual(catalog.machineDefaults({ configDir: path.join(dir, 'missing') }, {}), { model: null, effort: null, permissionMode: 'default' });
  } finally { rmrf(dir); }
});

test('the catalogue carries the defaults, and its hash changes when they change', () => {
  const a = catalog.compactCatalog({ commands: [], models: [] }, [], { defaults: { model: 'opus', effort: 'high', permissionMode: 'default' } });
  const b = catalog.compactCatalog({ commands: [], models: [] }, [], { defaults: { model: 'opus', effort: 'low', permissionMode: 'default' } });
  const none = catalog.compactCatalog({ commands: [], models: [] }, []);
  assert.deepEqual(a.defaults, { model: 'opus', effort: 'high', permissionMode: 'default' });
  assert.deepEqual(none.defaults, { model: null, effort: null, permissionMode: null });
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.hash, none.hash);
});

test('resolveAttach accepts a file inside cwd and refuses outside paths, symlinks out, big files and other types', () => {
  const dir = tmp('attach');
  const outside = tmp('attach-out');
  try {
    fs.mkdirSync(path.join(dir, '1015'));
    fs.writeFileSync(path.join(dir, '1015', 'shot.PNG'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'run.exe'), 'x');
    fs.writeFileSync(path.join(dir, 'big.log'), Buffer.alloc(files.ATTACH_BYTES + 1));
    const ok = files.resolveAttach(path.join(dir, '1015', 'shot.PNG'), dir);
    assert.equal(ok.mime, 'image/png');
    assert.equal(ok.name, 'shot.PNG');
    assert.ok(files.resolveAttach('1015/shot.PNG', dir).file);
    assert.match(files.resolveAttach(path.join(outside, 'secret.txt'), dir).error, /outside/);
    assert.match(files.resolveAttach('../' + path.basename(outside) + '/secret.txt', dir).error, /outside/);
    assert.match(files.resolveAttach(path.join(dir, 'run.exe'), dir).error, /type/);
    assert.match(files.resolveAttach(path.join(dir, 'big.log'), dir).error, /10 MB/);
    assert.match(files.resolveAttach(path.join(dir, 'none.txt'), dir).error, /not found/);
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
      assert.match(files.resolveAttach(path.join(dir, 'link.txt'), dir).error, /outside/);
    } catch (e) { if (e.code !== 'EPERM') throw e; }
  } finally { rmrf(dir); rmrf(outside); }
});

// One chat turn against a fake DOCK; `events` is the list of stream-json lines the fake claude prints, `respond` shapes DOCK's answers.
async function runFakeTurn(label, events, { respond = () => null, setup = () => {}, wait } = {}) {
  const dir = tmp(label);
  let dock;
  try {
    fs.writeFileSync(path.join(dir, 'fake-claude.cjs'), `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));\n`);
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'fake-claude.cjs'), cwd: dir, turnTimeoutMs: 20000, retryBaseMs: 50 }));
    setup(dir);
    let claimed = false;
    dock = await startServer((req) => {
      if (req.url.endsWith('/chat/claim')) {
        if (claimed) return { json: { ok: true, result: { message: null } } };
        claimed = true;
        return { json: { ok: true, result: { message: { id: 9, sessionId: 'dock-s9', text: 'go', claudeSessionId: null, options: { effort: 'max' } } } } };
      }
      return respond(req);
    });
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
      env: { ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' },
    });
    if (wait) await waitFor(() => wait(dock.requests), 3000);
    return { dir, dock, r, at: (suffix) => dock.requests.filter((q) => q.url.split('?')[0].endsWith(suffix)), done: () => rmrf(dir) };
  } catch (e) {
    if (dock) await dock.close();
    rmrf(dir);
    throw e;
  }
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-9', model: 'claude-opus-5-5' };
const RESULT = { type: 'result', session_id: 'sess-9', is_error: false, total_cost_usd: 0.25, usage: { input_tokens: 900, cache_read_input_tokens: 900, cache_creation_input_tokens: 900 }, modelUsage: { 'claude-opus-5-5': { contextWindow: 200000 } } };
const said = (text, usage) => ({ type: 'assistant', session_id: 'sess-9', message: { content: [{ type: 'text', text }], usage } });
const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');
const toolImage = (data = PNG_B64) => ({ type: 'user', session_id: 'sess-9', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } });

test('a turn posts /chat/status with model, effort, context and cost, using the last call usage', async () => {
  const t = await runFakeTurn('status', [INIT, said('hi', { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 90 }), RESULT], { wait: (reqs) => reqs.some((q) => q.url.endsWith('/chat/status')) });
  try {
    assert.equal(t.r.code, 0, t.r.stderr);
    const status = t.at('/chat/status');
    assert.equal(status.length, 1);
    assert.deepEqual(status[0].body, { sessionId: 'dock-s9', model: 'claude-opus-5-5', effort: 'max', contextTokens: 4100, contextSize: 200000, contextPercentage: 2.1, turnCostUsd: 0.25 });
    assert.equal(t.at('/chat/delta').at(-1).body.done, true);
  } finally { await t.dock.close(); t.done(); }
});

test('without per-call usage the result usage feeds the context, and a missing window leaves size and percentage out', async () => {
  const t = await runFakeTurn('status-fallback', [INIT, said('hi'), { ...RESULT, modelUsage: {} }], { wait: (reqs) => reqs.some((q) => q.url.endsWith('/chat/status')) });
  try {
    const body = t.at('/chat/status')[0].body;
    assert.equal(body.contextTokens, 2700);
    assert.ok(!('contextSize' in body) && !('contextPercentage' in body));
  } finally { await t.dock.close(); t.done(); }
});

test('a failing /chat/status does not fail the turn', async () => {
  const t = await runFakeTurn('status-fail', [INIT, said('hi'), RESULT], { respond: (req) => (req.url.endsWith('/chat/status') ? { status: 500, json: { ok: false } } : null), wait: (reqs) => reqs.some((q) => q.url.endsWith('/chat/status')) });
  try {
    assert.equal(t.r.code, 0, t.r.stderr);
    const last = t.at('/chat/delta').at(-1).body;
    assert.equal(last.done, true);
    assert.equal(last.error, null);
  } finally { await t.dock.close(); t.done(); }
});

test('an image in a tool_result is uploaded once with the right query and content type, before the final delta', async () => {
  const t = await runFakeTurn('upload-image', [INIT, said('looking'), toolImage(), toolImage(), RESULT]);
  try {
    assert.equal(t.r.code, 0, t.r.stderr);
    const ups = t.at('/chat/upload');
    assert.equal(ups.length, 1);
    const url = new URL(ups[0].url, 'http://x');
    assert.equal(url.pathname, '/ingest/orchestrator/chat/upload');
    assert.equal(url.searchParams.get('sessionId'), 'dock-s9');
    assert.equal(url.searchParams.get('replyTo'), '9');
    assert.equal(url.searchParams.get('name'), 'image-1.png');
    assert.equal(ups[0].headers['content-type'], 'image/png');
    assert.equal(ups[0].headers.authorization, 'Bearer dock_ing_test');
    assert.equal(ups[0].body, 'fake-png-bytes');
    const order = t.dock.requests.map((q) => q.url.split('?')[0].split('/').pop());
    assert.ok(order.indexOf('upload') < order.lastIndexOf('delta'));
  } finally { await t.dock.close(); t.done(); }
});

test('DOCK_ATTACH uploads an allowed file, strips the line from the text, and refuses a path outside cwd', async () => {
  const outside = tmp('attach-secret');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  const text = `Here is the report.\nDOCK_ATTACH: report.md\nDOCK_ATTACH: ${path.join(outside, 'secret.txt')}\nDone.`;
  const t = await runFakeTurn('upload-attach', [INIT, said(text), RESULT], { setup: (dir) => fs.writeFileSync(path.join(dir, 'report.md'), '# report') });
  try {
    assert.equal(t.r.code, 0, t.r.stderr);
    const ups = t.at('/chat/upload');
    assert.equal(ups.length, 1);
    assert.equal(new URL(ups[0].url, 'http://x').searchParams.get('name'), 'report.md');
    assert.equal(ups[0].headers['content-type'], 'text/markdown');
    assert.equal(ups[0].body, '# report');
    const forwarded = t.at('/chat/delta').flatMap((d) => d.body.items).map((i) => i.text).join('\n');
    assert.ok(!forwarded.includes('DOCK_ATTACH'));
    assert.match(forwarded, /Here is the report\.\s+Done\./);
    assert.match(t.r.stdout, /DOCK_ATTACH refused: outside the working folder/);
  } finally { await t.dock.close(); t.done(); rmrf(outside); }
});

test('a 404 from /chat/upload turns uploads off for the process and the turn still finishes', async () => {
  const other = Buffer.from('other-png-bytes').toString('base64');
  const t = await runFakeTurn('upload-404', [INIT, said('a'), toolImage(), toolImage(other), RESULT], { respond: (req) => (req.url.includes('/chat/upload') ? { status: 404, json: { ok: false, error: 'Not found' } } : null) });
  try {
    assert.equal(t.r.code, 0, t.r.stderr);
    assert.equal(t.at('/chat/upload').length, 1);
    assert.match(t.r.stdout, /DOCK has no \/chat\/upload route/);
    const last = t.at('/chat/delta').at(-1).body;
    assert.equal(last.done, true);
    assert.equal(last.error, null);
  } finally { await t.dock.close(); t.done(); }
});
