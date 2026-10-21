'use strict';
// status.cjs set stackedOn and the sync retarget of a stacked PR, against a stub gh (QONFLO_GH) that reads and writes a JSON state file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, runNode, sandboxEnv } = require('./helpers.cjs');
const { createSousGuard } = require('../sous-guard.cjs');
const { resolvePaths } = require('../paths.cjs');

const GH_STUB = `
const fs = require('fs');
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
st.calls.push(a.join(' '));
const out = (v) => { fs.writeFileSync(file, JSON.stringify(st)); process.stdout.write(JSON.stringify(v)); };
if (a[0] === 'pr' && a[1] === 'list') out(st.lists[process.cwd().replace(/\\\\/g, '/').split('/').pop()] || []);
else if (a[0] === 'pr' && a[1] === 'view' && st.views[a[2]]) out(st.views[a[2]]);
else if (a[0] === 'pr' && a[1] === 'edit' && !st.editFails) { st.views[a[2]].baseRefName = a[a.indexOf('--base') + 1]; out({}); }
else { fs.writeFileSync(file, JSON.stringify(st)); process.exit(1); }
`;

const BE1 = 'https://github.com/o/ms-admin-worker-backend/pull/1281';
const FE1 = 'https://github.com/o/ms-client-dashboard-frontend/pull/1062';
const BE2 = 'https://github.com/o/ms-admin-worker-backend/pull/1300';

function scratch(label, state) {
  const base = tmp(label);
  const root = path.join(base, 'root');
  const evidence = path.join(root, '.evidence');
  for (const d of ['ms-admin-worker-backend', 'ms-client-dashboard-frontend', '.evidence']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const stub = path.join(base, 'gh-stub.js');
  fs.writeFileSync(stub, GH_STUB);
  const stateFile = path.join(base, 'gh.json');
  fs.writeFileSync(stateFile, JSON.stringify({ calls: [], lists: {}, views: {}, ...state }));
  const status = (...args) => runNode([path.join(KIT, 'status.cjs'), ...args], { env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence, QONFLO_ROOT: root, QONFLO_GH: stub, FAKE_GH_STATE: stateFile } });
  const ledger = (key) => JSON.parse(fs.readFileSync(path.join(evidence, key, 'status.json'), 'utf8'));
  const gh = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setGh = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...gh(), ...patch }));
  return { base, status, ledger, gh, setGh };
}

const parentViews = (state = 'OPEN') => ({
  [BE1]: { headRefName: 'feat/QRD-1345-flow', baseRefName: 'develop', state },
  [FE1]: { headRefName: 'feat/QRD-1345-flow', baseRefName: 'feat/V1-Playbook', state: 'OPEN' },
});

test('stackedOn takes each repo\'s base from the parent\'s open PRs, clears a prerequisite wait, and clears on stackedOn=', async () => {
  const { base, status, ledger } = scratch('stack-set', { views: parentViews() });
  try {
    await status('init', 'QRD-1345', 'Parent', '-', '-', '-', '-');
    await status('set', 'QRD-1345', `pr.be=${BE1}`, `pr.fe=${FE1}`);
    await status('init', 'QRD-1346', 'Child', '-', '-', '-', '-');
    await status('set', 'QRD-1346', 'waiting=Blocked: prerequisite QRD-1345 not merged');
    const r = await status('set', 'QRD-1346', 'stackedOn=QRD-1345');
    assert.equal(r.code, 0, r.stdout);
    const s = ledger('QRD-1346');
    assert.deepEqual(s.stackedOn, {
      key: 'QRD-1345', retargeted: {},
      be: { pr: BE1, branch: 'feat/QRD-1345-flow', base: 'develop' },
      fe: { pr: FE1, branch: 'feat/QRD-1345-flow', base: 'feat/V1-Playbook' },
    });
    assert.equal(s.waiting, '');
    assert.match(s.decisions.at(-1).text, /stacked on QRD-1345: base be feat\/QRD-1345-flow, fe feat\/QRD-1345-flow; QRD-1345's PR merges first/);
    await status('set', 'QRD-1346', 'stackedOn=');
    assert.equal(ledger('QRD-1346').stackedOn, undefined);
  } finally {
    rmrf(base);
  }
});

test('stackedOn skips a repo without an open parent PR and refuses a parent that cannot carry a stack', async () => {
  const { base, status, ledger, setGh } = scratch('stack-refuse', { views: parentViews('MERGED') });
  try {
    await status('init', 'QRD-1345', 'Parent', '-', '-', '-', '-');
    await status('init', 'QRD-1346', 'Child', '-', '-', '-', '-');
    await status('set', 'QRD-1346', 'waiting=Blocked: prerequisite QRD-1345');
    let r = await status('set', 'QRD-1346', 'stackedOn=QRD-1345');
    assert.match(r.stdout, /REFUSED: QRD-1346 cannot stack on QRD-1345: QRD-1345 has no open PR to stack on/);
    assert.equal(ledger('QRD-1346').waiting, 'Blocked: prerequisite QRD-1345', 'a refused stack keeps the wait');
    assert.match((await status('set', 'QRD-1346', 'stackedOn=QRD-9999')).stdout, /no ledger for QRD-9999/);
    assert.match((await status('set', 'QRD-1346', 'stackedOn=QRD-1346')).stdout, /cannot stack on itself/);
    await status('set', 'QRD-1345', `pr.be=${BE1}`, `pr.fe=${FE1}`);
    r = await status('set', 'QRD-1346', 'stackedOn=QRD-1345');
    assert.equal(r.code, 0, r.stdout);
    const st = ledger('QRD-1346').stackedOn;
    assert.equal(st.be, undefined, 'the merged BE PR gives no entry: BE uses its normal base');
    assert.equal(st.fe.branch, 'feat/QRD-1345-flow');
    setGh({ views: {} });
    r = await status('set', 'QRD-1346', 'stackedOn=QRD-1345');
    assert.match(r.stdout, /gh pr view .* failed/);
  } finally {
    rmrf(base);
  }
});

function childLedger(evidenceRoot, extra = {}) {
  return { key: 'QRD-1346', stage: 'pr', ac: [], pr: { be: BE2 }, decisions: [], stackedOn: { key: 'QRD-1345', retargeted: {}, be: { pr: BE1, branch: 'feat/QRD-1345-flow', base: 'develop' } }, ...extra };
}
const writeLedger = (base, s) => {
  const dir = path.join(base, 'root', '.evidence', s.key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(s));
};
const lists = { 'ms-admin-worker-backend': [{ number: 1300, state: 'OPEN', url: BE2, headRefName: 'feat/QRD-1346-step', title: 'QRD-1346 feat: step' }] };

test('sync retargets the child PR once after the parent merged and records it', async () => {
  const { base, status, ledger, gh, setGh } = scratch('stack-sync', { lists, views: { [BE1]: { state: 'OPEN' }, [BE2]: { baseRefName: 'feat/QRD-1345-flow', state: 'OPEN' } } });
  try {
    writeLedger(base, childLedger());
    await status('sync', 'QRD-1346');
    assert.equal(ledger('QRD-1346').stackedOn.retargeted.be, undefined, 'parent still open: nothing to do');
    assert.ok(!gh().calls.some((c) => c.startsWith('pr edit')));

    setGh({ views: { ...gh().views, [BE1]: { state: 'MERGED' } } });
    await status('sync', 'QRD-1346');
    const s = ledger('QRD-1346');
    assert.ok(s.stackedOn.retargeted.be);
    assert.match(s.decisions.at(-1).text, /QRD-1345 merged; be PR .*pull\/1300 now targets develop/);
    assert.deepEqual(gh().calls.filter((c) => c.startsWith('pr edit')), [`pr edit ${BE2} --base develop`]);
    assert.equal(gh().views[BE2].baseRefName, 'develop');

    await status('sync', 'QRD-1346');
    assert.equal(gh().calls.filter((c) => c.startsWith('pr edit')).length, 1, 'once only');
  } finally {
    rmrf(base);
  }
});

test('sync records GitHub\'s own retarget, and a failed edit is a finding that is not retried', async () => {
  const { base, status, ledger, gh, setGh } = scratch('stack-sync-fail', { lists, views: { [BE1]: { state: 'MERGED' }, [BE2]: { baseRefName: 'develop', state: 'OPEN' } } });
  try {
    writeLedger(base, childLedger());
    await status('sync', 'QRD-1346');
    let s = ledger('QRD-1346');
    assert.ok(s.stackedOn.retargeted.be, 'GitHub retargeted it when the branch was deleted');
    assert.ok(!gh().calls.some((c) => c.startsWith('pr edit')));

    writeLedger(base, childLedger());
    setGh({ editFails: true, views: { [BE1]: { state: 'MERGED' }, [BE2]: { baseRefName: 'feat/QRD-1345-flow', state: 'OPEN' } } });
    await status('sync', 'QRD-1346');
    s = ledger('QRD-1346');
    assert.equal(s.stackedOn.retargeted.be, undefined);
    assert.equal(s.findings.length, 1);
    assert.match(s.findings[0].text, /^retarget be failed: QRD-1345 merged; run gh pr edit .*pull\/1300 --base develop by hand$/);
    await status('sync', 'QRD-1346');
    assert.equal(gh().calls.filter((c) => c.startsWith('pr edit')).length, 1, 'not retried');
    assert.equal(ledger('QRD-1346').findings.length, 1);
  } finally {
    rmrf(base);
  }
});

test('the publisher guard lets a stacked PR target the parent feature branch, head rule unchanged', () => {
  const base = tmp('stack-guard');
  try {
    const root = path.join(base, 'root').replace(/\\/g, '/');
    fs.mkdirSync(`${root}/.evidence/QRD-1346`, { recursive: true });
    fs.writeFileSync(`${root}/.evidence/QRD-1346/pr-body-be.md`, `Stacked on ${BE1}: merge that first.\n`);
    fs.writeFileSync(`${root}/.evidence/QRD-1346/status.json`, JSON.stringify({ key: 'QRD-1346', stackedOn: { key: 'QRD-1345', be: { pr: BE1, branch: 'feat/QRD-1345-flow', base: 'develop' } } }));
    const g = createSousGuard({ paths: resolvePaths({ local: { root, github: { be: 'o/r' } }, kitDir: KIT }), cwd: root });
    const create = (head, baseBranch) => g.check('publish', [], { tool_name: 'Bash', tool_input: { command: `gh pr create --repo o/r --base ${baseBranch} --head ${head} --title "QRD-1346 feat: step" --body-file ${root}/.evidence/QRD-1346/pr-body-be.md` } });
    assert.equal(create('feat/QRD-1346-step', 'feat/QRD-1345-flow'), null);
    assert.equal(create('feat/QRD-1345-flow', 'develop'), null);
    assert.match(create('develop', 'feat/QRD-1345-flow'), /not a ticket branch/);
    assert.match(create('feat/QRD-1347-other', 'feat/QRD-1345-flow'), /not a configured base/, 'a feature base only for the ticket whose ledger stacks on it');
    assert.equal(g.check('runner', ['@root'], { tool_name: 'Bash', tool_input: { command: `gh pr view ${BE1} --json headRefName,baseRefName,state` } }), null);
  } finally {
    rmrf(base);
  }
});
