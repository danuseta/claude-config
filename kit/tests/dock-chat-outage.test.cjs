'use strict';
// A DOCK outage must not cost a turn: deltas wait and are retried, the final one falls back to an on-disk outbox, and the ledgers a turn wrote are pushed by the bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv } = require('./helpers.cjs');

const FAKE_INTERACTIVE = path.join(KIT, 'tests', 'fixtures', 'fake-claude-interactive.cjs');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A one-shot claude: says each line of FAKE_SAY with FAKE_GAP_MS between them, optionally rewrites FAKE_LEDGER, then ends and leaves a marker.
const FAKE_ONESHOT = `
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--help') { process.stdout.write('Usage: claude [options]\\n  --verbose  Override verbose mode\\n'); process.exit(0); }
const say = JSON.parse(process.env.FAKE_SAY || '[]');
const gap = Number(process.env.FAKE_GAP_MS || 0);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
(async () => {
  out({ type: 'system', subtype: 'init', session_id: 'sess-out' });
  for (const text of say) {
    out({ type: 'assistant', session_id: 'sess-out', message: { content: [{ type: 'text', text }] } });
    if (process.env.FAKE_LEDGER) fs.writeFileSync(process.env.FAKE_LEDGER, JSON.stringify({ key: 'QRD-1', stage: 'code', updatedAt: new Date().toISOString() }));
    await new Promise((r) => setTimeout(r, gap));
  }
  out({ type: 'result', session_id: 'sess-out', is_error: false });
  fs.writeFileSync(process.env.FAKE_MARKER, 'finished');
})();
`;

const isDelta = (q) => q.url.endsWith('/chat/delta');

function claimOnce(message) {
  let claimed = false;
  return (req) => {
    if (!req.url.endsWith('/chat/claim')) return null;
    if (claimed) return { json: { ok: true, result: { message: null } } };
    claimed = true;
    return { json: { ok: true, result: { message } } };
  };
}

async function bridge(dir, dock, { config = {}, env = {} } = {}) {
  fs.writeFileSync(path.join(dir, 'fake-claude.cjs'), FAKE_ONESHOT);
  fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'fake-claude.cjs'), cwd: dir, interactive: false, turnTimeoutMs: 30000, retryBaseMs: 30, ...config }));
  return runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
    env: { ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', QONFLO_ROOT: dir, FAKE_MARKER: path.join(dir, 'marker'), ...env },
  });
}

test('DOCK down mid-turn: claude is not killed, the queued items and the done delta arrive in order once DOCK answers', async () => {
  const dir = tmp('outage-mid');
  let dock;
  try {
    const upAt = Date.now() + 3500;
    const claim = claimOnce({ id: 11, sessionId: 'dock-out-1', text: 'go', claudeSessionId: null });
    const refused = [];
    dock = await startServer((req) => {
      const c = claim(req);
      if (c) return c;
      if (isDelta(req) && Date.now() < upAt) { refused.push(req.body); return { status: 502, json: {} }; }
      return null;
    });
    const r = await bridge(dir, dock, { env: { FAKE_SAY: JSON.stringify(['first', 'second', 'third']), FAKE_GAP_MS: '1300' } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(refused.length >= 2, 'DOCK refused deltas while down');
    assert.doesNotMatch(r.stdout, /dropping turn/);
    assert.equal(fs.readFileSync(path.join(dir, 'marker'), 'utf8'), 'finished', 'claude ran to its end');
    const accepted = dock.requests.filter((q) => isDelta(q) && q.body).map((q) => q.body).filter((b) => !refused.includes(b));
    const texts = accepted.flatMap((b) => b.items).map((i) => i.text);
    assert.deepEqual(texts, ['first', 'second', 'third']);
    assert.equal(accepted.at(-1).done, true);
    assert.equal(accepted.filter((b) => b.done).length, 1);
  } finally { if (dock) await dock.close(); rmrf(dir); }
});

test('a done delta DOCK does not take within the outage window goes to the outbox, and the main loop sends it later', async () => {
  const dir = tmp('outage-outbox');
  let dock;
  try {
    let up = false;
    const claim = claimOnce({ id: 12, sessionId: 'dock-out-2', text: 'go', claudeSessionId: null });
    dock = await startServer((req) => {
      const c = claim(req);
      if (c) return c;
      if (isDelta(req) && !up) return { status: 502, json: {} };
      return null;
    });
    const first = await bridge(dir, dock, { env: { FAKE_SAY: JSON.stringify(['all done']), DOCK_CHAT_TUNING: JSON.stringify({ outageMs: 700, drainMs: 200 }) } });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /written to the outbox/);
    const box = path.join(dir, 'dock-chat-outbox');
    const entries = fs.readdirSync(box).filter((n) => n.endsWith('.json'));
    const saved = entries.sort().map((n) => JSON.parse(fs.readFileSync(path.join(box, n), 'utf8')));
    assert.ok(saved.length >= 1 && saved.length <= 2);
    assert.equal(saved.at(-1).body.done, true);
    assert.deepEqual(saved.flatMap((e) => e.body.items).map((i) => i.text), ['all done']);
    assert.ok(saved.every((e) => e.msg.sessionId === "dock-out-2" && e.msg.id === 12));

    up = true;
    const before = dock.requests.length;
    const second = await bridge(dir, dock, { env: { FAKE_SAY: '[]' } });
    assert.equal(second.code, 0, second.stderr);
    const resent = dock.requests.slice(before).filter((q) => isDelta(q)).map((q) => q.body);
    assert.deepEqual(resent.flatMap((b) => b.items).map((i) => i.text), ['all done']);
    assert.equal(resent.at(-1).done, true);
    assert.equal(resent.filter((b) => b.done).length, 1);
    assert.deepEqual(fs.readdirSync(box).filter((n) => n.endsWith('.json')), [], 'a delivered entry leaves the outbox');
  } finally { if (dock) await dock.close(); rmrf(dir); }
});

test('the outbox is bounded: past the entry limit the oldest entries are dropped with a log line', () => {
  const outbox = require('../dock-chat-outbox.cjs');
  const dir = tmp('outbox-bound');
  try {
    const lines = [];
    for (let i = 0; i < 5; i++) outbox.add(dir, { msg: { sessionId: 's', id: i }, body: { replyTo: i, done: true, items: [] }, files: [{ name: 'a.png', mime: 'image/png', bytes: Buffer.from('x') }] }, { log: (m) => lines.push(m), maxEntries: 3 });
    assert.equal(outbox.pending(dir), 3);
    assert.equal(lines.length, 2);
    const kept = fs.readdirSync(outbox.dirOf(dir)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(outbox.dirOf(dir), n), 'utf8')).msg.id);
    assert.deepEqual(kept, [2, 3, 4], 'the newest survive, in order');
  } finally { rmrf(dir); }
});

test('owner Stop still stops the turn while DOCK is failing deltas, and the stopped delta arrives once DOCK is back', async () => {
  const dir = tmp('outage-stop');
  let dock;
  try {
    const upAt = Date.now() + 2500;
    let waits = 0;
    const claim = claimOnce({ id: 13, sessionId: 'dock-out-3', text: 'go', claudeSessionId: null });
    dock = await startServer((req) => {
      const c = claim(req);
      if (c) return c;
      if (req.url.endsWith('/chat/wait')) { waits++; return { json: { ok: true, result: { stop: waits >= 3, answers: [], closed: false } } }; }
      if (isDelta(req) && Date.now() < upAt) return { status: 502, json: {} };
      return null;
    });
    const logDir = path.join(dir, 'fake-log');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: FAKE_INTERACTIVE, cwd: dir, turnTimeoutMs: 30000, retryBaseMs: 30 }));
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
      env: {
        ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test',
        FAKE_SCRIPT: JSON.stringify([{ say: 'working' }, { tool: { id: 'tu1', name: 'Bash', input: { command: 'sleep 100' } } }, { sleep: 60000 }]), FAKE_LOG_DIR: logDir,
        DOCK_CHAT_TUNING: JSON.stringify({ waitSeconds: 1, waitGapMs: 30, interruptGraceMs: 10000, closeGraceMs: 5000, exitGraceMs: 3000 }),
      },
    });
    assert.equal(r.code, 0, r.stderr);
    const deltas = dock.requests.filter((q) => isDelta(q) && q.body).map((q) => q.body);
    const last = deltas.at(-1);
    assert.equal(last.done, true);
    assert.equal(last.stopped, true);
    assert.equal(last.error, null);
    const pid = JSON.parse(fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8').split('\n')[0]).pid;
    assert.ok(await waitFor(() => !alive(pid), 5000), 'claude was stopped');
  } finally { if (dock) await dock.close(); rmrf(dir); }
});

const ledgerAt = (dir, key) => path.join(dir, '.evidence', key, 'status.json');
const writeLedger = (dir, key, stage) => {
  fs.mkdirSync(path.dirname(ledgerAt(dir, key)), { recursive: true });
  fs.writeFileSync(ledgerAt(dir, key), JSON.stringify({ key, stage, updatedAt: new Date().toISOString() }));
};
const ledgerPosts = (dock) => dock.requests.filter((q) => q.url === '/ingest/orchestrator' && q.body && q.body.key);

test('after a one-shot turn the bridge pushes the ledger that changed during it, and not an unchanged one', async () => {
  const dir = tmp('ledger-oneshot');
  let dock;
  try {
    writeLedger(dir, 'QRD-1', 'gate');
    writeLedger(dir, 'QRD-2', 'gate');
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(ledgerAt(dir, 'QRD-1'), hourAgo, hourAgo);
    fs.utimesSync(ledgerAt(dir, 'QRD-2'), hourAgo, hourAgo);
    const claim = claimOnce({ id: 14, sessionId: 'dock-out-4', text: 'go', claudeSessionId: null });
    dock = await startServer((req) => claim(req));
    const r = await bridge(dir, dock, { env: { FAKE_SAY: JSON.stringify(['working']), FAKE_LEDGER: ledgerAt(dir, 'QRD-1') } });
    assert.equal(r.code, 0, r.stderr);
    const posts = ledgerPosts(dock);
    assert.deepEqual(posts.map((q) => q.body.key), ['QRD-1']);
    assert.equal(posts[0].body.stage, 'code');
    assert.equal(posts[0].headers.authorization, 'Bearer dock_ing_test');
    const order = dock.requests.map((q) => (isDelta(q) && q.body.done ? 'done' : q === posts[0] ? 'ledger' : ''));
    assert.ok(order.indexOf('ledger') > order.indexOf('done'), 'the push never goes ahead of the done delta');
  } finally { if (dock) await dock.close(); rmrf(dir); }
});

test('after an interactive turn the bridge pushes the ledgers changed since the turn started', async () => {
  const dir = tmp('ledger-interactive');
  let dock;
  try {
    writeLedger(dir, 'QRD-7', 'code');
    writeLedger(dir, 'QRD-8', 'code');
    const hourAgo = new Date(Date.now() - 3600 * 1000), later = new Date(Date.now() + 30 * 1000);
    fs.utimesSync(ledgerAt(dir, 'QRD-7'), later, later);
    fs.utimesSync(ledgerAt(dir, 'QRD-8'), hourAgo, hourAgo);
    const claim = claimOnce({ id: 15, sessionId: 'dock-out-5', text: 'go', claudeSessionId: null });
    dock = await startServer((req) => claim(req));
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: FAKE_INTERACTIVE, cwd: dir, turnTimeoutMs: 30000, retryBaseMs: 30 }));
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
      env: {
        ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', QONFLO_ROOT: dir,
        FAKE_SCRIPT: JSON.stringify([{ say: 'ok' }, { result: {} }]), DOCK_CHAT_TUNING: JSON.stringify({ waitSeconds: 1, waitGapMs: 30, exitGraceMs: 3000 }),
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(ledgerPosts(dock).map((q) => q.body.key), ['QRD-7']);
  } finally { if (dock) await dock.close(); rmrf(dir); }
});

test('a ledger push that fails is logged once and does not change the exit of the bridge or the done delta', async () => {
  const dir = tmp('ledger-fail');
  let dock;
  try {
    writeLedger(dir, 'QRD-9', 'code');
    writeLedger(dir, 'QRD-10', 'code');
    const claim = claimOnce({ id: 16, sessionId: 'dock-out-6', text: 'go', claudeSessionId: null });
    dock = await startServer((req) => claim(req) || (req.url === '/ingest/orchestrator' ? { status: 500, json: { ok: false } } : null));
    const r = await bridge(dir, dock, { env: { FAKE_SAY: JSON.stringify(['working']), FAKE_LEDGER: ledgerAt(dir, 'QRD-9') } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(dock.requests.filter((q) => isDelta(q) && q.body.done).length, 1);
    assert.equal((r.stdout.match(/ledger push after the turn/g) || []).length, 1);
  } finally { if (dock) await dock.close(); rmrf(dir); }
});
