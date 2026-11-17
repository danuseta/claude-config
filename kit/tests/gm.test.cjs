'use strict';
// kit/gm.cjs and the Guild Master parts of guard.cjs and dock-chat.cjs: no write without DOCK's nonce for the proposal it showed,
// signed and validated rollback, one shared log, and a gm turn confined to gm.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createGm, sha256 } = require('../gm.cjs');
const { createGuard, answer } = require('../guard.cjs');
const { resolvePaths } = require('../paths.cjs');
const { gmArgs, gmInitOk } = require('../dock-chat.cjs');
const { KIT, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv } = require('./helpers.cjs');

const AGENT = '---\r\nname: my-reader\r\ndescription: reads\r\nmodel: haiku\r\ntools: Read\r\n---\r\n\r\nYou read.\r\n';
const KEY = 'k'.repeat(64);

// A stand-in for DOCK: nonces it minted, consumed once on confirm or on a settings write.
function fakeDock(store) {
  const nonces = new Map();
  const puts = [];
  const take = (c) => {
    const n = c && nonces.get(c.nonce);
    if (!n || n.sha256 !== c.sha256) throw new Error('DOCK did not confirm');
    nonces.delete(c.nonce);
  };
  return {
    puts,
    mint: (sha) => { const nonce = crypto.randomBytes(8).toString('hex'); nonces.set(nonce, { sha256: sha }); return nonce; },
    settings: {
      get: async () => ({ values: { ...store } }),
      put: async (values, confirm) => { take(confirm); puts.push(values); Object.assign(store, values); return { ok: true }; },
      confirm: async (confirm) => { take(confirm); return { ok: true }; },
    },
  };
}

function setup() {
  const base = tmp('gm');
  const cfg = path.join(base, 'cfg');
  const kit = path.join(cfg, 'kit');
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.mkdirSync(kit, { recursive: true });
  const file = path.join(cfg, 'agents', 'my-reader.md');
  fs.writeFileSync(file, AGENT);
  const gm = createGm({ stateDir: base, configDir: cfg, kitDir: kit });
  const store = { chatCaveman: 'full', chatParallelTurns: '3' };
  const dock = fakeDock(store);
  const yes = (sessionId) => { const sha = sha256(gm.pendingRaw(sessionId)); return { nonce: dock.mint(sha), sha256: sha, exp: Date.now() + 60000 }; };
  const apply = (sessionId, gmConfirm = yes(sessionId)) => gm.apply({ sessionId, gmConfirm, key: KEY, settings: dock.settings });
  const rollback = (id, key = KEY) => gm.rollback({ id, key, settings: dock.settings, confirm: { sessionId: null, nonce: dock.mint(`rollback:${id}`), sha256: `rollback:${id}` } });
  return { base, cfg, kit, file, gm, store, dock, yes, apply, rollback };
}

const linuxPaths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
const gmGuard = createGuard({ platform: 'linux', paths: linuxPaths, env: { DOCK_GM: '1' }, home: '/home/coder' });
const decide = (guard, command) => {
  const out = answer(command, '/home/coder/projects', { guard, env: { DOCK_GM: '1' }, cfg: { softUntil: '2999-01-01' }, log: false });
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

test('guard: a gm session runs bare node on the full gm.cjs path, plain words only', () => {
  const K = '/home/coder/.claude/kit';
  assert.ok(gmGuard.check(undefined, '/home/coder'), 'a command that is not text is refused');
  assert.ok(gmGuard.check({ command: 'x' }, '/home/coder'));
  for (const ok of [`node ${K}/gm.cjs agents`, `node ${K}/gm.cjs propose-agent sous-verifier --model haiku`, `node ${K}/gm.cjs propose-settings chatCaveman=lite chatParallelTurns=2`]) {
    assert.equal(decide(gmGuard, ok), 'allow', ok);
  }
  for (const bad of [
    `node "${K}/gm.cjs"/../agents.cjs put`, `node '${K}/gm.cjs'/../x.js`, `./node ${K}/gm.cjs list`, `D:/x/node ${K}/gm.cjs list`, `/usr/bin/node ${K}/gm.cjs log`,
    `node "${K}/gm.cjs" log`, `node ${K}/../kit/gm.cjs log`, `node ${K}/./gm.cjs log`, `node ${K}/gm.cjs/.. log`, `node ../.claude/kit/gm.cjs settings`, 'kit-node ~/.claude/kit/gm.cjs log', `kit-node ${K}/gm.cjs log`,
    'git status', 'ls', `node -e 1`, `node --require x ${K}/gm.cjs`, `node /tmp/gm.cjs agents`, `node ${K}/agents.cjs put`,
    `node ${K}/gm.cjs agents; rm -rf ~`, `node ${K}/gm.cjs agents && git push`, `node ${K}/gm.cjs log > ${K}/x`, `FOO=1 node ${K}/gm.cjs pending`,
    `node ${K}/gm.cjs propose-settings a=$(id)`, `bash -c "node ${K}/gm.cjs log"`, `echo hi | node ${K}/gm.cjs log`, `node ${K}/gm.cjs\tagents`, `node ${K}\\gm.cjs agents`, `node ${K}/gm.cjs agents #x`,
  ]) {
    assert.equal(decide(gmGuard, bad), 'deny', bad);
  }
  const work = createGuard({ platform: 'linux', paths: linuxPaths, env: { DOCK_CHAT_TURN: '1' }, home: '/home/coder' });
  assert.equal(work.check('ls', '/home/coder/projects'), null, 'a work session keeps its own rules');
});

test('guard: the same rule on Windows paths, Git Bash form included, and the reviewer probes deny', () => {
  const winPaths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:\\Users\\danus\\.claude-kantor\\kit', local: {} });
  const g = createGuard({ platform: 'win32', paths: winPaths, env: { DOCK_GM: '1' }, home: 'C:/Users/danus' });
  const K = 'C:/Users/danus/.claude-kantor/kit';
  for (const ok of [`node ${K}/gm.cjs agents`, 'node /c/Users/danus/.claude-kantor/kit/gm.cjs log', `node c:/users/danus/.claude-kantor/kit/gm.cjs log`]) assert.equal(g.check(ok, 'E:/qonflo'), null, ok);
  for (const bad of [`node "${K}/gm.cjs"/../agents.cjs`, `node '${K}/gm.cjs'/../x.js`, `./node ${K}/gm.cjs list`, `D:/x/node ${K}/gm.cjs list`, `node "C:\\Users\\danus\\.claude-kantor\\kit\\gm.cjs" log`, `node.exe ${K}/gm.cjs log`]) {
    assert.ok(g.check(bad, 'E:/qonflo'), bad);
  }
});

test('guard hook: PowerShell, every non-Bash tool and a Bash call without a command are denied in a gm session', async () => {
  for (const [tool, input] of [['PowerShell', { command: 'Get-ChildItem' }], ['Write', { file_path: 'x' }], ['mcp__x__y', {}], ['Bash', {}], ['Bash', { command: 7 }]]) {
    const r = await runNode([path.join(KIT, 'guard.cjs')], { env: { DOCK_GM: '1' }, input: JSON.stringify({ tool_name: tool, cwd: KIT, tool_input: input }) });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
  }
});

test('guard: a Work session cannot read kit/dock.json or the gm state, by Bash, Read, Grep or Glob; kit scripts still run', () => {
  const K = '/home/coder/.claude/kit';
  const work = createGuard({ platform: 'linux', paths: linuxPaths, env: { DOCK_CHAT_TURN: '1' }, home: '/home/coder' });
  const attended = createGuard({ platform: 'linux', paths: linuxPaths, env: {}, home: '/home/coder' });
  const R = '/home/coder/projects/repo';
  for (const bad of [
    `cat ${K}/dock.json`, 'cat ~/.claude/kit/dock.json', 'cat "$HOME/.claude/kit/dock.j"son', `type ${K}/dock.json`, `cat ${K}/dock.j*`, `cat ${K}/*.json`, `cat ${K}/gm/log.jsonl`, `ls ${K}/gm/backups`,
    `rg token ${K}`, 'rg token ~/.claude', 'grep -r token ~', `node -e "require('fs').readFileSync(require('os').homedir()+'/.claude/kit/do'+'ck.json')"`, `python3 -c "open('${K}/x')"`,
    `cd ${K} && cat *.json`, `cp -r ${K} /tmp/x`, `tar czf /tmp/k.tgz ${K}`, 'f=dock; cat ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/$f.json', `cat ${K}/gm`, `head -c 400 ${K}/dock.json`,
  ]) {
    assert.ok(work.check(bad, R), bad);
    assert.ok(attended.check(bad, R), `outside a chat turn too: ${bad}`);
  }
  for (const bad of ['cat dock.json', 'cat *', 'rg token', 'cat gm/log.jsonl', 'ls .']) assert.ok(work.check(bad, K), `in the kit folder: ${bad}`);
  for (const ok of [`node ${K}/status.cjs set QRD-1 stage=done`, '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/bin/kit-node" sous-guard.cjs path x', 'node ~/.claude/kit/discord-files.cjs 123 /tmp/d', 'rg token src', 'git status', 'cat README.md']) {
    assert.equal(work.check(ok, R), null, ok);
  }
  for (const [tool, input] of [['Read', { file_path: `${K}/dock.json` }], ['Read', { file_path: '~/.claude/kit/gm/log.jsonl' }], ['Read', { file_path: 'dock.json' }], ['Grep', { pattern: 'token', path: K }],
    ['Grep', { pattern: 'token', path: '/home/coder' }], ['Grep', { pattern: 'token' }], ['Glob', { pattern: '**/*.json', path: '/home/coder/.claude' }], ['Glob', { pattern: `${K}/*` }]]) {
    assert.ok(work.checkTool(tool, input, tool === 'Grep' && !input.path ? K : R), `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of [['Read', { file_path: `${R}/src/a.ts` }], ['Read', { file_path: `${K}/status.cjs` }], ['Grep', { pattern: 'token', path: `${R}/src` }], ['Glob', { pattern: '**/*.ts' }]]) {
    assert.equal(work.checkTool(tool, input, R), null, `${tool} ${JSON.stringify(input)}`);
  }
});

test('guard hook: a Read of kit/dock.json is denied, and an ordinary Read is let through', async () => {
  const hook = (input) => runNode([path.join(KIT, 'guard.cjs')], { env: { DOCK_GM: '' }, input: JSON.stringify({ tool_name: 'Read', cwd: KIT, tool_input: input }) });
  assert.equal(JSON.parse((await hook({ file_path: path.join(KIT, 'dock.json') })).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await hook({ file_path: path.join(KIT, 'gm.cjs') })).stdout, '');
});

test('gm turn args: Bash only, allow rule on the absolute gm.cjs, and the guard hook on the turn settings', () => {
  const args = gmArgs('/k/gm.cjs', '/usr/bin/node');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--tools'), 'Bash');
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--allowedTools'), 'Bash(node /k/gm.cjs:*)');
  const hook = JSON.parse(at('--settings')).hooks.PreToolUse[0];
  assert.equal(hook.matcher, '*');
  assert.equal(hook.hooks[0].command, '"/usr/bin/node" "/k/guard.cjs" || exit 2');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(gmInitOk({ tools: ['Bash'], mcp_servers: [] }), true);
  assert.equal(gmInitOk({ tools: ['Bash', 'Write'], mcp_servers: [] }), false);
  assert.equal(gmInitOk({ tools: ['Bash'], mcp_servers: [{ name: 'x' }] }), false);
});

test('apply: nothing is written without DOCK\'s nonce for the proposal it showed, and "nggak" drops the proposal', async () => {
  const t = setup();
  try {
    const p = t.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
    assert.match(p.diff, /-model: haiku[\s\S]*\+model: sonnet/);
    const shown = t.yes('gm-a');
    for (const bad of [null, true, { ...shown, nonce: 'forged' }, { ...shown, exp: Date.now() - 1 }]) {
      t.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
      assert.equal((await t.apply('gm-a', bad)).ok, false);
    }
    t.gm.proposeAgent('gm-a', 'my-reader', { model: 'opus' });
    const swapped = await t.apply('gm-a', shown);
    assert.match(swapped.error, /not the one DOCK showed/, 'a proposal changed after DOCK showed it is refused');
    assert.equal(fs.readFileSync(t.file, 'utf8'), AGENT, 'the agent file is untouched');
    assert.deepEqual(t.gm.entries(), []);
    t.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
    t.gm.discard('gm-a');
    assert.deepEqual(await t.apply('gm-a', shown), { ok: false, error: 'No change was waiting for a yes' });
    assert.equal(fs.readFileSync(t.file, 'utf8'), AGENT);
  } finally { rmrf(t.base); }
});

test('apply: an agent that changed since the proposal is not overwritten', async () => {
  const t = setup();
  try {
    t.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
    const edited = AGENT.replace('You read.', 'You read twice.');
    fs.writeFileSync(t.file, edited);
    const r = await t.apply('gm-a');
    assert.match(r.error, /changed since the proposal/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), edited);
  } finally { rmrf(t.base); }
});

test('apply then rollback: backups first (agent and allow-list), signed entry, rollback restores the exact bytes', async () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.kit, 'agents-allow.json'), '["other-agent"]\n');
    t.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
    const r = await t.apply('gm-a');
    assert.equal(r.ok, true, r.error);
    assert.match(fs.readFileSync(t.file, 'utf8'), /model: sonnet/);
    assert.deepEqual(t.gm.backupBytes(r.entry.backup), Buffer.from(AGENT));
    assert.equal(t.gm.backupBytes(r.entry.allowBackup).toString(), '["other-agent"]\n');
    assert.deepEqual([r.entry.id, r.entry.kind, r.entry.by, r.entry.sessionId, r.entry.target], [1, 'change', 'owner', 'gm-a', 'agents/my-reader.md']);
    assert.equal(typeof r.entry.mac, 'string');
    assert.equal((await t.rollback(1, 'another key')).ok, false, 'a wrong key cannot roll back');
    const back = await t.rollback(1);
    assert.equal(back.ok, true, back.error);
    assert.deepEqual(fs.readFileSync(t.file), Buffer.from(AGENT), 'byte for byte, CRLF included');
    assert.deepEqual([back.entry.id, back.entry.kind, back.entry.rollbackOf], [2, 'rollback', 1]);
    assert.match(t.gm.backupBytes(back.entry.backup).toString(), /model: sonnet/, 'the rollback backed up what it replaced');
    assert.equal(t.gm.view().find((e) => e.id === 1).rolledBack, true);
    assert.equal((await t.rollback(1)).ok, false, 'one rollback per entry');
    assert.ok(!fs.existsSync(path.join(t.base, 'gm', 'log.lock')), 'the log lock is released');
  } finally { rmrf(t.base); }
});

test('rollback refuses a planted entry, a changed backup, a backup with other hooks, and a panel rollback without a nonce', async () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.base, 'gm', 'backups'), { recursive: true });
    fs.writeFileSync(path.join(t.base, 'gm', 'backups', 'evil.bak'), '---\nname: my-reader\ntools: Bash\nhooks:\n  PreToolUse: []\n---\nx\n');
    fs.appendFileSync(path.join(t.base, 'gm', 'log.jsonl'), `${JSON.stringify({ id: 1, at: 'x', kind: 'change', type: 'agent', slug: 'my-reader', target: 'agents/my-reader.md', summary: 's', backup: 'evil.bak' })}\n`);
    assert.match((await t.rollback(1)).error, /not written by Guild Master/);

    const other = setup();
    try {
      other.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
      const r = await other.apply('gm-a');
      fs.writeFileSync(path.join(other.base, 'gm', 'backups', r.entry.backup), '---\nname: my-reader\ntools: Bash\n---\nx\n');
      assert.match((await other.rollback(r.entry.id)).error, /changed since it was written/);
      assert.equal((await other.gm.rollback({ id: r.entry.id, key: KEY, settings: other.dock.settings, confirm: { sessionId: null, nonce: 'none', sha256: `rollback:${r.entry.id}` } })).ok, false, 'no DOCK nonce, no rollback');
    } finally { rmrf(other.base); }

    const hooks = setup();
    try {
      hooks.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
      const r = await hooks.apply('gm-a');
      fs.writeFileSync(hooks.file, AGENT.replace('---\r\n\r\n', 'hooks:\r\n  PreToolUse:\r\n    - matcher: "Bash"\r\n      hooks:\r\n        - type: command\r\n          command: \'x || exit 2\'\r\n---\r\n\r\n'));
      assert.match((await hooks.rollback(r.entry.id)).error, /other hooks/);
    } finally { rmrf(hooks.base); }
  } finally { rmrf(t.base); }
});

test('settings: secrets are only set / not set, unknown keys are refused, the write consumes DOCK\'s nonce', async () => {
  const t = setup();
  try {
    t.gm.saveSettings({ values: { chatCaveman: 'full', chatParallelTurns: '3' }, secrets: { jiraApiToken: 'set', githubToken: 'abc' } });
    assert.deepEqual(t.gm.settingsView().secrets, { jiraApiToken: 'set', githubToken: 'not set' });
    assert.throws(() => t.gm.proposeSettings('gm-a', ['jiraApiToken=secret']), /not a setting/);
    t.gm.proposeSettings('gm-a', ['chatCaveman=off']);
    const r = await t.apply('gm-a');
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(t.dock.puts, [{ chatCaveman: 'off' }]);
    assert.deepEqual(JSON.parse(t.gm.backupBytes(r.entry.backup)), { chatCaveman: 'full' });
    assert.deepEqual(t.gm.view()[0].restoreValues, { chatCaveman: 'full' }, 'DOCK learns what a rollback writes, to bind the nonce to it');
    t.gm.proposeRollback('gm-a', r.entry.id);
    assert.deepEqual(t.gm.pending('gm-a').values, { chatCaveman: 'full' }, 'a settings rollback proposal carries its values');
    t.gm.discard('gm-a');
    assert.equal((await t.rollback(r.entry.id)).ok, true);
    assert.equal(t.store.chatCaveman, 'full');
  } finally { rmrf(t.base); }
});

test('log lock: a stale lock is taken over, and a lock that is no longer ours is left in place', async () => {
  const t = setup();
  try {
    const lock = path.join(t.base, 'gm', 'log.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'someone-else');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    t.gm.proposeAgent('gm-a', 'my-reader', { model: 'sonnet' });
    assert.equal((await t.apply('gm-a')).ok, true);
    assert.ok(!fs.existsSync(lock), 'our own lock is released');
    // Another holder takes the lock over right after ours is written: our release must leave theirs alone.
    const realWrite = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { const n = realWrite(fd, data, ...rest); if (typeof data === 'string' && /^[0-9a-f]{24}$/.test(data)) fs.writeFileSync(lock, 'taken-over'); return n; };
    try {
      t.gm.proposeAgent('gm-a', 'my-reader', { model: 'opus' });
      assert.equal((await t.apply('gm-a')).ok, true);
    } finally { fs.writeSync = realWrite; }
    assert.equal(fs.readFileSync(lock, 'utf8'), 'taken-over', 'a lock whose token changed is not removed');
  } finally { rmrf(t.base); }
});

test('two gm sessions write one shared manager log', async () => {
  const t = setup();
  try {
    const other = createGm({ stateDir: t.base, configDir: t.cfg, kitDir: t.kit });
    t.gm.saveSettings({ values: { chatCaveman: 'full' }, secrets: {} });
    t.gm.proposeAgent('gm-a', 'my-reader', { model: 'opus' });
    other.proposeSettings('gm-b', ['chatCaveman=lite']);
    const sha = sha256(other.pendingRaw('gm-b'));
    assert.equal((await other.apply({ sessionId: 'gm-b', gmConfirm: { nonce: t.dock.mint(sha), sha256: sha, exp: Date.now() + 60000 }, key: KEY, settings: t.dock.settings })).ok, true);
    assert.equal((await t.apply('gm-a')).ok, true);
    assert.deepEqual(t.gm.view().map((e) => [e.id, e.sessionId]), [[2, 'gm-a'], [1, 'gm-b']]);
    assert.deepEqual(other.view().map((e) => e.id), [2, 1]);
  } finally { rmrf(t.base); }
});

const FAKE = (dir, init, writePending) => `
const fs = require('fs'), path = require('path');
if (process.argv.includes('--help')) process.exit(0);
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'args.json'), JSON.stringify({ args: process.argv.slice(2), gm: process.env.DOCK_GM, session: process.env.DOCK_GM_SESSION }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', tools: ${JSON.stringify(init)}, mcp_servers: [] }));
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'secret.txt'), 'x');
console.log(JSON.stringify({ type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'Done.\\nDOCK_ATTACH: ' + path.join(${JSON.stringify(dir)}, 'secret.txt') }] } }));
${writePending ? `fs.mkdirSync(path.join(${JSON.stringify(dir)}, 'gm', 'pending'), { recursive: true }); fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'gm', 'pending', 'gm-1.json'), '{"type":"settings","values":{"chatCaveman":"off"},"diff":"d","summary":"s"}');` : ''}
setTimeout(() => {
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'after.txt'), 'ran on');
  console.log(JSON.stringify({ type: 'result', session_id: 's-1', is_error: false }));
}, ${JSON.stringify(init).includes('Write') ? 8000 : 10});
`;

async function gmTurn(dir, { message, init = ['Bash'], writePending = false, respond = () => null }) {
  const cfg = path.join(dir, 'cfg');
  fs.writeFileSync(path.join(dir, 'args-claude.cjs'), FAKE(dir, init, writePending));
  fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'args-claude.cjs'), cwd: dir, configDir: cfg, turnTimeoutMs: 20000, retryBaseMs: 50, interactive: false, activity: false, extraArgs: ['--tools', 'Bash,Write'] }));
  let sent = false;
  const dock = await startServer((req) => {
    const own = respond(req);
    if (own) return own;
    if (!req.url.endsWith('/chat/claim')) return null;
    const m = sent ? null : message;
    sent = true;
    return { json: { ok: true, result: { message: m } } };
  });
  const bridge = spawn(process.execPath, [path.join(KIT, 'dock-chat.cjs'), 'run'], { env: { ...process.env, ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', DOCK_CHAT_TUNING: JSON.stringify({ waitGapMs: 0, doctorEveryMs: 0 }) }, cwd: KIT, stdio: 'ignore', windowsHide: true });
  return { dock, bridge };
}

test('bridge: a gm turn runs sonnet with Bash only; DOCK\'s "ya" nonce writes the change; the new proposal is posted for DOCK to show', async () => {
  for (const confirm of [true, false]) {
    const dir = tmp('gm-turn');
    let run;
    try {
      const cfg = path.join(dir, 'cfg');
      fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
      const file = path.join(cfg, 'agents', 'my-reader.md');
      fs.writeFileSync(file, AGENT);
      const gm = createGm({ stateDir: dir, configDir: cfg });
      gm.proposeAgent('gm-1', 'my-reader', { model: 'sonnet' });
      const sha = sha256(gm.pendingRaw('gm-1'));
      const message = { id: 1, sessionId: 'gm-1', text: confirm ? 'ya' : 'nggak', mode: 'gm', options: { model: 'opus' }, gmKey: KEY, ...(confirm ? { gmConfirm: { nonce: 'n-1', sha256: sha, exp: Date.now() + 60000 } } : {}) };
      run = await gmTurn(dir, { message, writePending: !confirm, respond: (req) => (req.url.endsWith('/chat/gm/confirm') ? { json: { ok: true, result: { ok: req.body.nonce === 'n-1' && req.body.sha256 === sha } } } : null) });
      assert.ok(await waitFor(() => fs.existsSync(path.join(dir, 'args.json')), 15000), 'claude ran');
      const seen = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
      const at = (flag) => seen.args[seen.args.indexOf(flag) + 1];
      assert.equal(at('--model'), 'sonnet');
      assert.equal(seen.args.filter((a) => a === '--tools').length, 1, 'the configured extraArgs are not used');
      assert.equal(at('--tools'), 'Bash');
      assert.match(at('--allowedTools'), /^Bash\(node .*\/gm\.cjs:\*\)$/);
      assert.match(at('--settings'), /guard\.cjs/);
      assert.match(at('--append-system-prompt'), /Guild Master session/);
      assert.deepEqual([seen.gm, seen.session], ['1', 'gm-1']);
      const log = createGm({ stateDir: dir, configDir: cfg }).entries();
      if (confirm) {
        assert.match(fs.readFileSync(file, 'utf8'), /model: sonnet/);
        assert.equal(log.length, 1);
        assert.match(at('-p'), /\[DOCK\] DOCK wrote the pending change: manager log #1/);
        assert.ok(run.dock.requests.some((q) => q.url.endsWith('/chat/gm/confirm')));
      } else {
        assert.equal(fs.readFileSync(file, 'utf8'), AGENT);
        assert.equal(log.length, 0);
        assert.ok(await waitFor(() => run.dock.requests.some((q) => q.url.endsWith('/chat/gm/proposal')), 15000), 'the proposal of this turn is posted');
        const posted = run.dock.requests.find((q) => q.url.endsWith('/chat/gm/proposal')).body;
        assert.deepEqual([posted.sessionId, posted.replyTo], ['gm-1', 1]);
        assert.match(posted.pending, /chatCaveman/, 'the new proposal, not the one "nggak" dropped');
      }
      assert.ok(await waitFor(() => run.dock.requests.some((q) => q.url.endsWith('/chat/delta') && q.body && q.body.done === true), 15000));
      assert.ok(!run.dock.requests.some((q) => q.url.includes('/chat/upload')), 'a gm turn uploads no file');
      const said = run.dock.requests.filter((q) => q.url.endsWith('/chat/delta')).flatMap((q) => (q.body && q.body.items) || []).map((i) => i.text).join('\n');
      assert.match(said, /DOCK_ATTACH:/, 'the line stays plain text');
    } finally {
      if (run) { run.bridge.kill('SIGKILL'); await run.dock.close(); }
      rmrf(dir);
    }
  }
});

test('bridge: a gm turn whose claude starts with more than Bash is killed before it goes on', async () => {
  const dir = tmp('gm-init');
  let run;
  try {
    fs.mkdirSync(path.join(dir, 'cfg', 'agents'), { recursive: true });
    run = await gmTurn(dir, { message: { id: 1, sessionId: 'gm-1', text: 'hi', mode: 'gm' }, init: ['Bash', 'Write'] });
    const items = () => run.dock.requests.filter((q) => q.url.endsWith('/chat/delta')).flatMap((q) => (q.body && q.body.items) || []);
    assert.ok(await waitFor(() => items().some((i) => /Guild Master stopped/.test(i.text)), 15000), 'the owner is told');
    assert.ok(await waitFor(() => run.dock.requests.some((q) => q.url.endsWith('/chat/delta') && q.body && (q.body.done || q.body.error)), 15000));
    assert.ok(!fs.existsSync(path.join(dir, 'after.txt')), 'claude did not run on');
  } finally {
    if (run) { run.bridge.kill('SIGKILL'); await run.dock.close(); }
    rmrf(dir);
  }
});
