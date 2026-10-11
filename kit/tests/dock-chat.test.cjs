'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolvePaths } = require('../paths.cjs');
const chat = require('../dock-chat.cjs');
const { KIT, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv } = require('./helpers.cjs');

const linuxPaths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
const winPaths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:\\Users\\danus\\.claude-kantor\\kit', local: {} });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('settings: Windows defaults are today\'s values', () => {
  const s = chat.settings({ platform: 'win32', paths: winPaths, file: {} });
  assert.equal(s.cwd, 'E:/qonflo');
  assert.equal(s.configDir, 'C:/Users/danus/.claude-kantor');
  assert.equal(s.claudeBin, 'claude');
  assert.equal(s.turnTimeoutMs, 1800000);
  assert.equal(s.permissionMode, null);
  assert.deepEqual(s.keepAwake, { mechanism: 'off', appSlug: null });
});

test('settings: on Linux cwd is the projects root and configDir is unset', () => {
  const s = chat.settings({ platform: 'linux', paths: linuxPaths, file: {} });
  assert.equal(s.cwd, '/home/coder/projects');
  assert.equal(s.configDir, null);
  assert.equal(chat.settings({ platform: 'linux', paths: linuxPaths, file: { configDir: '/x/y', cwd: '/w' } }).configDir, '/x/y');
});

test('childEnv: CLAUDE_CONFIG_DIR is absent when configDir is unset, even if the bridge inherited one', () => {
  const env = chat.childEnv({ configDir: null }, { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:/inherited' });
  assert.ok(!('CLAUDE_CONFIG_DIR' in env));
  assert.equal(env.PATH, 'p');
  assert.equal(chat.childEnv({ configDir: '/c' }, {}).CLAUDE_CONFIG_DIR, '/c');
});

test('childEnv: DOCK_CHAT_TURN=1 marks the unattended profile', () => {
  assert.equal(chat.childEnv({ configDir: null }, {}).DOCK_CHAT_TURN, '1');
});

test('childEnv: the proxy variables used to reach DOCK are stripped, other variables stay', () => {
  const base = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:1055', HTTP_PROXY: 'http://127.0.0.1:1055', https_proxy: 'x', ALL_PROXY: 'y', DOCK_PROXY: 'http://127.0.0.1:1055', NO_PROXY: 'localhost', PATH: 'p', CODER_AGENT_URL: 'u' };
  const env = chat.childEnv({ configDir: null }, base);
  for (const k of ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'DOCK_PROXY']) assert.ok(!(k in env), k);
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(env.PATH, 'p');
  assert.equal(env.CODER_AGENT_URL, 'u');
});

test('childEnv: without the kit\'s proxy marker a machine\'s own proxy settings are left alone (laptop parity)', () => {
  const env = chat.childEnv({ configDir: 'C:/c' }, { HTTPS_PROXY: 'http://corp:8080' });
  assert.equal(env.HTTPS_PROXY, 'http://corp:8080');
});

test('killTree on Windows still uses taskkill /T /F', () => {
  const calls = [];
  chat.killTree({ pid: 4242, kill() { calls.push('child.kill'); } }, { platform: 'win32', run: (cmd, args) => { calls.push([cmd, ...args]); return {}; } });
  assert.deepEqual(calls, [['taskkill', '/pid', '4242', '/T', '/F']]);
});

test('killTree on Linux kills the child and every descendant found through ps', () => {
  const killed = [];
  const ps = '    1     0\n 100     1\n 200   100\n 300   200\n 301   200\n 999     1\n';
  chat.killTree({ pid: 100, kill(sig) { killed.push(['child', sig]); } }, { platform: 'linux', run: (cmd) => ({ stdout: cmd === 'ps' ? ps : '' }), kill: (pid, sig) => killed.push([pid, sig]) });
  assert.deepEqual(killed, [['child', 'SIGKILL'], [200, 'SIGKILL'], [300, 'SIGKILL'], [301, 'SIGKILL']]);
});

test('killTree leaves no process behind: node, a detached child, a grandchild', async () => {
  const dir = tmp('killtree');
  try {
    fs.writeFileSync(path.join(dir, 'grand.cjs'), 'setTimeout(() => {}, 60000);');
    fs.writeFileSync(path.join(dir, 'child.cjs'), `const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' }); console.log(g.pid); setTimeout(() => {}, 60000);`);
    fs.writeFileSync(path.join(dir, 'parent.cjs'), `const { spawn } = require('child_process'); const c = spawn(process.execPath, [${JSON.stringify(path.join(dir, 'child.cjs'))}], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }); let t = ''; c.stdout.on('data', (d) => { t += d; if (t.includes('\\n')) console.log(JSON.stringify({ child: c.pid, grand: Number(t.trim()) })); }); setTimeout(() => {}, 60000);`);
    const parent = spawn(process.execPath, [path.join(dir, 'parent.cjs')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let seen = '';
    parent.stdout.on('data', (d) => { seen += d; });
    assert.ok(await waitFor(() => seen.includes('}')), 'the tree started');
    const pids = { parent: parent.pid, ...JSON.parse(seen.trim().split('\n').pop()) };
    for (const [name, pid] of Object.entries(pids)) assert.ok(alive(pid), `${name} is running before the kill`);
    chat.killTree(parent);
    assert.ok(await waitFor(() => Object.values(pids).every((pid) => !alive(pid)), 10000), `no process left: ${JSON.stringify(Object.fromEntries(Object.entries(pids).map(([n, p]) => [n, alive(p)])))}`);
  } finally { rmrf(dir); }
});

test('keepAwake: off by default, no-op for the server-side mechanism, not configured without the agent environment', async () => {
  const memo = { last: 0, failLoggedAt: 0 };
  assert.equal(await chat.keepAwake('working', { keepAwake: { mechanism: 'off' } }, { memo }), 'off');
  assert.equal(await chat.keepAwake('working', {}, { memo }), 'off');
  assert.equal(await chat.keepAwake('working', { keepAwake: { mechanism: 'server' } }, { memo, env: { CODER_AGENT_URL: 'http://x', CODER_AGENT_TOKEN: 't' } }), 'not-configured');
  assert.equal(await chat.keepAwake('working', { keepAwake: { mechanism: 'app-status', appSlug: 'claude-code' } }, { memo, env: {} }), 'not-configured');
  assert.equal(await chat.keepAwake('working', { keepAwake: { mechanism: 'app-status', appSlug: null } }, { memo, env: { CODER_AGENT_URL: 'http://x', CODER_AGENT_TOKEN: 't' } }), 'not-configured');
});

test('keepAwake app-status: PATCHes the agent API with the agent token, at most once per 10 minutes, idle always', async () => {
  const fake = await startServer();
  try {
    const memo = { last: 0, failLoggedAt: 0 };
    const cfg = { keepAwake: { mechanism: 'app-status', appSlug: 'claude-code' } };
    let clock = 1_000_000;
    const deps = { memo, now: () => clock, env: { CODER_AGENT_URL: fake.url + '/', CODER_AGENT_TOKEN: 'tk-1' } };
    assert.equal(await chat.keepAwake('working', cfg, deps), 'sent');
    assert.equal(await chat.keepAwake('working', cfg, deps), 'throttled');
    clock += 11 * 60 * 1000;
    assert.equal(await chat.keepAwake('working', cfg, deps), 'sent');
    assert.equal(await chat.keepAwake('working', cfg, { ...deps, force: true }), 'sent');
    assert.equal(await chat.keepAwake('idle', cfg, deps), 'sent');
    assert.equal(fake.requests.length, 4);
    const first = fake.requests[0];
    assert.equal(first.method, 'PATCH');
    assert.equal(first.url, '/api/v2/workspaceagents/me/app-status');
    assert.equal(first.headers['coder-session-token'], 'tk-1');
    assert.deepEqual(first.body, { app_slug: 'claude-code', state: 'working', message: 'DOCK chat turn', uri: '' });
    assert.equal(fake.requests[3].body.state, 'idle');
  } finally { await fake.close(); }
});

test('keepAwake never throws: a refusing or unreachable Coder resolves "failed"', async () => {
  const fake = await startServer(() => ({ status: 400, json: { message: 'No app found with slug' } }));
  try {
    const cfg = { keepAwake: { mechanism: 'app-status', appSlug: 'nope' } };
    const env = { CODER_AGENT_URL: fake.url, CODER_AGENT_TOKEN: 't' };
    assert.equal(await chat.keepAwake('working', cfg, { memo: { last: 0, failLoggedAt: Date.now() }, env }), 'failed');
    assert.equal(await chat.keepAwake('working', cfg, { memo: { last: 0, failLoggedAt: Date.now() }, env: { ...env, CODER_AGENT_URL: 'http://127.0.0.1:1' } }), 'failed');
  } finally { await fake.close(); }
});

// A whole chat turn against a fake DOCK and a fake `claude` that reports the environment it was started with.
test('a chat turn: claude runs unattended, with the configured config dir and without the DOCK proxy variables', async () => {
  const dir = tmp('chat-turn');
  let dock;
  try {
    const cfgDir = path.join(dir, 'claude-cfg');
    fs.writeFileSync(path.join(dir, 'fake-claude.cjs'), `
const env = process.env;
const facts = { turn: env.DOCK_CHAT_TURN, cfg: env.CLAUDE_CONFIG_DIR, proxies: ['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY', 'DOCK_PROXY'].filter((k) => k in env), args: process.argv.slice(2, 5), cwd: process.cwd().length > 0 };
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
console.log(JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'FACTS ' + JSON.stringify(facts) }] } }));
console.log(JSON.stringify({ type: 'result', session_id: 'sess-1', is_error: false }));
`);
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'fake-claude.cjs'), cwd: dir, configDir: cfgDir, turnTimeoutMs: 20000, retryBaseMs: 50 }));
    let claimed = false;
    dock = await startServer((req) => {
      if (req.url.endsWith('/chat/claim')) {
        if (claimed) return { json: { ok: true, result: { message: null } } };
        claimed = true;
        return { json: { ok: true, result: { message: { id: 7, sessionId: 'dock-s1', text: 'hello', claudeSessionId: null } } } };
      }
      return null;
    });
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
      env: {
        ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test',
        NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', DOCK_PROXY: '',
      },
    });
    assert.equal(r.code, 0, r.stderr);
    const deltas = dock.requests.filter((q) => q.url.endsWith('/chat/delta'));
    assert.ok(deltas.length >= 1, 'a delta reached DOCK');
    const text = deltas.flatMap((d) => d.body.items).map((i) => i.text).join('\n');
    const facts = JSON.parse(text.slice(text.indexOf('FACTS ') + 6).split('\n')[0]);
    assert.equal(facts.turn, '1');
    assert.equal(facts.cfg, path.join(dir, 'claude-cfg'));
    assert.deepEqual(facts.proxies, []);
    assert.equal(deltas.at(-1).body.done, true);
    assert.equal(deltas.at(-1).body.claudeSessionId, 'sess-1');
    assert.equal(deltas[0].headers.authorization, 'Bearer dock_ing_test');
    assert.ok(!deltas.some((d) => 'machine' in d.body), 'the client never sends a machine name');
  } finally {
    if (dock) await dock.close();
    rmrf(dir);
  }
});

test('a chat turn that overruns turnTimeoutMs is stopped and reported', async () => {
  const dir = tmp('chat-timeout');
  let dock;
  try {
    fs.writeFileSync(path.join(dir, 'slow-claude.cjs'), `console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' })); setTimeout(() => {}, 60000);`);
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'slow-claude.cjs'), cwd: dir, turnTimeoutMs: 1500, retryBaseMs: 50 }));
    let claimed = false;
    dock = await startServer((req) => {
      if (req.url.endsWith('/chat/claim')) {
        if (claimed) return { json: { ok: true, result: { message: null } } };
        claimed = true;
        return { json: { ok: true, result: { message: { id: 8, sessionId: 'dock-s2', text: 'hi' } } } };
      }
      return null;
    });
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], { env: { ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' } });
    assert.equal(r.code, 0, r.stderr);
    const last = dock.requests.filter((q) => q.url.endsWith('/chat/delta')).at(-1).body;
    assert.match(last.error, /ran longer than 2 seconds and was stopped/);
  } finally {
    if (dock) await dock.close();
    rmrf(dir);
  }
});
