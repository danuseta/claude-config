'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmp, rmrf, KIT } = require('./helpers.cjs');

const LOCAL = path.join(KIT, 'qa-local');
const { resolveLocalPaths } = require(path.join(LOCAL, 'lib', 'paths.cjs'));

test('code dir is the kit folder, kit is its parent, data stays in ~/qa-local', () => {
  const home = tmp('qa-local-home');
  try {
    const p = resolveLocalPaths({}, home);
    assert.equal(p.code, LOCAL);
    assert.equal(p.kit, KIT);
    assert.equal(p.data, path.join(home, 'qa-local'));
    assert.deepEqual(p.pwCandidates, [
      path.join(home, 'qa', 'node_modules', '@playwright', 'test', 'cli.js'),
      path.join(LOCAL, 'node_modules', '@playwright', 'test', 'cli.js'),
    ]);
  } finally { rmrf(home); }
});

test('QA_LOCAL_DIR overrides the data dir only', () => {
  const p = resolveLocalPaths({ QA_LOCAL_DIR: '/data/x' }, os.homedir());
  assert.equal(p.data, '/data/x');
  assert.equal(p.code, LOCAL);
});

test('compute-verdict resolves only from QA_COMPUTE_VERDICT or the installed skill', () => {
  const home = tmp('qa-local-cv');
  try {
    assert.equal(resolveLocalPaths({}, home).computeVerdict, null);
    const installed = path.join(home, '.claude', 'skills', 'skill-qonflo-qa', 'scripts', 'compute-verdict.mjs');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '');
    assert.equal(resolveLocalPaths({}, home).computeVerdict, installed);
    const custom = path.join(home, 'custom.mjs');
    fs.writeFileSync(custom, '');
    assert.equal(resolveLocalPaths({ QA_COMPUTE_VERDICT: custom }, home).computeVerdict, custom);
    assert.equal(resolveLocalPaths({ QA_COMPUTE_VERDICT: path.join(home, 'nope.mjs') }, home).computeVerdict, installed);
  } finally { rmrf(home); }
});

test('the runner help names the data dir and the kit README', () => {
  const home = tmp('qa-local-help');
  try {
    const data = path.join(home, 'data');
    const r = spawnSync(process.execPath, [path.join(LOCAL, 'lib', 'main.cjs'), '--help'], { encoding: 'utf8', env: { ...process.env, QA_LOCAL_DIR: data }, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`${data}/tests/<KEY>/`) || r.stdout.includes(`${data}${path.sep}tests`), r.stdout.slice(0, 300));
    assert.ok(r.stdout.includes(`${LOCAL}/README.md`));
  } finally { rmrf(home); }
});

test('install.sh links the command to the kit wrapper without needing npm', () => {
  const home = tmp('qa-local-install');
  try {
    const bin = path.join(home, 'bin');
    const env = { ...process.env, QA_LOCAL_BIN_DIR: bin, QA_LOCAL_PW_HOME: path.join(home, 'qa'), QA_LOCAL_SKIP_NPM: '1' };
    const r = spawnSync('bash', [path.join(LOCAL, 'install.sh')], { encoding: 'utf8', env, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const link = path.join(bin, 'qonflo-qa-local');
    assert.ok(fs.existsSync(link));
    const wrapper = path.join(LOCAL, 'bin', 'qonflo-qa-local');
    if (fs.lstatSync(link).isSymbolicLink()) assert.equal(fs.realpathSync(link), fs.realpathSync(wrapper));
    else assert.equal(fs.readFileSync(link, 'utf8'), fs.readFileSync(wrapper, 'utf8'));
  } finally { rmrf(home); }
});

const MAIN = path.join(LOCAL, 'lib', 'main.cjs');
const runMain = (args, data) => spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', env: { ...process.env, QA_LOCAL_DIR: data }, timeout: 60000 });

test('--triage-stop writes a done ESCALATED run folder with the reason code and starts nothing', () => {
  const data = tmp('qa-local-ts');
  try {
    const r = runMain(['QRD-1234', '--triage-stop', 'PIHAK_KETIGA', 'AC-2 needs a real WhatsApp number'], data);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    const [stamp] = fs.readdirSync(path.join(data, 'runs', 'QRD-1234'));
    const dir = path.join(data, 'runs', 'QRD-1234', stamp);
    const prog = JSON.parse(fs.readFileSync(path.join(dir, 'progress.json'), 'utf8'));
    assert.equal(prog.schema, 'qonflo-qa-local-progress/1');
    assert.equal(prog.state, 'done');
    assert.equal(prog.verdict, 'ESCALATED');
    assert.equal(prog.rule, 'J-ESCALATED');
    assert.equal(prog.error, null);
    assert.deepEqual(prog.tcs, []);
    assert.deepEqual(prog.steps.map((s) => s.state), ['skipped', 'skipped', 'skipped', 'done']);
    assert.deepEqual(prog.counts, { Passed: 0, 'Passed with Note': 0, Failed: 0, Blocked: 0 });
    const res = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(res.verdict.prediction, 'ESCALATED');
    assert.equal(res.reasonCode, 'PIHAK_KETIGA');
    assert.equal(res.stoppedAt, 'triage');
    assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /PIHAK_KETIGA[\s\S]*real WhatsApp number/);
    assert.equal(fs.existsSync(path.join(data, '.run.lock')), false);
  } finally { rmrf(data); }
});

test('--triage-stop FE_LINKED --fe writes followsFe and verdict FOLLOWS_FE instead of ESCALATED', () => {
  const data = tmp('qa-local-fe');
  try {
    const r = runMain(['QRD-1579', '--triage-stop', 'FE_LINKED', 'QRD-1579 blocks QRD-1582 [FE] (To Do, no QA result yet)', '--fe', 'qrd-1582', '--fe-status', 'To Do'], data);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    const [stamp] = fs.readdirSync(path.join(data, 'runs', 'QRD-1579'));
    const dir = path.join(data, 'runs', 'QRD-1579', stamp);
    const prog = JSON.parse(fs.readFileSync(path.join(dir, 'progress.json'), 'utf8'));
    assert.equal(prog.verdict, 'FOLLOWS_FE');
    assert.equal(prog.rule, 'J-FOLLOWS-FE');
    assert.deepEqual(prog.followsFe, { key: 'QRD-1582', status: 'To Do' });
    const res = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(res.verdict.prediction, 'FOLLOWS_FE');
    assert.equal(res.reasonCode, 'FE_LINKED');
    assert.deepEqual(res.followsFe, { key: 'QRD-1582', status: 'To Do' });
    assert.equal(res.tickets[0].ticketStatus, 'FOLLOWS_FE');
    assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /Follows FE: QRD-1582 \(To Do\)/);
  } finally { rmrf(data); }
});

test('--triage-stop FE_LINKED without --fe stays ESCALATED; --fe needs FE_LINKED and a key', () => {
  const data = tmp('qa-local-fe2');
  try {
    assert.equal(runMain(['QRD-1', '--triage-stop', 'LAINNYA', 'why', '--fe', 'QRD-2'], data).status, 2);
    assert.equal(runMain(['QRD-1', '--triage-stop', 'FE_LINKED', 'why', '--fe', 'wt-2-fe'], data).status, 2);
    assert.equal(runMain(['QRD-1', '--triage-stop', 'FE_LINKED', 'why', '--fe-status', 'To Do'], data).status, 2);
    assert.equal(fs.existsSync(path.join(data, 'runs')), false);
    const r = runMain(['QRD-1', '--triage-stop', 'FE_LINKED', 'candidate QRD-2 not sure'], data);
    assert.equal(r.status, 3, r.stderr);
    const [stamp] = fs.readdirSync(path.join(data, 'runs', 'QRD-1'));
    const res = JSON.parse(fs.readFileSync(path.join(data, 'runs', 'QRD-1', stamp, 'results.json'), 'utf8'));
    assert.equal(res.verdict.prediction, 'ESCALATED');
    assert.equal(res.followsFe, undefined);
  } finally { rmrf(data); }
});

test('--triage-stop refuses an unknown code, a missing reason, and an active run', () => {
  const data = tmp('qa-local-ts2');
  try {
    assert.equal(runMain(['QRD-1', '--triage-stop', 'NOPE', 'x'], data).status, 2);
    assert.equal(runMain(['QRD-1', '--triage-stop', 'LAINNYA'], data).status, 2);
    assert.equal(runMain(['QRD-1', '--triage-stop', 'LAINNYA', '  '], data).status, 2);
    fs.writeFileSync(path.join(data, '.run.lock.1'), JSON.stringify({ pid: process.pid, key: 'QRD-1', at: new Date().toISOString() }));
    const busy = runMain(['QRD-1', '--triage-stop', 'LAINNYA', 'why'], data);
    assert.equal(busy.status, 5);
    assert.equal(fs.existsSync(path.join(data, 'runs')), false);
  } finally { rmrf(data); }
});

test('qa-local judge: most failed TCs stopping on one locator are Blocked as setup out of date, not REVISION', () => {
  const { markSharedSetup, qaStatus } = require('../qa-local/lib/judge.cjs');
  const stale = 'Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole(\'button\', { name: \'New Workflow\' })\nExpected: visible';
  const tc = (id, error) => ({ id, error, kind: 'assertion', ...qaStatus({ kind: 'assertion' }) });
  const tcs = [tc('T1', stale), tc('T2', stale), tc('T3', stale), tc('T4', stale), tc('T5', 'Error: expect(locator).toHaveCount(expected) failed\n\nLocator: getByText(\'qa-folder\')'), { id: 'T6', kind: 'pass', ...qaStatus({ kind: 'pass' }) }];
  assert.deepEqual(markSharedSetup(tcs), { locator: "getByRole('button', { name: 'New Workflow' })", count: 4, failed: 5 });
  assert.deepEqual(tcs.map((t) => t.qaStatus), ['Blocked', 'Blocked', 'Blocked', 'Blocked', 'Failed', 'Passed']);
  assert.equal(tcs[0].kind, 'setup');
  const real = [tc('A', stale), tc('B', 'Error: expect(x).toBe(y)\n\nLocator: getByText(\'a\')'), tc('C', 'Error: expect(x).toBe(y)\n\nLocator: getByText(\'b\')')];
  assert.equal(markSharedSetup(real), null, 'different failures stay REVISION');
  assert.equal(markSharedSetup([tc('A', stale), tc('B', stale)]), null, 'two failures are too few to call it setup');
});

test('two runs at a time by default, never two of one ticket; dead locks are taken over', () => {
  const home = tmp('qa-local-slots');
  try {
    const data = path.join(home, 'data');
    fs.mkdirSync(data, { recursive: true });
    const run = (key, env = {}) => spawnSync(process.execPath, [path.join(LOCAL, 'lib', 'main.cjs'), key, '--triage-stop', 'LAINNYA', 'slot test'], { encoding: 'utf8', env: { ...process.env, QA_LOCAL_DIR: data, ...env }, timeout: 60000 });
    const hold = (name, key) => fs.writeFileSync(path.join(data, name), JSON.stringify({ pid: process.pid, key }));
    hold('.run.lock.1', 'QRD-1');
    assert.equal(run('QRD-1').status, 5, 'the same ticket waits');
    assert.equal(run('QRD-2').status, 3, 'a second ticket gets slot 2');
    assert.ok(!fs.existsSync(path.join(data, '.run.lock.2')), 'slot 2 is released after the run');
    hold('.run.lock.2', 'QRD-2');
    const full = run('QRD-3');
    assert.equal(full.status, 5);
    assert.match(full.stderr, /2 runs are active \(QRD-1, QRD-2\)/);
    assert.equal(run('QRD-3', { QA_LOCAL_MAX_RUNS: '3' }).status, 3, 'QA_LOCAL_MAX_RUNS raises the limit');
    fs.writeFileSync(path.join(data, '.run.lock.2'), JSON.stringify({ pid: 999999999, key: 'QRD-2' }));
    assert.equal(run('QRD-3').status, 3, 'a lock whose process died is taken over');
    fs.rmSync(path.join(data, '.run.lock.1'));
    hold('.run.lock', 'QRD-9');
    hold('.run.lock.2', 'QRD-2');
    assert.equal(run('QRD-3').status, 5, 'the old single lock of a live older run counts as slot 1');
  } finally { rmrf(home); }
});
