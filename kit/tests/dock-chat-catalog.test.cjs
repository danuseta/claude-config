'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf } = require('./helpers.cjs');

const catalog = require(path.join(KIT, 'dock-chat-catalog.cjs'));

const INIT = {
  commands: [
    { name: 'context', description: 'Show context usage', argumentHint: '', builtin: true },
    { name: 'doctor', description: 'Diagnose the install', argumentHint: '', builtin: true },
    { name: 'model', description: 'Pick a model', argumentHint: '[model]', builtin: true },
    { name: 'effort', description: 'Pick an effort', argumentHint: '[level]', builtin: true },
    { name: 'fast', description: 'Toggle fast mode', argumentHint: '', builtin: true },
    { name: 'deploy', description: 'Deploy with key sk-abcdefghijklmnop1234 now', argumentHint: '<env> token=supersecretvalue', aliases: ['ship'] },
    { name: 'review', description: 'Review the diff', argumentHint: '[pr]' },
  ],
  agents: [{ name: 'explore', description: 'x', model: 'haiku' }],
  models: [
    { value: 'opus', displayName: 'Opus', description: 'long text', supportedEffortLevels: ['low', 'high'], supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku', description: 'short' },
  ],
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'extra_usage_disabled',
  current_permission_mode: 'default',
  claude_code_version: '2.1.296',
  account: { email: 'owner@example.com', token: 'dock_ing_should_never_be_copied' },
  memory_paths: ['C:/secret'],
};

test('compactCatalog copies only the listed fields and drops terminal-only and options-bar commands', () => {
  const c = catalog.compactCatalog(INIT, ['doctor', 'color']);
  assert.deepEqual(c.commands.map((x) => x.name), ['context', 'deploy', 'review']);
  assert.deepEqual(Object.keys(c.commands[0]).sort(), ['argumentHint', 'description', 'kind', 'name']);
  assert.equal(c.commands[0].kind, 'builtin');
  assert.equal(c.commands[1].kind, 'skill');
  assert.deepEqual(c.models, [
    { value: 'opus', label: 'Opus', efforts: ['low', 'high'], fast: true },
    { value: 'haiku', label: 'Haiku', efforts: [], fast: false },
  ]);
  assert.deepEqual(c.fast, { available: false, reason: 'extra_usage_disabled' });
  assert.deepEqual(Object.keys(c).sort(), ['commands', 'defaults', 'fast', 'hash', 'models']);
  const json = JSON.stringify(c);
  for (const leak of ['owner@example.com', 'dock_ing_should', 'C:/secret', 'explore', '2.1.296', 'long text']) assert.ok(!json.includes(leak), leak);
});

test('a model label without a version gets it from resolvedModel or the description', () => {
  const labels = catalog.compactCatalog({ models: [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' },
    { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
    { value: 'fable', displayName: 'Fable', description: 'Fable 5.1 · For your toughest challenges' },
    { value: 'old', displayName: 'Old', description: 'Fast and cheap' },
  ] }, []).models.map((m) => m.label);
  assert.deepEqual(labels, ['Default (recommended) · Opus 5.5', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'Fable 5.1', 'Old']);
});

test('compactCatalog masks secrets before cutting and caps field lengths', () => {
  const c = catalog.compactCatalog(INIT, []);
  const deploy = c.commands.find((x) => x.name === 'deploy');
  assert.ok(!deploy.description.includes('sk-abcdefghijklmnop'));
  assert.ok(!deploy.argumentHint.includes('supersecretvalue'));
  const long = catalog.compactCatalog({ commands: [{ name: 'n'.repeat(100), description: 'd'.repeat(500), argumentHint: 'h'.repeat(500) }], models: [] }, []);
  assert.equal(long.commands[0].name.length, 64);
  assert.equal(long.commands[0].description.length, 100);
  assert.equal(long.commands[0].argumentHint.length, 60);
});

test('compactCatalog fast: available when the state is anything but off', () => {
  assert.deepEqual(catalog.compactCatalog({ ...INIT, fast_mode_state: 'available', fast_mode_disabled_reason: undefined }, []).fast, { available: true, reason: null });
  assert.deepEqual(catalog.compactCatalog({ ...INIT, fast_mode_state: undefined, fast_mode_disabled_reason: undefined }, []).fast, { available: false, reason: null });
});

test('compactCatalog hash is stable across input order and changes with content', () => {
  const a = catalog.compactCatalog(INIT, []);
  const b = catalog.compactCatalog({ ...INIT, commands: [...INIT.commands].reverse(), account: undefined }, []);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(b.hash, a.hash);
  const c = catalog.compactCatalog({ ...INIT, commands: [...INIT.commands, { name: 'extra', description: 'new' }] }, []);
  assert.notEqual(c.hash, a.hash);
});

test('compactCatalog stays under 300 KB and 2000 commands with 3000 input commands, 40 models', () => {
  const commands = Array.from({ length: 3000 }, (_, i) => ({ name: `cmd-${String(i).padStart(4, '0')}-${'x'.repeat(40)}`, description: 'y'.repeat(300), argumentHint: 'z'.repeat(100), builtin: i % 2 === 0 }));
  const models = Array.from({ length: 60 }, (_, i) => ({ value: `m${i}`, displayName: `Model ${i}`, supportedEffortLevels: ['low', 'high'], supportsFastMode: false }));
  const c = catalog.compactCatalog({ commands, models }, []);
  assert.ok(c.commands.length <= 2000);
  assert.equal(c.models.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 300 * 1024);
});

test('compactCatalog survives missing and malformed input', () => {
  for (const bad of [null, undefined, {}, { commands: 'x', models: 5 }, { commands: [null, 3, {}, { name: 7 }], models: [null, {}] }]) {
    const c = catalog.compactCatalog(bad, undefined);
    assert.deepEqual(c.commands, []);
    assert.deepEqual(c.models, []);
    assert.deepEqual(c.fast, { available: false, reason: null });
    assert.match(c.hash, /^[0-9a-f]{64}$/);
  }
});

function fixture(dir) {
  const file = path.join(dir, 'fake-claude.cjs');
  fs.writeFileSync(file, `
const fs = require('fs');
const mode = process.env.FAKE_MODE || 'ok';
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    fs.appendFileSync(process.env.FAKE_LOG, line + '\\n');
    const msg = JSON.parse(line);
    if (msg.type !== 'control_request') continue;
    if (mode === 'silent') continue;
    if (mode === 'exit') process.exit(3);
    if (msg.request.subtype === 'initialize') {
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'other', response: { wrong: true } } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: JSON.parse(process.env.FAKE_RESPONSE) } }) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`);
  return file;
}

const run = async (extraEnv, opts = {}) => {
  const dir = tmp('catalog-probe');
  try {
    const log = path.join(dir, 'log.txt');
    const claude = { cmd: process.execPath, prefix: [fixture(dir)] };
    const started = Date.now();
    const out = await catalog.probeCatalog(claude, { cwd: KIT, ...opts }, { env: { ...process.env, FAKE_LOG: log, FAKE_RESPONSE: JSON.stringify(INIT), ...extraEnv } });
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { out, lines, ms: Date.now() - started };
  } finally { rmrf(dir); }
};

test('probeCatalog sends only initialize, returns the raw response of the matching request_id and closes the child', async () => {
  const { out, lines } = await run({});
  assert.deepEqual(out, INIT);
  const args = lines[0].argv;
  for (const flag of ['-p', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--settings'));
  const sent = lines.slice(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'control_request');
  assert.equal(sent[0].request.subtype, 'initialize');
  assert.ok(!JSON.stringify(sent).includes('get_settings'));
});

test('probeCatalog with fast adds the fastMode settings and no user text reaches argv', async () => {
  const { lines } = await run({}, { fast: true });
  const args = lines[0].argv;
  assert.equal(args[args.indexOf('--settings') + 1], '{"fastMode":true}');
  assert.ok(!args.includes('--resume'));
});

test('probeCatalog answers null when the child never answers within the timeout', async () => {
  const { out, ms } = await run({ FAKE_MODE: 'silent' }, { timeoutMs: 600 });
  assert.equal(out, null);
  assert.ok(ms < 8000);
});

test('probeCatalog answers null when the child exits without an answer or cannot start', async () => {
  assert.equal((await run({ FAKE_MODE: 'exit' })).out, null);
  const missing = await catalog.probeCatalog({ cmd: path.join(tmp('nothing'), 'no-such-binary'), prefix: [] }, { cwd: process.cwd() }, { env: {} });
  assert.equal(missing, null);
});

test('probeCatalog uses the injected spawn', async () => {
  let called = null;
  const fakeSpawn = (cmd, args, options) => {
    called = { cmd, args, options };
    throw new Error('stop here');
  };
  const out = await catalog.probeCatalog({ cmd: 'claude-bin', prefix: ['x.js'] }, { cwd: 'C:/work' }, { spawn: fakeSpawn, env: { A: '1' } });
  assert.equal(out, null);
  assert.equal(called.cmd, 'claude-bin');
  assert.equal(called.args[0], 'x.js');
  assert.deepEqual(called.options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(called.options.shell, false);
  assert.equal(called.options.cwd, 'C:/work');
  assert.deepEqual(called.options.env, { A: '1' });
});

test('publishCatalog posts {hash, commands, models, fast} to /chat/catalog and reports success', async () => {
  const c = catalog.compactCatalog(INIT, ['doctor']);
  const calls = [];
  const ok = await catalog.publishCatalog(c, async (route, body, timeout) => { calls.push({ route, body, timeout }); return { status: 200, ok: true, result: { hash: c.hash } }; });
  assert.equal(ok, true);
  assert.equal(calls[0].route, '/chat/catalog');
  assert.deepEqual(calls[0].body, { hash: c.hash, commands: c.commands, models: c.models, fast: c.fast, defaults: c.defaults });
  assert.ok(calls[0].timeout >= 1000);
  assert.equal(await catalog.publishCatalog(c, async () => ({ status: 404, ok: false })), false);
  assert.equal(await catalog.publishCatalog(c, async () => ({ status: 200, ok: false })), false);
  assert.equal(await catalog.publishCatalog(c, async () => ({ skipped: true })), false);
  assert.equal(await catalog.publishCatalog(c, async () => { throw new Error('down'); }), false);
  assert.equal(await catalog.publishCatalog(null, async () => ({ status: 200, ok: true })), false);
});
