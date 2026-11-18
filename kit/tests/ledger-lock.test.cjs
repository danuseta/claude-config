'use strict';
// status.cjs ledger writes: the per-ticket lock, the atomic write, the new status.md, the local history repo and `check`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { KIT, tmp, rmrf, runNode, sandboxEnv } = require('./helpers.cjs');

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function scratch(label, evidenceDir) {
  const base = tmp(label);
  const evidence = evidenceDir ? evidenceDir(base) : path.join(base, 'evidence');
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const status = (...args) => runNode([path.join(KIT, 'status.cjs'), ...args], { env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence } });
  const ledger = (key) => JSON.parse(fs.readFileSync(path.join(evidence, key, 'status.json'), 'utf8'));
  const history = () => execFileSync('git', ['--git-dir', path.join(evidence, '.git'), 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');
  return { base, evidence, status, ledger, history };
}

test('parallel writers on one ledger keep every row', async () => {
  const { base, evidence, status, ledger } = scratch('lock-parallel');
  try {
    await status('init', 'ZED-501', 'Invented', '-', '-', '-', '-');
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => status('decide', 'ZED-501', `row ${i}`)));
    for (const r of runs) assert.equal(r.code, 0, r.stdout);
    const s = ledger('ZED-501');
    assert.deepEqual(s.decisions.map((d) => d.text).sort(), Array.from({ length: 6 }, (_, i) => `row ${i}`));
    assert.deepEqual(s.decisions.map((d) => d.n).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(fs.readdirSync(path.join(evidence, '.locks')), [], 'every lock released');
    assert.deepEqual(fs.readdirSync(path.join(evidence, 'ZED-501')), ['status.json'], 'no temp file left');
  } finally {
    rmrf(base);
  }
});

test('a stale ledger lock is taken over: dead pid on this host, or older than a minute', async () => {
  const { base, evidence, status, ledger } = scratch('lock-stale');
  try {
    await status('init', 'ZED-502', 'Invented', '-', '-', '-', '-');
    const lock = path.join(evidence, '.locks', 'ledger-ZED-502.lock');
    fs.writeFileSync(lock, JSON.stringify({ token: 'old', pid: 999999, host: os.hostname(), at: new Date().toISOString() }));
    let r = await status('set', 'ZED-502', 'note=first');
    assert.equal(r.code, 0, r.stdout);
    assert.ok(!fs.existsSync(lock));
    fs.writeFileSync(lock, JSON.stringify({ token: 'old', pid: 1, host: 'elsewhere', at: '2026-01-01T00:00:00.000Z' }));
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    r = await status('set', 'ZED-502', 'note=second');
    assert.equal(r.code, 0, r.stdout);
    assert.equal(ledger('ZED-502').note, 'second');
    assert.ok(!fs.existsSync(lock));
  } finally {
    rmrf(base);
  }
});

test('status.md has a Now block, one section per day, short lines and superseded decisions folded', async () => {
  const { base, evidence, status, ledger } = scratch('status-md');
  try {
    await status('init', 'ZED-503', 'Close session', '-', '-', '-', '-');
    const s = ledger('ZED-503');
    Object.assign(s, {
      stage: 'pr', waiting: '',
      history: [{ at: '2026-11-12T09:40:00.000Z', from: 'gate', to: 'plan' }, { at: '2026-11-13T08:00:00.000Z', from: 'plan', to: 'pr' }],
      decisions: [
        { n: 1, at: '2026-11-12T09:41:00.000Z', text: `contract from the saved copy ${'x'.repeat(300)}`, status: 'SUPERSEDED', by: 'sous-ticket-runner', supersededBy: 2 },
        { n: 2, at: '2026-11-12T09:45:00.000Z', text: 'owner confirmed the saved copy', status: 'DECIDED', by: 'owner', replaces: 1 },
      ],
      issues: [{ n: 1, at: '2026-11-12T09:58:00.000Z', type: 'RISK', text: 'held sessions', level: 'arbiter', status: 'open' }],
      findings: [{ at: '2026-11-13T08:10:00.000Z', severity: 'nit', text: 'rename' }],
    });
    fs.writeFileSync(path.join(evidence, 'ZED-503', 'status.json'), JSON.stringify(s));
    await status('render', 'ZED-503');
    const md = fs.readFileSync(path.join(evidence, 'blackboard', 'ZED-503', 'status.md'), 'utf8');
    assert.match(md, /^<!-- generated, do not edit/);
    assert.match(md, /# Status - ZED-503 · Close session/);
    assert.match(md, /## Now\n\n- Stage: pr\n- Waiting on: -\n- Open issues: 1 · open findings: 1 · decisions in force: 1 \(1 superseded\)/);
    assert.match(md, /## 2026-11-12 Thu\n\n- 09:40 · STAGE · gate -> plan\n- 09:45 · DECISION · D-2 DECIDED by owner: owner confirmed the saved copy\n- 09:58 · ISSUE-OPEN · I-1 RISK: held sessions/);
    assert.match(md, /## 2026-11-13 Fri\n\n- 08:00 · STAGE · plan -> pr\n- 08:10 · FINDING · nit: rename/);
    const [log, folded] = md.split('## Superseded decisions (1)');
    assert.doesNotMatch(log, /D-1/);
    assert.match(folded, /<details>[\s\S]*- 2026-11-12 09:41 · D-1 -> D-2 by sous-ticket-runner: contract from the saved copy x+…\n/);
    assert.ok(md.split('\n').every((l) => l.length < 260), 'every line is short');
  } finally {
    rmrf(base);
  }
});

test('every writing command is one commit in the local history repo; a read is none', { skip: !hasGit }, async () => {
  const { base, status, history } = scratch('history');
  try {
    await status('init', 'ZED-504', 'Invented', '-', '-', '-', '-');
    await status('set', 'ZED-504', 'engine=sous', 'stage=code');
    await status('show', 'ZED-504');
    await status('decide', 'ZED-504', 'keep it');
    assert.deepEqual(history(), ['status.cjs decide ZED-504 keep it', 'status.cjs set ZED-504 engine=sous stage=code', 'status.cjs init ZED-504 Invented - - - -']);
  } finally {
    rmrf(base);
  }
});

test('the history repo stays its own when the evidence folder is ignored by an outer repo', { skip: !hasGit }, async () => {
  const { base, status, history } = scratch('history-nested', (b) => path.join(b, 'outer', '.evidence'));
  try {
    const outer = path.join(base, 'outer');
    fs.mkdirSync(outer, { recursive: true });
    execFileSync('git', ['init', '-q', outer]);
    fs.writeFileSync(path.join(outer, '.gitignore'), '/.evidence/*\n');
    await status('init', 'ZED-505', 'Invented', '-', '-', '-', '-');
    assert.deepEqual(history(), ['status.cjs init ZED-505 Invented - - - -']);
    assert.equal(execFileSync('git', ['-C', outer, 'rev-list', '--all'], { encoding: 'utf8' }).trim(), '', 'outer repo has no commit');
  } finally {
    rmrf(base);
  }
});

test('check finds a hand edit of decisions.md, records it as a problem and is quiet after', { skip: !hasGit }, async () => {
  const { base, evidence, status, ledger } = scratch('check');
  try {
    await status('init', 'ZED-506', 'Invented', '-', '-', '-', '-');
    await status('set', 'ZED-506', 'engine=sous');
    await status('decide', 'ZED-506', 'keep the Pending label');
    let r = await status('check', 'ZED-506');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no ledger file changed outside status\.cjs for ZED-506/);
    const decisions = path.join(evidence, 'blackboard', 'ZED-506', 'decisions.md');
    fs.writeFileSync(decisions, fs.readFileSync(decisions, 'utf8').replace('keep the Pending label', 'drop the Pending label'));
    r = await status('check', 'ZED-506');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^M blackboard\/ZED-506\/decisions\.md$/m);
    assert.match(r.stdout, /recorded as a problem on ZED-506/);
    const failure = ledger('ZED-506').failures.at(-1);
    assert.deepEqual([failure.type, failure.what, failure.evidence], ['env', 'ledger edited outside status.cjs', 'M blackboard/ZED-506/decisions.md']);
    assert.match(fs.readFileSync(path.join(evidence, 'blackboard', 'ZED-506', 'status.md'), 'utf8'), /FAIL · env #1 ledger edited outside status\.cjs/);
    r = await status('check');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no ledger file changed outside status\.cjs/);
  } finally {
    rmrf(base);
  }
});
