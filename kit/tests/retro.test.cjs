'use strict';
// retro.cjs: the sprint data read from scratch ledgers, and the Keep / Problem / Try draft posted to a local fake of DOCK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, runNode, sandboxEnv, startServer } = require('./helpers.cjs');

function scratch(label, extra = {}) {
  const base = tmp(label);
  const evidence = path.join(base, 'evidence');
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const env = { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence, DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '', ...extra };
  const retro = (...args) => runNode([path.join(KIT, 'retro.cjs'), ...args], { env });
  const write = (key, ledger) => {
    fs.mkdirSync(path.join(evidence, key), { recursive: true });
    fs.writeFileSync(path.join(evidence, key, 'status.json'), JSON.stringify({ key, ...ledger }));
  };
  return { base, evidence, retro, write };
}

const LEDGER = {
  title: 'Invented', stage: 'done', createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-21T08:00:00.000Z',
  closing: { at: '2026-10-21T08:00:00.000Z', hours: 24, fixRounds: 1, failures: { defect: 1 }, replans: 0 },
  rounds: { used: 1, max: 2, log: [{ at: '2026-10-20T12:00:00.000Z', used: 1, max: 2, why: 'FINAL: empty state missing' }] },
  failures: [{ at: '2026-10-20T10:00:00.000Z', type: 'defect', attempt: 1, what: 'T1: jest red' }],
  findings: [{ at: '2026-10-20T12:00:00.000Z', severity: 'blocker', text: 'T2: empty state missing' }],
  issues: [{ n: 1, at: '2026-10-20T09:00:00.000Z', type: 'QUESTION', text: 'A or B?', level: 'owner', status: 'resolved', resolvedAt: '2026-10-20T11:30:00.000Z',
    escalations: [{ at: '2026-10-20T09:30:00.000Z', to: 'owner', why: 'scope' }] }],
  decisions: [{ at: '2026-10-20T09:00:00.000Z', text: 'old flow' },
    { n: 2, at: '2026-10-20T11:30:00.000Z', text: 'take B', status: 'DECIDED', by: 'owner', question: 'A or B?', rejected: [{ option: 'A', why: 'breaks saved data' }] }],
  verdict: { value: 'approve' },
};

test('data reads the sprint ledgers from --keys, sprint.md or a date window', async () => {
  const { base, evidence, retro, write } = scratch('retro-data');
  try {
    write('ZED-501', LEDGER);
    write('ZED-502', { title: 'Other', stage: 'code', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' });
    let r = await retro('data', 'ZED Sprint 9', '--keys', 'ZED-501,ZED-777');
    const out = JSON.parse(r.stdout);
    assert.equal(out.source, 'jira');
    assert.deepEqual(out.noLedger, ['ZED-777']);
    const [t] = out.tickets;
    assert.deepEqual([t.key, t.hours, t.fixRounds, t.verdict], ['ZED-501', 24, 1, 'approve']);
    assert.deepEqual(t.rounds, { used: 1, max: 2, why: ['FINAL: empty state missing'] });
    assert.deepEqual(t.failures, [{ type: 'defect', what: 'T1: jest red', at: '2026-10-20T10:00:00.000Z' }]);
    assert.deepEqual(t.findings, [{ severity: 'blocker', text: 'T2: empty state missing', resolved: false }]);
    assert.deepEqual(t.ownerIssues, [{ n: 1, type: 'QUESTION', text: 'A or B?', escalatedAt: '2026-10-20T09:30:00.000Z', resolvedAt: '2026-10-20T11:30:00.000Z', waitHours: 2 }]);
    assert.deepEqual(t.decisions[0], { n: 1, status: 'DECIDED', by: 'owner', text: 'old flow' });
    assert.deepEqual(t.decisions[1].rejected, [{ option: 'A', why: 'breaks saved data' }]);
    fs.writeFileSync(path.join(evidence, 'sprint.md'), '# Sprint 9 blackboard - ZED Sprint 9\n\n| ZED-502 | x |\n');
    r = await retro('data', 'ZED Sprint 9');
    assert.deepEqual([JSON.parse(r.stdout).source, JSON.parse(r.stdout).tickets.map((x) => x.key)], ['sprint.md', ['ZED-502']]);
    r = await retro('data', 'ZED Sprint 10', '--since', '2026-10-19T00:00:00Z', '--until', '2026-10-22T00:00:00Z');
    assert.deepEqual([JSON.parse(r.stdout).source, JSON.parse(r.stdout).tickets.map((x) => x.key)], ['dates', ['ZED-501']]);
    r = await retro('data', 'ZED Sprint 10');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /REFUSED: no way to tell which ledgers/);
  } finally {
    rmrf(base);
  }
});

test('post sends the exact /retro body, drops lines without ticket evidence and refuses a bad kind or dest', async () => {
  const dock = await startServer();
  const { base, retro } = scratch('retro-post', { DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' });
  try {
    const file = path.join(base, 'draft.json');
    const draft = (items) => fs.writeFileSync(file, JSON.stringify({ sprint: 'ZED Sprint 9', items }));
    draft([
      { kind: 'keep', text: 'arbiter settled issues without the owner', evidence: ['ZED-501: I-1 resolved by D-2 in 2h'], extra: 'not sent' },
      { kind: 'problem', text: 'no evidence here', evidence: ['it felt slow'] },
      { kind: 'try', text: 'runner checks the empty state before FINAL', evidence: ['ZED-501: FINAL finding T2 empty state missing', ' '], dest: 'kit' },
    ]);
    let r = await retro('post', `@${file}`);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /dropped, no ticket evidence: no evidence here/);
    assert.match(r.stdout, /posted 2 lines for ZED Sprint 9/);
    assert.equal(dock.requests.length, 1);
    const [req] = dock.requests;
    assert.deepEqual([req.method, req.url, req.headers.authorization], ['POST', '/ingest/orchestrator/retro', 'Bearer dock_ing_test']);
    assert.deepEqual(req.body, { sprint: 'ZED Sprint 9', items: [
      { kind: 'keep', text: 'arbiter settled issues without the owner', evidence: ['ZED-501: I-1 resolved by D-2 in 2h'], dest: 'note' },
      { kind: 'try', text: 'runner checks the empty state before FINAL', evidence: ['ZED-501: FINAL finding T2 empty state missing'], dest: 'kit' },
    ] });
    for (const items of [[{ kind: 'idea', text: 'x', evidence: ['ZED-1'] }], [{ kind: 'try', text: 'x', evidence: ['ZED-1'] }],
      [{ kind: 'keep', text: 'x', evidence: ['ZED-1'], dest: 'kit' }], [{ kind: 'problem', text: 'x', evidence: [] }]]) {
      draft(items);
      r = await retro('post', `@${file}`);
      assert.equal(r.code, 2, JSON.stringify(items));
    }
    assert.equal(dock.requests.length, 1, 'nothing more was sent');
    draft([{ kind: 'try', text: 'x', evidence: ['CARD-retro-x: note'], dest: 'memory' }]);
    r = await retro('post', `@${file}`, '--dry-run');
    assert.deepEqual(JSON.parse(r.stdout), { sprint: 'ZED Sprint 9', items: [{ kind: 'try', text: 'x', evidence: ['CARD-retro-x: note'], dest: 'memory' }] });
    assert.equal(dock.requests.length, 1);
  } finally {
    await dock.close();
    rmrf(base);
  }
});
