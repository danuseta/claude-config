'use strict';
// el-rotate.cjs keeps no key file: every command reads and writes the keys in DOCK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

function dockFake() {
  const store = { keys: {}, order: [], current: 0, cooldowns: {} };
  const respond = (req) => {
    const route = req.url.replace(/^\/ingest\/orchestrator\/elevenlabs\//, '');
    const b = req.body || {};
    if (req.headers.authorization !== `Bearer ${'dock_ing_'}laptop`) return { status: 401, json: { error: 'Unauthorized' } };
    if (route === 'store') return { json: { ok: true, result: store } };
    if (route === 'add') {
      if (String(b.key).length < 8) return { status: 400, json: { error: 'An ElevenLabs key is 8 to 200 characters without spaces' } };
      if (!store.order.includes(b.name)) store.order.push(b.name);
      store.keys[b.name] = b.key;
      return { json: { ok: true, result: true } };
    }
    if (route === 'remove') {
      const had = b.name in store.keys;
      delete store.keys[b.name];
      store.order = store.order.filter((name) => name !== b.name);
      return { json: { ok: true, result: had } };
    }
    if (route === 'park') { store.cooldowns[b.name] = Date.parse(b.until); return { json: { ok: true, result: true } }; }
    if (route === 'current') { store.current = store.order.indexOf(b.name); return { json: { ok: true, result: true } }; }
    return null;
  };
  return { store, respond };
}

test('el-rotate imports the old key file into DOCK, then lists, gives, parks and removes keys there', async () => {
  const base = tmp('el-rotate');
  const fake = dockFake();
  const dock = await startServer(fake.respond);
  const machine = 'laptop';
  const env = { ...sandboxEnv(path.join(base, 'sandbox')), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: `dock_ing_${machine}` };
  const el = (...args) => runNode([path.join(KIT, 'el-rotate.cjs'), ...args], { env, cwd: base });
  try {
    fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
    const oldFile = path.join(base, 'elevenlabs-keys.json');
    fs.writeFileSync(oldFile, JSON.stringify({ keys: { suryo: 'sk_aaaaaaaaaaaaaaaa1111', sem: 'sk_bbbbbbbbbbbbbbbb2222' }, order: ['suryo', 'sem'], current: 0, cooldowns: {} }));

    let r = await el('import', oldFile);
    assert.match(r.stdout, /imported 2 key\(s\) to DOCK and deleted/);
    assert.ok(!fs.existsSync(oldFile), 'the local key file is gone');
    assert.deepEqual(fake.store.order, ['suryo', 'sem']);

    r = await el('list');
    assert.match(r.stdout, /0\tsuryo\tsk_aaa\.\.\.1111 \*current ready/);
    assert.doesNotMatch(r.stdout, /aaaaaaaaaaaa/, 'list never prints a full key');

    r = await el('get');
    assert.equal(r.stdout, 'sk_aaaaaaaaaaaaaaaa1111');
    r = await el('park');
    assert.match(r.stdout, /parked "suryo"/);
    assert.ok(fake.store.cooldowns.suryo > Date.now(), 'the park reaches DOCK');
    r = await el('get');
    assert.equal(r.stdout, 'sk_bbbbbbbbbbbbbbbb2222', 'the next key is given once the first is parked');

    r = await el('add', 'bad', 'short');
    assert.match(r.stderr, /DOCK refused elevenlabs\/add: 400 An ElevenLabs key is 8 to 200/);
    r = await el('remove', 'sem');
    assert.match(r.stdout, /removed "sem"/);
    assert.deepEqual(fake.store.order, ['suryo']);
  } finally {
    await dock.close();
    rmrf(base);
  }
});
