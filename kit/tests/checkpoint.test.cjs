'use strict';
// status.cjs checkpoint (optional DOCK progress report), the Indonesian lines on decide / issue, and set qaMenu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

const FAKE_TOKEN = 'fake-test-token';

function scratch(label, dockUrl) {
  const base = tmp(label);
  const evidence = path.join(base, 'evidence');
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const dockEnv = dockUrl ? { DOCK_INGEST_URL: `${dockUrl}/ingest/orchestrator`, DOCK_INGEST_TOKEN: FAKE_TOKEN } : { DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '' };
  const status = (...args) => runNode([path.join(KIT, 'status.cjs'), ...args], { env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence, DOCK_PROXY: '', ...dockEnv } });
  const ledger = (key) => JSON.parse(fs.readFileSync(path.join(evidence, key, 'status.json'), 'utf8'));
  return { base, status, ledger };
}

test('checkpoint posts key, step, agent, text and notes to /checkpoint', async () => {
  const dock = await startServer(() => ({ json: { ok: true, result: { recorded: true } } }));
  const { base, status } = scratch('checkpoint-body', dock.url);
  try {
    const r = await status('checkpoint', 'ZED-901', 'final-review', 'Review akhir lolos, siap publish.', '--agent', 'sous-reviewer', '--agent-id', 'a1b2',
      '--untestable', 'AC3 needs ZED-902 merged', '--missing-data', 'no team with three levels');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ZED-901 checkpoint final-review: recorded/);
    assert.equal(dock.requests.length, 1);
    const q = dock.requests[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.url, '/ingest/orchestrator/checkpoint');
    assert.equal(q.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    assert.deepEqual(q.body, { key: 'ZED-901', step: 'final-review', agent: 'sous-reviewer', agentId: 'a1b2', text: 'Review akhir lolos, siap publish.', notes: { untestable: ['AC3 needs ZED-902 merged'], missingData: ['no team with three levels'] } });
  } finally {
    await dock.close();
    rmrf(base);
  }
});

test('checkpoint omits empty notes and absent agent, and cuts the text to 400 chars', async () => {
  const dock = await startServer(() => ({ json: { ok: true, result: { recorded: true } } }));
  const { base, status } = scratch('checkpoint-trim', dock.url);
  try {
    const r = await status('checkpoint', 'ZED-901', 'planner', `  ${'x'.repeat(450)}  `);
    assert.equal(r.code, 0);
    const body = dock.requests[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['key', 'step', 'text']);
    assert.equal(body.text.length, 400);
  } finally {
    await dock.close();
    rmrf(base);
  }
});

test('checkpoint exits 0 when DOCK is off on its side, refuses, is unreachable or not configured', async () => {
  const off = await startServer(() => ({ json: { ok: true, result: { recorded: false, reason: 'off' } } }));
  const bare = await startServer(() => ({ json: { recorded: false, reason: 'off' } }));
  const failing = await startServer(() => ({ status: 500, json: { ok: false } }));
  const gone = await startServer();
  const goneUrl = gone.url;
  await gone.close();
  const cases = [
    [off.url, /checkpoint skipped: off on DOCK/],
    [bare.url, /checkpoint skipped: off on DOCK/],
    [failing.url, /checkpoint skipped: DOCK answered 500/],
    [goneUrl, /checkpoint skipped: DOCK not reachable/],
    [null, /checkpoint skipped: DOCK is not configured/],
  ];
  try {
    for (const [url, expect] of cases) {
      const { base, status } = scratch('checkpoint-off', url);
      try {
        const r = await status('checkpoint', 'ZED-901', 'video', 'Video sudah diunggah.');
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, expect);
        assert.equal(r.stdout.trim().split(/\r?\n/).length, 1);
      } finally { rmrf(base); }
    }
  } finally {
    await off.close(); await bare.close(); await failing.close();
  }
});

test('checkpoint times out on a DOCK that never answers and still exits 0', async () => {
  const hang = await startServer(() => ({ hang: true }));
  const { base, status } = scratch('checkpoint-hang', hang.url);
  try {
    const started = Date.now();
    const r = await status('checkpoint', 'ZED-901', 'publish', 'PR sudah dibuka.');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /checkpoint skipped: DOCK not reachable \(timeout\)/);
    assert.ok(Date.now() - started < 15000);
  } finally {
    await hang.close();
    rmrf(base);
  }
});

test('checkpoint without a step or text prints usage and exits 0 without calling DOCK', async () => {
  const dock = await startServer();
  const { base, status } = scratch('checkpoint-usage', dock.url);
  try {
    const r = await status('checkpoint', 'ZED-901', 'planner');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /checkpoint skipped: usage/);
    assert.equal(dock.requests.length, 0);
  } finally {
    await dock.close();
    rmrf(base);
  }
});

test('decide and issue store textId and optionsId; without the flags the entries are unchanged', async () => {
  const { base, status, ledger } = scratch('ledger-id', null);
  try {
    await status('init', 'ZED-902', 'Invented', '-', '-', '-', '-');
    let r = await status('decide', 'ZED-902', 'disable Save on an empty form', '--status', 'GUESS', '--by', 'sous-arbiter',
      '--alt', 'show an error::the button stays active', '--id', 'Tombol Save mati kalau form kosong', '--options-id', 'Tampilkan error saat Save');
    assert.equal(r.code, 0, r.stdout);
    r = await status('decide', 'ZED-902', 'plain decision');
    r = await status('decide', 'ZED-902', 'two alts', '--alt', 'a', '--alt', 'b', '--options-id', 'cuma satu');
    assert.match(r.stdout, /--options-id dropped/);
    r = await status('issue', 'ZED-902', 'QUESTION', 'which label?', '--options', 'Save::saves|Submit::sends', '--id', 'Labelnya apa?', '--options-id', 'Simpan|Kirim');
    assert.equal(r.code, 0, r.stdout);
    r = await status('issue', 'ZED-902', 'RISK', 'plain issue');
    const s = ledger('ZED-902');
    assert.equal(s.decisions[0].textId, 'Tombol Save mati kalau form kosong');
    assert.deepEqual(s.decisions[0].optionsId, ['Tampilkan error saat Save']);
    assert.equal(s.decisions[0].text, 'disable Save on an empty form');
    assert.ok(!('textId' in s.decisions[1]) && !('optionsId' in s.decisions[1]));
    assert.ok(!('optionsId' in s.decisions[2]));
    assert.equal(s.issues[0].textId, 'Labelnya apa?');
    assert.deepEqual(s.issues[0].options, ['Save', 'Submit']);
    assert.deepEqual(s.issues[0].optionsId, ['Simpan', 'Kirim']);
    assert.ok(!('textId' in s.issues[1]) && !('optionsId' in s.issues[1]));
  } finally { rmrf(base); }
});

test('set qaMenu stores the menu path and qaMenu= clears it', async () => {
  const { base, status, ledger } = scratch('ledger-qamenu', null);
  try {
    await status('init', 'ZED-903', 'Invented', '-', '-', '-', '-');
    let r = await status('set', 'ZED-903', 'qaMenu=Team Management › Alpha › Level Access');
    assert.equal(r.code, 0, r.stdout);
    assert.equal(ledger('ZED-903').qaMenu, 'Team Management › Alpha › Level Access');
    r = await status('set', 'ZED-903', 'qaMenu=');
    assert.ok(!('qaMenu' in ledger('ZED-903')));
  } finally { rmrf(base); }
});
