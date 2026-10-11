'use strict';
// status.cjs remote / handover / pull and the SessionStart line, against a local fake of the four /ledger/* routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { KIT, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv, ledgerFake } = require('./helpers.cjs');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('ledger hand-over between machines', async () => {
  const base = tmp('handover');
  const fake = ledgerFake();
  const dock = await startServer(fake.respond);
  const status = (machine, root, args) => runNode([path.join(KIT, 'status.cjs'), ...args], {
    env: { ...sandboxEnv(path.join(base, `sandbox-${machine}`)), QONFLO_ROOT: root, DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: `dock_ing_${machine}`, QONFLO_EVIDENCE: '' },
  });
  const calls = (route) => dock.requests.filter((q) => q.url.endsWith(route)).length;
  try {
    for (const m of ['laptop', 'workspace']) fs.mkdirSync(path.join(base, `sandbox-${m}`), { recursive: true });
    const laptopRoot = path.join(base, 'laptop-root'), workspaceRoot = path.join(base, 'workspace-root');
    const remote = path.join(base, 'remote.git'), be = path.join(base, 'be');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', remote]);
    execFileSync('git', ['clone', '-q', remote, be], { stdio: 'ignore' });
    fs.writeFileSync(path.join(be, 'a.txt'), 'a');
    git(be, 'add', 'a.txt'); git(be, 'commit', '-q', '-m', 'base'); git(be, 'push', '-q', 'origin', 'HEAD:develop');
    git(be, 'checkout', '-q', '-b', 'feat/ZED-101-x');

    const init = await status('laptop', laptopRoot, ['init', 'ZED-101', 'Invented ticket', '3201', '5301', be.replace(/\\/g, '/'), '']);
    assert.match(init.stdout, /init ZED-101/);
    const ledgerFile = path.join(laptopRoot, '.evidence', 'ZED-101', 'status.json');
    assert.ok(fs.existsSync(ledgerFile));

    // 1. the branch has no upstream
    let r = await status('laptop', laptopRoot, ['handover', 'ZED-101', '--to', 'workspace']);
    assert.match(r.stdout, /REFUSED: push the branch first/);
    assert.equal(r.code, 2);
    assert.equal(calls('/ledger/handover'), 0);

    // 2. upstream set, but a commit is not pushed
    git(be, 'push', '-q', '-u', 'origin', 'feat/ZED-101-x');
    fs.writeFileSync(path.join(be, 'b.txt'), 'b');
    git(be, 'add', 'b.txt'); git(be, 'commit', '-q', '-m', 'unpushed');
    r = await status('laptop', laptopRoot, ['handover', 'ZED-101', '--to', 'workspace']);
    assert.match(r.stdout, /REFUSED: push the branch first/);
    assert.equal(calls('/ledger/handover'), 0);

    // 3. pushed, but uncommitted work in the worktree
    git(be, 'push', '-q');
    fs.writeFileSync(path.join(be, 'c.txt'), 'c');
    r = await status('laptop', laptopRoot, ['handover', 'ZED-101', '--to', 'workspace']);
    assert.match(r.stdout, /REFUSED: .*uncommitted/);
    assert.equal(calls('/ledger/handover'), 0);
    fs.rmSync(path.join(be, 'c.txt'));

    // 4. a pushed branch is handed over; the machine name is the only thing the server derives from the token
    r = await status('laptop', laptopRoot, ['handover', 'ZED-101', '--to', 'workspace', '--note', 'continue on the workspace']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ZED-101 offered to workspace/);
    const sent = dock.requests.find((q) => q.url.endsWith('/ledger/handover'));
    assert.deepEqual(sent.body, { key: 'ZED-101', to: 'workspace', note: 'continue on the workspace', branches: { be: 'feat/ZED-101-x' } });
    assert.equal(sent.headers.authorization, 'Bearer dock_ing_laptop');
    assert.ok(!dock.requests.some((q) => q.body && typeof q.body === 'object' && 'machine' in q.body), 'no request carries a machine name');
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).handedTo, 'workspace');

    // 5. save refuses on the machine that handed the ticket over, and names the target
    const before = fs.readFileSync(ledgerFile, 'utf8');
    r = await status('laptop', laptopRoot, ['set', 'ZED-101', 'stage=code']);
    assert.match(r.stdout, /REFUSED: ZED-101 was handed over to workspace/);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);

    // 6. the other machine sees the offer, in the table and in the SessionStart line
    r = await status('workspace', workspaceRoot, ['remote']);
    assert.match(r.stdout, /\| ZED-101 \| .* \| laptop \| workspace \| no \|/);
    r = await status('workspace', workspaceRoot, ['sync', '--hook']);
    assert.match(r.stdout, /ZED-101 is offered to this machine: node .*status\.cjs pull ZED-101/);
    r = await status('laptop', laptopRoot, ['sync', '--hook']);
    assert.doesNotMatch(r.stdout, /offered to this machine/);

    // 7. pull writes the ledger without dirs and ports and records where the evidence lives
    r = await status('workspace', workspaceRoot, ['pull', 'ZED-101']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /prep-ticket\.sh ZED-101 <slug> origin\/feat\/ZED-101-x - "Invented ticket"/);
    const pulledFile = path.join(workspaceRoot, '.evidence', 'ZED-101', 'status.json');
    const pulled = JSON.parse(fs.readFileSync(pulledFile, 'utf8'));
    assert.equal(pulled.title, 'Invented ticket');
    assert.ok(!('dirs' in pulled) && !('ports' in pulled) && !('handedTo' in pulled));
    assert.equal(pulled.decisions.at(-1).text, 'handed over from laptop; evidence before this point lives on laptop');
    assert.equal(fake.runs.get('ZED-101').machine, 'workspace');
    // the new owner can save again
    r = await status('workspace', workspaceRoot, ['set', 'ZED-101', 'stage=code']);
    assert.doesNotMatch(r.stdout, /REFUSED/);

    // 8. a local ledger newer than the server's copy is refused, unless forced
    assert.ok(await waitFor(() => fake.runs.get('ZED-101').ledger.stage === 'code'), 'the detached push of the last save reached DOCK');
    const local = JSON.parse(fs.readFileSync(pulledFile, 'utf8'));
    local.updatedAt = new Date(Date.now() + 3600 * 1000).toISOString();
    local.note = 'work that only exists here';
    fs.writeFileSync(pulledFile, JSON.stringify(local, null, 2));
    const accepts = calls('/ledger/accept');
    r = await status('workspace', workspaceRoot, ['pull', 'ZED-101']);
    assert.match(r.stdout, /REFUSED: local ledger is newer/);
    assert.equal(r.code, 2);
    assert.equal(calls('/ledger/accept'), accepts, 'a refused pull does not move ownership');
    assert.ok(fs.existsSync(path.join(path.dirname(pulledFile), 'status.remote.json')));
    assert.equal(JSON.parse(fs.readFileSync(pulledFile, 'utf8')).note, 'work that only exists here');

    r = await status('workspace', workspaceRoot, ['pull', 'ZED-101', '--force']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const kept = fs.readdirSync(path.dirname(pulledFile)).filter((f) => /^status\.local-.*\.json$/.test(f));
    assert.equal(kept.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(pulledFile), kept[0]), 'utf8')).note, 'work that only exists here');
    assert.notEqual(JSON.parse(fs.readFileSync(pulledFile, 'utf8')).note, 'work that only exists here');

    // 9. a ticket DOCK does not know is reported
    r = await status('laptop', laptopRoot, ['pull', 'ZED-999']);
    assert.match(r.stdout, /REFUSED: DOCK does not know ZED-999/);
  } finally {
    await dock.close();
    rmrf(base);
  }
});

test('the ledger client rejects a route DOCK does not have', async () => {
  const { ledger } = require('../dock-push.cjs');
  await assert.rejects(() => ledger('delete', {}), /ledger route must be one of/);
});
