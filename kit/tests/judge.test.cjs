'use strict';
// kit/judge.cjs: the Judge result validated offline and posted to a local fake of DOCK's /judge route; retro.cjs carries source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { request, run } = require('../judge.cjs');
const { KIT, tmp, rmrf, runNode, sandboxEnv, startServer } = require('./helpers.cjs');

const files = (map) => (f) => { if (!(f in map)) throw new Error('ENOENT'); return map[f]; };
const quiet = () => { const lines = { out: [], err: [] }; return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) }; };
const FINDING = { messageId: 'm-41', cause: 'stopped-with-way-out', text: 'Conflict went to the owner as BLOCKER I-8.', quote: 'Isu I-8 (BLOCKER) naik ke kamu.', shouldHave: 'Hand the rebase to the lead.', call: 'mistake' };
const RESULT = { sessionId: 'a3c23286', untilMessageId: 'm-90', findings: [FINDING, { threadUrl: 'https://discord.com/channels/1/2/3', cause: 'wrong-code', text: ' Reviewer blocker. ', quote: 'v1 not restorable', shouldHave: 'Re-read sibling tickets.', call: 'not', grade: 'D' }], ownerWaitMinutes: 90.4, grade: 'C' };

test('check prints the exact body: no grade, trimmed text, "-" until is null, extra keys dropped', async () => {
  const io = quiet();
  const never = async () => { throw new Error('check must not ask DOCK'); };
  assert.equal(await run(['check', 'r.json'], { send: never, readFile: files({ 'r.json': '﻿' + JSON.stringify(RESULT) }), ...io }), 0);
  assert.deepEqual(JSON.parse(io.lines.out[0]), {
    sessionId: 'a3c23286', untilMessageId: 'm-90', ownerWaitMinutes: 90,
    findings: [FINDING, { threadUrl: 'https://discord.com/channels/1/2/3', cause: 'wrong-code', text: 'Reviewer blocker.', quote: 'v1 not restorable', shouldHave: 'Re-read sibling tickets.', call: 'not' }],
  });
  const none = request(['check', 'n.json'], files({ 'n.json': JSON.stringify({ sessionId: 's1', untilMessageId: '-', findings: [] }) }));
  assert.deepEqual(none.body, { sessionId: 's1', untilMessageId: null, findings: [], ownerWaitMinutes: 0 }, 'a session without findings is a valid result');
});

test('a result that does not fit the contract is refused locally with exit 1 and DOCK is not asked', async () => {
  const never = async () => { throw new Error('should not ask DOCK'); };
  const bad = (patch) => JSON.stringify({ ...RESULT, ...patch });
  const finding = (patch) => bad({ findings: [{ ...FINDING, ...patch }] });
  const cases = [
    [bad({ sessionId: '' }), /sessionId must be/],
    [bad({ findings: 'none' }), /findings must be an array/],
    [bad({ untilMessageId: { id: 1 } }), /untilMessageId must be/],
    [bad({ ownerWaitMinutes: -5 }), /ownerWaitMinutes must be/],
    [finding({ cause: 'laziness' }), /cause must be one of stopped-with-way-out/],
    [finding({ call: 'maybe' }), /call must be mistake or not/],
    [finding({ quote: ' ' }), /finding 1: quote must be a non-empty string/],
    [finding({ shouldHave: undefined }), /shouldHave must be/],
    [finding({ threadUrl: 'discord thread' }), /threadUrl must be an http/],
    ['{not json', /cannot read r\.json/],
  ];
  for (const [text, want] of cases) {
    const io = quiet();
    assert.equal(await run(['post', 'r.json'], { send: never, readFile: files({ 'r.json': text }), ...io }), 1, String(want));
    assert.match(io.lines.err.join('\n'), want);
  }
  for (const argv of [[], ['grade', 'r.json'], ['post']]) {
    const io = quiet();
    assert.equal(await run(argv, { send: never, ...io }), 1, argv.join(' '));
  }
});

test('post reaches DOCK /judge with the ingest auth; refusing is exit 3, down or unconfigured is exit 1', async () => {
  const dir = tmp('judge-post');
  let status = 200;
  const dock = await startServer(() => (status === 200 ? { json: { ok: true, result: { stored: 2 } } } : { status, json: { ok: false, error: status === 400 ? 'unknown session' : 'bad gateway' } }));
  try {
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, JSON.stringify(RESULT));
    const env = { ...sandboxEnv(dir), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' };
    let r = await runNode([path.join(KIT, 'judge.cjs'), 'post', file], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).stored, 2);
    const [req] = dock.requests;
    assert.deepEqual([req.method, req.url, req.headers.authorization], ['POST', '/ingest/orchestrator/judge', 'Bearer dock_ing_test']);
    assert.equal(req.body.sessionId, 'a3c23286');
    assert.ok(!('grade' in req.body) && req.body.findings.every((f) => !('grade' in f)), 'DOCK computes the grade');
    status = 400;
    r = await runNode([path.join(KIT, 'judge.cjs'), 'post', file], { env });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /DOCK refused \(400\): unknown session/);
    status = 502;
    r = await runNode([path.join(KIT, 'judge.cjs'), 'post', file], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /DOCK answered 502/);
    r = await runNode([path.join(KIT, 'judge.cjs'), 'post', file], { env: { ...sandboxEnv(dir), DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not configured/);
    assert.equal(dock.requests.length, 3);
  } finally {
    await dock.close();
    rmrf(dir);
  }
});

test('retro.cjs post: source judge is sent per line, a line without source is unchanged, an unknown source is refused', async () => {
  const dir = tmp('retro-source');
  try {
    const file = path.join(dir, 'draft.json');
    const env = { ...sandboxEnv(dir), QONFLO_EVIDENCE: path.join(dir, 'evidence'), DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '' };
    fs.writeFileSync(file, JSON.stringify({ sprint: 'ZED Sprint 9', items: [
      { kind: 'problem', text: 'guard refusal went to the owner', evidence: ['QA-ZED-516 (a3c23286): BLOCKER I-8'], source: 'judge' },
      { kind: 'try', text: 'hand guard refusals to the lead', evidence: ['ZED-516: I-8'], dest: 'kit', source: 'judge' },
      { kind: 'keep', text: 'ledger line', evidence: ['ZED-501: approve'] },
    ] }));
    let r = await runNode([path.join(KIT, 'retro.cjs'), 'post', `@${file}`, '--dry-run'], { env });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).items, [
      { kind: 'problem', text: 'guard refusal went to the owner', evidence: ['QA-ZED-516 (a3c23286): BLOCKER I-8'], dest: 'note', source: 'judge' },
      { kind: 'try', text: 'hand guard refusals to the lead', evidence: ['ZED-516: I-8'], dest: 'kit', source: 'judge' },
      { kind: 'keep', text: 'ledger line', evidence: ['ZED-501: approve'], dest: 'note' },
    ]);
    fs.writeFileSync(file, JSON.stringify({ sprint: 'ZED Sprint 9', items: [{ kind: 'keep', text: 'x', evidence: ['ZED-1'], source: 'gut' }] }));
    r = await runNode([path.join(KIT, 'retro.cjs'), 'post', `@${file}`, '--dry-run'], { env });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /source must be one of ledger, judge/);
  } finally {
    rmrf(dir);
  }
});
