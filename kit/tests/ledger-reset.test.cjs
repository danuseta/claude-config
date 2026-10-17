'use strict';
// status.cjs sync --hook puts aside the ledger of a ticket DOCK reset because it went back to To Do in Jira.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv, ledgerFake } = require('./helpers.cjs');

test('a ledger older than its reset is archived; a newer one and other tickets stay', async () => {
  const base = tmp('ledger-reset');
  const fake = ledgerFake();
  const dock = await startServer(fake.respond);
  const machine = 'workspace';
  const root = path.join(base, 'root');
  const evidence = path.join(root, '.evidence');
  const status = (args) => runNode([path.join(KIT, 'status.cjs'), ...args], {
    env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_ROOT: root, DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: `dock_ing_${machine}`, QONFLO_EVIDENCE: '' },
  });
  const write = (key, createdAt) => {
    fs.mkdirSync(path.join(evidence, key), { recursive: true });
    fs.writeFileSync(path.join(evidence, key, 'status.json'), JSON.stringify({ key, stage: 'code', createdAt }));
  };
  try {
    fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
    write('ZED-301', '2026-10-01T00:00:00.000Z');
    write('ZED-302', '2026-10-20T00:00:00.000Z');
    write('ZED-303', '2026-10-01T00:00:00.000Z');
    fake.resets.push({ key: 'ZED-301', machine: 'workspace', resetAt: '2026-10-10T00:00:00.000Z' });
    fake.resets.push({ key: 'ZED-302', machine: 'workspace', resetAt: '2026-10-10T00:00:00.000Z' });
    fake.resets.push({ key: 'ZED-303', machine: 'laptop', resetAt: '2026-10-10T00:00:00.000Z' });

    const r = await status(['sync', '--hook']);
    assert.match(r.stdout, /ZED-301 went back to To Do in Jira; its old ledger is in .*ZED-301\.reset-/);
    assert.ok(!fs.existsSync(path.join(evidence, 'ZED-301')), 'the old ledger is moved away');
    assert.ok(fs.readdirSync(evidence).some((name) => name.startsWith('ZED-301.reset-')));
    assert.ok(fs.existsSync(path.join(evidence, 'ZED-302', 'status.json')), 'a ledger made after the reset stays');
    assert.ok(fs.existsSync(path.join(evidence, 'ZED-303', 'status.json')), 'a reset of another machine is not this machine\'s');
  } finally {
    await dock.close();
    rmrf(base);
  }
});
