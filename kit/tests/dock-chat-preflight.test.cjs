'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const chat = require('../dock-chat.cjs');
const { problems } = require('../dock-chat-preflight.cjs');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

const REPO = path.resolve(KIT, '..');
const base = JSON.parse(fs.readFileSync(path.join(REPO, 'settings', 'settings.base.json'), 'utf8'));

// A profile folder with the rtk hook, caveman enabled and caveman installed; `drop` leaves one of the three out.
function profile(dir, drop) {
  const cfg = path.join(dir, 'cfg');
  const plugin = path.join(dir, 'caveman');
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'src', 'hooks'), { recursive: true });
  if (drop !== 'installed') fs.writeFileSync(path.join(plugin, 'src', 'hooks', 'caveman-activate.js'), '');
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: drop === 'hook' ? [] : [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
    enabledPlugins: { 'caveman@caveman': drop !== 'enabled' },
  }));
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'caveman@caveman': [{ installPath: plugin }] } }));
  return { CLAUDE_CONFIG_DIR: cfg };
}

test('preflight: a profile with rtk, the rtk hook and caveman has no problems', () => {
  const dir = tmp('preflight');
  try {
    assert.deepEqual(problems(profile(dir), { runs: () => true }), []);
  } finally { rmrf(dir); }
});

test('preflight: each missing piece is named', () => {
  const cases = [[undefined, false, /rtk is not runnable/], ['hook', true, /"rtk hook claude" PreToolUse hook is missing/], ['enabled', true, /caveman@caveman plugin is not enabled/], ['installed', true, /caveman@caveman plugin is not installed/]];
  for (const [drop, rtk, expected] of cases) {
    const dir = tmp('preflight');
    try {
      const found = problems(profile(dir, drop), { runs: () => rtk });
      assert.equal(found.length, 1);
      assert.match(found[0], expected);
    } finally { rmrf(dir); }
  }
});

test('preflight: an empty profile reports the hook and both caveman problems', () => {
  const dir = tmp('preflight');
  try {
    assert.equal(problems({ CLAUDE_CONFIG_DIR: dir }, { runs: () => true }).length, 3);
  } finally { rmrf(dir); }
});

test('childEnv: caveman is switched on for the headless session', () => {
  assert.equal(chat.childEnv({ configDir: null }, {}).CAVEMAN_DEFAULT_MODE, 'caveman');
});

test('a turn on a machine without the rtk hook and caveman is refused, and DOCK is told why', async () => {
  const dir = tmp('preflight-turn');
  let dock;
  try {
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'never-run.cjs'), cwd: dir, configDir: path.join(dir, 'cfg'), retryBaseMs: 50 }));
    let claimed = false;
    dock = await startServer((req) => {
      if (!req.url.endsWith('/chat/claim')) return null;
      if (claimed) return { json: { ok: true, result: { message: null } } };
      claimed = true;
      return { json: { ok: true, result: { message: { id: 3, sessionId: 'dock-s1', text: 'hi' } } } };
    });
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], { env: { ...sandboxEnv(dir), DOCK_CHAT_PREFLIGHT: '', DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' } });
    assert.equal(r.code, 0, r.stderr);
    const deltas = dock.requests.filter((q) => q.url.endsWith('/chat/delta'));
    assert.equal(deltas.length, 1);
    assert.match(deltas[0].body.error, /not ready for a chat turn: .*rtk hook claude.*caveman@caveman plugin is not enabled/);
  } finally {
    if (dock) await dock.close();
    rmrf(dir);
  }
});

test('settings: the shared allowlist is in the form the rtk hook rewrites to, and never opens rtk proxy', () => {
  const { allow, deny, ask } = base.permissions;
  for (const rule of ['Bash(rtk git status:*)', 'Bash(rtk git push:*)', 'Bash(git switch:*)', 'Bash(rtk rg:*)', 'Bash(rtk gh pr create:*)', 'Bash(playwright-cli:*)', 'Bash(bd:*)']) assert.ok(allow.includes(rule), rule);
  assert.deepEqual(allow.filter((rule) => /^Bash\(rtk(:| proxy)/.test(rule)), []);
  for (const rule of ['Grep', 'Glob', 'Bash(rtk git push origin main:*)']) assert.ok(deny.includes(rule), rule);
  for (const rule of ['Bash(rm:*)', 'Bash(rtk gh pr merge:*)', 'Bash(rtk git push --force:*)']) assert.ok(ask.includes(rule), rule);
  assert.deepEqual(allow.filter((rule) => deny.includes(rule) || ask.includes(rule)), []);
});

test('settings: the Linux overlay adds no permissions of its own, so both machines get the same list', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO, 'settings', 'settings.linux.json'), 'utf8')).permissions, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO, 'settings', 'settings.windows.json'), 'utf8')).permissions, undefined);
});
