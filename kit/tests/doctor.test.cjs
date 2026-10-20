'use strict';
// kit/doctor.cjs: the report shape, each probe on a scratch config, no secret in the output, and --push to a local fake of DOCK's /doctor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { report, table } = require('../doctor.cjs');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

const NAMES = ['rtk', 'ffmpeg', 'ffprobe', 'dock-config', 'passEnv', 'hooks', 'playwright', 'chromium', 's3-demo', 'node', 'python'];
const fakeToken = (word) => ['dock', 'ing', word].join('_');
const fakeProbe = (missing = []) => (name) => ({ name, ok: !missing.includes(name), detail: missing.includes(name) ? `not found or failed: ${name}` : `${name} 1.0` });

test('a configured machine reports every check ok and never the token', () => {
  const base = tmp('doctor-ok');
  try {
    const cfg = path.join(base, 'cfg');
    const kit = path.join(cfg, 'kit');
    fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(kit, 'bin'), { recursive: true });
    for (const f of ['sous-guard.cjs', 'demo-upload.cjs', 'status.cjs']) fs.writeFileSync(path.join(kit, f), '');
    fs.writeFileSync(path.join(cfg, 'agents', 'sous-ticket-runner.md'), '');
    fs.writeFileSync(path.join(kit, 'dock.json'), JSON.stringify({ url: 'https://dock.example.test/ingest/orchestrator', token: fakeToken('SECRETVALUE') }));
    fs.writeFileSync(path.join(kit, 'dock-chat.json'), JSON.stringify({ passEnv: ['ZED_A', 'ZED_B'] }));
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `node "${kit}/guard.cjs"` }, { command: `node "${kit}/dock-push.cjs" hook` }] }], SessionStart: [{ hooks: [{ command: `node "${kit}/status.cjs" sync --hook` }] }] } }));
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1200'), { recursive: true });
    const r = report({ env: { ZED_A: 'x', ZED_B: 'y' }, kitDir: kit, configDir: cfg, home, probe: fakeProbe() });
    assert.deepEqual(r.checks.map((c) => c.name), NAMES);
    assert.deepEqual(Object.keys(r).sort(), ['at', 'checks', 'kitVersion', 'machine', 'os']);
    for (const c of r.checks.filter((x) => x.name !== 'node')) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
    assert.match(r.checks.find((c) => c.name === 'dock-config').detail, /dock\.example\.test/);
    assert.match(r.checks.find((c) => c.name === 'passEnv').detail, /2\/2 set/);
    assert.match(r.checks.find((c) => c.name === 'chromium').detail, /chromium-1200/);
    assert.doesNotMatch(JSON.stringify(r) + table(r), /SECRETVALUE/);
  } finally {
    rmrf(base);
  }
});

test('missing pieces are FAIL with what is missing, by name only', () => {
  const base = tmp('doctor-missing');
  try {
    const cfg = path.join(base, 'cfg');
    const kit = path.join(cfg, 'kit');
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, 'dock-chat.json'), JSON.stringify({ passEnv: ['ZED_SET', 'ZED_GONE'] }));
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ hooks: {} }));
    const r = report({ env: { ZED_SET: 'value-not-printed' }, kitDir: kit, configDir: cfg, home: path.join(base, 'home'), probe: fakeProbe(['ffmpeg', 'rtk']) });
    const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    assert.equal(by.rtk.ok, false);
    assert.equal(by.ffmpeg.ok, false);
    assert.equal(by['dock-config'].ok, false);
    assert.match(by['dock-config'].detail, /missing url and token/);
    assert.equal(by.passEnv.ok, false);
    assert.match(by.passEnv.detail, /1\/2 set; missing: ZED_GONE/);
    assert.equal(by.hooks.ok, false);
    assert.match(by.hooks.detail, /missing: guard\.cjs, dock-push\.cjs hook, status\.cjs sync/);
    assert.equal(by['s3-demo'].ok, false);
    assert.doesNotMatch(table(r), /value-not-printed/);
    assert.match(table(r), /\| rtk \| FAIL \|/);
  } finally {
    rmrf(base);
  }
});

test('--push sends the report to /doctor with the ingest token', async () => {
  const base = tmp('doctor-push');
  const dock = await startServer();
  try {
    const r = await runNode([path.join(KIT, 'doctor.cjs'), '--push'], { env: { ...sandboxEnv(base), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: fakeToken('TESTTOKEN') } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /push: sent to DOCK \/doctor/);
    assert.doesNotMatch(r.stdout, /TESTTOKEN/);
    assert.equal(dock.requests.length, 1);
    const q = dock.requests[0];
    assert.equal(q.url, '/ingest/orchestrator/doctor');
    assert.equal(q.headers.authorization, `Bearer ${fakeToken('TESTTOKEN')}`);
    assert.deepEqual(q.body.checks.map((c) => c.name), NAMES);
    assert.equal(q.body.os, process.platform);
    assert.doesNotMatch(JSON.stringify(q.body), /TESTTOKEN/);
  } finally {
    await dock.close();
    rmrf(base);
  }
});
