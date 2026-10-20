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
  assert.match(s.appendSystemPrompt, /^This turn runs from DOCK chat.*Skills: /);
  assert.ok(!/[\r\n"]/.test(s.appendSystemPrompt), 'one line, no quotes: safe as a single argument');
  assert.equal(chat.settings({ platform: 'win32', paths: winPaths, file: { appendSystemPrompt: '' } }).appendSystemPrompt, '', 'the owner can switch it off');
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

// ---------- activity feed (P2) ----------
const STREAMS = path.join(KIT, 'tests', 'fixtures', 'stream');
const FAKE_REPLAY = `
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--help') {
  process.stdout.write('Usage: claude [options]\\n  --verbose  Override verbose mode\\n' + (process.env.FAKE_NO_FLAGS ? '' : '  --include-hook-events  Include hooks\\n  --forward-subagent-text  Forward text\\n'));
  process.exit(0);
}
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const lines = fs.readFileSync(process.env.FAKE_STREAM, 'utf8').split('\\n').filter(Boolean);
const delay = Number(process.env.FAKE_DELAY_MS || 0);
(async () => {
  for (const l of lines) { process.stdout.write(l + '\\n'); if (delay) await new Promise((r) => setTimeout(r, delay)); }
  if (process.env.FAKE_HANG) { setInterval(() => {}, 1000); return; }
  process.exit(Number(process.env.FAKE_EXIT || 0));
})();
`;

// Runs one whole turn through `dock-chat.cjs once` against a fake DOCK and a fake claude that replays `stream`.
async function activityTurn({ stream, config = {}, respond = () => null, delay = 0, env = {}, labelsDir } = {}) {
  const dir = tmp('chat-activity');
  let dock;
  try {
    fs.writeFileSync(path.join(dir, 'fake-claude.cjs'), FAKE_REPLAY);
    const cfg = { claudeBin: path.join(dir, 'fake-claude.cjs'), cwd: dir, turnTimeoutMs: 20000, retryBaseMs: 50, ...config };
    if (labelsDir) cfg.activity = { ...(typeof cfg.activity === 'object' ? cfg.activity : {}), labelsDir };
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify(cfg));
    const streamFile = path.isAbsolute(stream) ? stream : path.join(STREAMS, stream);
    let claimed = false;
    dock = await startServer((req) => {
      if (req.url.endsWith('/chat/claim')) {
        if (claimed) return { json: { ok: true, result: { message: null } } };
        claimed = true;
        return { json: { ok: true, result: { message: { id: 12, sessionId: 'dock-act-1', text: 'hello', claudeSessionId: null } } } };
      }
      return req.url.endsWith('/chat/activity') ? respond(req) : null;
    });
    const started = Date.now();
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
      env: { ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', FAKE_STREAM: streamFile, FAKE_ARGS_FILE: path.join(dir, 'args.json'), FAKE_DELAY_MS: String(delay), ...env },
    });
    const elapsed = Date.now() - started;
    let args = null; try { args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')); } catch {}
    const requests = dock.requests.filter((q) => !q.url.endsWith('/chat/claim'));
    const deltas = requests.filter((q) => q.url.endsWith('/chat/delta'));
    const activity = requests.filter((q) => q.url.endsWith('/chat/activity'));
    // The text the owner would read, independent of how the deltas were batched in time.
    const items = deltas.flatMap((d) => d.body.items).map((i) => `${i.role}: ${i.text}`);
    return { r, requests, deltas, activity, items, args, elapsed, last: deltas.at(-1) && deltas.at(-1).body };
  } finally {
    if (dock) await dock.close();
    rmrf(dir);
  }
}
const CLAUDE_TODAY = ['-p', 'hello', '--output-format', 'stream-json', '--verbose'];
const SKILL_LINE = ['--append-system-prompt', chat.settings({ platform: 'win32', paths: winPaths, file: {} }).appendSystemPrompt];
const rowsOf = (turn) => turn.activity.flatMap((q) => q.body.events);
const finalRows = (turn) => { const m = new Map(); for (const e of rowsOf(turn)) m.set(e.id, e); return m; };

test('settings: activity is on by default and switched off by "activity": false or enabled: false', () => {
  assert.deepEqual(chat.settings({ platform: 'linux', paths: linuxPaths, file: {} }).activity, { enabled: true, hooks: true, subagentText: true, labelsDir: null });
  assert.equal(chat.settings({ platform: 'linux', paths: linuxPaths, file: { activity: false } }).activity.enabled, false);
  assert.equal(chat.settings({ platform: 'linux', paths: linuxPaths, file: { activity: { enabled: false } } }).activity.enabled, false);
  const s = chat.settings({ platform: 'linux', paths: linuxPaths, file: { activity: { hooks: false, subagentText: false } } }).activity;
  assert.deepEqual([s.enabled, s.hooks, s.subagentText], [true, false, false]);
});

test('an activity turn: the flags are added, /chat/activity arrives before the final delta, nothing is left running', async () => {
  const t = await activityTurn({ stream: 'turn-2-subagent.jsonl' });
  assert.equal(t.r.code, 0, t.r.stderr);
  assert.deepEqual(t.args, [...CLAUDE_TODAY, '--include-hook-events', '--forward-subagent-text', ...SKILL_LINE]);
  assert.ok(t.activity.length >= 1);
  const order = t.requests.map((q) => q.url.replace('/ingest/orchestrator', ''));
  assert.equal(order.at(-1), '/chat/delta');
  assert.ok(order.lastIndexOf('/chat/activity') < order.length - 1, 'the last activity post comes before the final delta');
  assert.equal(t.last.done, true);
  for (const q of t.activity) {
    assert.deepEqual(Object.keys(q.body), ['v', 'sessionId', 'replyTo', 'events']);
    assert.deepEqual([q.body.v, q.body.sessionId, q.body.replyTo], [1, 'dock-act-1', 12]);
    assert.equal(q.headers.authorization, 'Bearer dock_ing_test');
    assert.ok(q.body.events.length >= 1 && q.body.events.length <= 50);
    assert.ok(!('machine' in q.body));
  }
  const rows = finalRows(t);
  assert.deepEqual([...rows.values()].map((e) => [e.kind, e.status]), [['agent', 'ok'], ['tool', 'ok'], ['note', 'ok']]);
  assert.equal([...rows.values()][1].parentId, [...rows.values()][0].id);
});

test('a background agent still running at the result puts subagentsRunning on the done delta, a foreground turn does not', async () => {
  const bg = await activityTurn({ stream: 'synthetic-background-agent.jsonl' });
  assert.equal(bg.r.code, 0, bg.r.stderr);
  assert.equal(bg.last.done, true);
  assert.equal(bg.last.subagentsRunning, 1);
  assert.ok(bg.deltas.slice(0, -1).every((d) => !('subagentsRunning' in d.body)));
  assert.ok(finalRows(bg).has('sub-kill-toolu_SYN_BG1'));
  const fg = await activityTurn({ stream: 'turn-2-subagent.jsonl' });
  assert.ok(!('subagentsRunning' in fg.last));
});

test('subagentsRunning does not need the activity tracker, and a launch without the flag still counts', async () => {
  for (const stream of ['synthetic-background-agent.jsonl', 'synthetic-background-agent-noflag.jsonl']) {
    const t = await activityTurn({ stream, config: { activity: false } });
    assert.equal(t.r.code, 0, t.r.stderr);
    assert.equal(t.last.done, true);
    assert.equal(t.last.subagentsRunning, 1);
    assert.equal(t.activity.length, 0);
  }
});

test('with activity on, the delta requests carry exactly the same text, session id and done flag as with it off', async () => {
  const on = await activityTurn({ stream: 'turn-2-subagent.jsonl' });
  const off = await activityTurn({ stream: 'turn-2-subagent.jsonl', config: { activity: false } });
  assert.deepEqual(on.items, off.items);
  assert.ok(on.items.length >= 3);
  assert.deepEqual([on.last.done, on.last.error, on.last.claudeSessionId], [off.last.done, off.last.error, off.last.claudeSessionId]);
  assert.ok(on.deltas.every((d) => Object.keys(d.body).every((k) => ['sessionId', 'replyTo', 'items', 'done', 'error', 'claudeSessionId', 'detail'].includes(k))));
});

test('activity switched off: today\'s claude arguments, today\'s requests, no activity route touched', async () => {
  for (const config of [{ activity: false }, { activity: { enabled: false } }]) {
    const t = await activityTurn({ stream: 'synthetic-denial.jsonl', config });
    assert.equal(t.r.code, 0, t.r.stderr);
    assert.deepEqual(t.args, [...CLAUDE_TODAY, ...SKILL_LINE]);
    assert.equal(t.activity.length, 0);
    assert.ok(t.requests.every((q) => q.url.endsWith('/chat/delta') || q.url.endsWith('/chat/status')));
    assert.equal(t.last.done, true);
    assert.ok(t.items.some((i) => i.startsWith('tool: Bash')), 'tool items are still sent as today');
  }
});

test('text forwarded from a subagent is not a chat bubble when activity is on, and becomes the agent summary instead', async () => {
  const on = await activityTurn({ stream: 'synthetic-nested-agents.jsonl' });
  assert.ok(!on.items.some((i) => i.includes('Working on level two.')));
  assert.ok(on.items.some((i) => i === 'assistant: Done.'));
  assert.equal(finalRows(on).get('toolu_SYN_A2').summary, 'Working on level two.');
  assert.ok(on.items.some((i) => i.startsWith('tool: Bash')), 'subagent tool calls stay tool items as today');
});

test('a claude whose --help lacks the two flags is started without them, and activity still works', async () => {
  const t = await activityTurn({ stream: 'synthetic-denial.jsonl', env: { FAKE_NO_FLAGS: '1' } });
  assert.deepEqual(t.args, [...CLAUDE_TODAY, ...SKILL_LINE]);
  assert.ok(t.activity.length >= 1);
  assert.equal(finalRows(t).get('toolu_SYN_D1').status, 'denied');
  const partial = await activityTurn({ stream: 'synthetic-denial.jsonl', config: { activity: { hooks: false } } });
  assert.deepEqual(partial.args, [...CLAUDE_TODAY, '--forward-subagent-text', ...SKILL_LINE]);
});

test('an older DOCK answering 404 to /chat/activity: exactly one activity request, the turn still ends done with every delta', async () => {
  const old = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 150, respond: () => ({ status: 404, json: { ok: false } }) });
  const off = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 150, config: { activity: false } });
  assert.equal(old.r.code, 0, old.r.stderr);
  assert.equal(old.activity.length, 1);
  assert.equal(old.last.done, true);
  assert.deepEqual(old.items, off.items);
  assert.match(old.r.stdout, /older server/);
});

test('an unknown session (404 "Unknown ticket") stops activity for the turn without being taken for an old server', async () => {
  const t = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 150, respond: () => ({ status: 404, json: { error: 'Unknown ticket. Send its status first.' } }) });
  assert.equal(t.activity.length, 1);
  assert.doesNotMatch(t.r.stdout, /older server/);
  assert.equal(t.last.done, true);
});

test('"closed": true from the server ends the activity posts for that turn', async () => {
  const t = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 150, respond: () => ({ json: { ok: true, result: { accepted: 0, seq: 1, dropped: 0, closed: true } } }) });
  assert.equal(t.activity.length, 1);
  assert.equal(t.last.done, true);
});

test('an activity route answering 500: the turn finishes done with the same deltas, claude is not killed, one log line', async () => {
  const bad = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 150, respond: () => ({ status: 500, json: { error: 'boom' } }) });
  const off = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 150, config: { activity: false } });
  assert.equal(bad.r.code, 0, bad.r.stderr);
  assert.equal(bad.last.done, true);
  assert.equal(bad.last.error, null);
  assert.deepEqual(bad.items, off.items);
  assert.equal((bad.r.stdout.match(/activity: /g) || []).length, 1, bad.r.stdout);
  assert.ok(bad.activity.length >= 2, 'it retried');
});

test('an activity route that hangs: the turn finishes done with the same deltas and is not held up for long', async () => {
  const hung = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 100, respond: () => ({ hang: true }) });
  const off = await activityTurn({ stream: 'synthetic-denial.jsonl', delay: 100, config: { activity: false } });
  assert.equal(hung.r.code, 0, hung.r.stderr);
  assert.equal(hung.last.done, true);
  assert.deepEqual(hung.items, off.items);
  assert.ok(hung.deltas.length >= 1);
});

test('a failed post is retried with the same rows; the rows end with their final status', async () => {
  let n = 0;
  const t = await activityTurn({ stream: 'synthetic-nested-agents.jsonl', delay: 200, respond: () => (++n <= 2 ? { status: 503, json: {} } : null) });
  assert.equal(t.r.code, 0, t.r.stderr);
  const ids = new Set(['toolu_SYN_A1', 'toolu_SYN_A2', 'toolu_SYN_A3', 'toolu_SYN_A4', 'toolu_SYN_A5']);
  const rows = finalRows(t);
  for (const id of ids) assert.equal(rows.get(id).status, 'ok', id);
  const firstSeen = t.activity[0].body.events.map((e) => e.id);
  const okPosts = t.activity.slice(2).flatMap((q) => q.body.events.map((e) => e.id));
  for (const id of firstSeen) assert.ok(okPosts.includes(id), `${id} was posted again after the failure`);
});

test('a stream cut off mid-turn (claude exits without a result): running rows are posted as stopped before the final delta', async () => {
  const t = await activityTurn({ stream: 'synthetic-cutoff.jsonl' });
  assert.equal(t.last.done, true);
  const rows = finalRows(t);
  assert.deepEqual(['toolu_SYN_C1', 'toolu_SYN_C2', 'toolu_SYN_C3', 'toolu_SYN_C4'].map((id) => rows.get(id).status), ['ok', 'stopped', 'stopped', 'stopped']);
  const order = t.requests.map((q) => q.url.replace('/ingest/orchestrator', ''));
  assert.ok(order.lastIndexOf('/chat/activity') < order.lastIndexOf('/chat/delta'));
});

test('a turn killed by the timeout also closes its rows as stopped, then reports the error', async () => {
  const t = await activityTurn({ stream: 'synthetic-cutoff.jsonl', config: { turnTimeoutMs: 2500 }, env: { FAKE_HANG: '1' } });
  assert.match(t.last.error, /ran longer than 3 seconds|ran longer than 2 seconds/);
  assert.equal(finalRows(t).get('toolu_SYN_C2').status, 'stopped');
  const order = t.requests.map((q) => q.url.replace('/ingest/orchestrator', ''));
  assert.ok(order.lastIndexOf('/chat/activity') < order.lastIndexOf('/chat/delta'));
});

test('no secret reaches DOCK in an activity request: commands, output, a subagent report and hook output', async () => {
  const dir = tmp('canary-stream');
  try {
    const S = 'sess-canary';
    const canaries = [['dock', '_ing_CNRYaaaaaaaaaaaaaaaaaaaaaaaa'], ['sk', '-CNRYaaaaaaaaaaaaaaaaaaaa'], ['Bear', 'er CNRYaaaaaaaaaaaaaaaaaaaaaaaa'], ['pass', 'word=CNRYhunter2hunter2'], ['gh', 'p_CNRYaaaaaaaaaaaaaaaaaaaa']].map((p) => p.join(''));
    const tu = (id, name, input, parent = null) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent, session_id: S });
    const tr = (id, content, parent = null) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: parent, session_id: S });
    const events = [{ type: 'system', subtype: 'init', session_id: S }];
    canaries.forEach((c, i) => {
      events.push(tu(`k${i}`, 'Bash', { command: `curl -d '${c}' https://example.test`, description: `post ${c}` }), tr(`k${i}`, `ok ${c}\n${'x'.repeat(589)} ${c} ${'y'.repeat(3000)} ${c} ${'z'.repeat(380)}`));
    });
    events.push(tu('ag', 'Agent', { subagent_type: 'explore', description: `scan ${canaries[0]}`, prompt: `use ${canaries[1]}` }));
    events.push({ type: 'assistant', message: { content: [{ type: 'text', text: `found ${canaries[2]}` }] }, parent_tool_use_id: 'ag', session_id: S });
    events.push({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', exit_code: 2, outcome: 'blocking', stdout: canaries[3], stderr: canaries[4], output: canaries[0], session_id: S });
    events.push(tr('ag', [{ type: 'text', text: `report ${canaries.join(' ')} ${'r'.repeat(900)} ${canaries.join(' ')}` }]));
    events.push(tu('pe', 'Bash', { command: 'printenv' }), tr('pe', 'DOCK_INGEST_TOKEN=CNRYenvvalue\nHOME=/x'));
    events.push({ type: 'result', subtype: 'success', is_error: false, session_id: S });
    const file = path.join(dir, 'canary.jsonl');
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const t = await activityTurn({ stream: file });
    assert.equal(t.r.code, 0, t.r.stderr);
    assert.ok(t.activity.length >= 1 && rowsOf(t).length >= 7);
    const body = JSON.stringify(t.activity.map((q) => q.body));
    assert.ok(!body.includes('CNRY'), body.slice(body.indexOf('CNRY') - 80, body.indexOf('CNRY') + 80));
    assert.match(finalRows(t).get('pe').detail, /\[output hidden: sensitive command\]$/);
  } finally { rmrf(dir); }
});

test('a broken activity-labels.json: the turn is unaffected, built-in labels are used, the problem is logged once', async () => {
  const dir = tmp('labels-turn');
  try {
    fs.writeFileSync(path.join(dir, 'activity-labels.json'), '{ not json');
    const t = await activityTurn({ stream: 'synthetic-denial.jsonl', labelsDir: dir });
    assert.equal(t.r.code, 0, t.r.stderr);
    assert.equal(t.last.done, true);
    assert.equal(finalRows(t).get('toolu_SYN_D1').label, 'Git: push');
    assert.equal((t.r.stdout.match(/activity labels:/g) || []).length, 1, t.r.stdout);
  } finally { rmrf(dir); }
});

test('dock-chat.cjs label prints the label for a command, and whether its output is hidden', async () => {
  const run = (cmd) => runNode([path.join(KIT, 'dock-chat.cjs'), 'label', cmd]);
  assert.equal((await run("python3 ~/brain/scripts/brain.py retrieve 'review PR verdict'")).stdout.trim(), "Brain: retrieve 'review PR verdict'");
  assert.equal((await run('rtk powershell -NoProfile -File E:/obsidian/Brain/scripts/brain-retrieve.ps1 "review PR verdict"')).stdout.trim(), "Brain: retrieve 'review PR verdict'");
  assert.equal((await run('cd E:/qonflo && git status')).stdout.trim(), 'Git: status');
  assert.equal((await run('npx vitest run src/a.test.ts')).stdout.trim(), 'Run vitest');
  assert.equal((await run('printenv')).stdout.trim(), 'Bash\noutput: hidden (sensitive command)\nno rule matched');
  assert.equal((await run('cat .env')).stdout.split('\n')[1], 'output: hidden (sensitive command)');
});

test('limitsOf: the windows of a rate_limit_event become status line limits in percent', () => {
  const event = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1791913800 }, seven_day: { utilization: 0.5, resetsAt: 1792407600 } } } };
  assert.deepEqual(chat.limitsOf(event), { fiveHour: { usedPercentage: 25, resetsAt: 1791913800 }, sevenDay: { usedPercentage: 50, resetsAt: 1792407600 } });
  assert.deepEqual(chat.limitsOf({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), { fiveHour: undefined, sevenDay: undefined });
  assert.deepEqual(chat.limitsOf({ type: 'rate_limit_event' }), { fiveHour: undefined, sevenDay: undefined });
});

test('a chat turn posts the usage limits claude reports to /chat/status, under the DOCK session', async () => {
  const t = await activityTurn({ stream: 'synthetic-rate-limit.jsonl' });
  assert.equal(t.r.code, 0, t.r.stderr);
  const status = t.requests.filter((q) => q.url.endsWith('/chat/status') && q.body.fiveHour);
  assert.equal(status.length, 1);
  assert.deepEqual(status[0].body, { sessionId: 'dock-act-1', fiveHour: { usedPercentage: 25, resetsAt: 1791913800 }, sevenDay: { usedPercentage: 50, resetsAt: 1792407600 } });
  assert.equal(t.last.done, true);
});

test('settings: parallelTurns defaults to 3 and never drops below 1', () => {
  const at = (file) => chat.settings({ platform: 'linux', paths: linuxPaths, file }).parallelTurns;
  assert.equal(at({}), 3);
  assert.equal(at({ parallelTurns: 2 }), 2);
  assert.equal(at({ parallelTurns: 0 }), 3);
  assert.equal(at({ parallelTurns: -4 }), 1);
  assert.equal(at({ parallelTurns: 'x' }), 3);
  assert.equal(at({ maxTurns: 9 }), 3, 'maxTurns stays claude\'s --max-turns');
});

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('turn pool: with a limit of 2 the second turn starts before the first finishes', async () => {
  const pool = chat.createTurnPool(2);
  const first = gate(), events = [];
  pool.start(async () => { events.push('start1'); await first.p; events.push('end1'); }, () => {});
  await pool.slot();
  pool.start(async () => { events.push('start2'); }, () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ['start1', 'start2']);
  first.open();
});

test('turn pool: with a limit of 1 turns run one after the other', async () => {
  const pool = chat.createTurnPool(1);
  const first = gate(), events = [];
  pool.start(async () => { events.push('start1'); await first.p; events.push('end1'); }, () => {});
  let admitted = false;
  const next = pool.slot().then(() => { admitted = true; pool.start(async () => { events.push('start2'); }, () => {}); });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(admitted, false);
  first.open();
  await next;
  assert.deepEqual(events, ['start1', 'end1', 'start2']);
});

test('turn pool: at capacity slot() waits and frees as soon as any turn settles', async () => {
  const pool = chat.createTurnPool(2);
  const a = gate(), b = gate();
  pool.start(() => a.p, () => {});
  pool.start(() => b.p, () => {});
  let free = false;
  const waiting = pool.slot().then(() => { free = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(free, false);
  b.open();
  await waiting;
  assert.equal(free, true);
  a.open();
});

test('turn pool: a turn that throws is reported, frees its slot and does not stop the others', async () => {
  const pool = chat.createTurnPool(1);
  const errors = [];
  await pool.start(async () => { throw new Error('boom'); }, (e) => errors.push(e.message));
  await pool.slot();
  let ran = false;
  await pool.start(async () => { ran = true; }, (e) => errors.push(e.message));
  assert.deepEqual(errors, ['boom']);
  assert.equal(ran, true);
  await Promise.race([pool.slot(), new Promise((_, rej) => setTimeout(() => rej(new Error('slot leaked')), 500))]);
  await pool.start(async () => { throw new Error('x'); }, () => { throw new Error('handler failed too'); });
  await pool.slot();
});

test('bridge run: two claimed messages run at the same time with parallelTurns 2, one after the other with 1', async () => {
  for (const [parallel, overlap] of [[2, true], [1, false]]) {
    const dir = tmp(`chat-par${parallel}`);
    let dock, bridge;
    try {
      fs.writeFileSync(path.join(dir, 'par-claude.cjs'), `
const fs = require('fs'), path = require('path');
if (process.argv.includes('--help')) process.exit(0);
const id = process.argv[process.argv.indexOf('-p') + 1];
fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'order.log'), 'start-' + id + '\\n');
setTimeout(() => {
  fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'order.log'), 'end-' + id + '\\n');
  console.log(JSON.stringify({ type: 'result', session_id: 's-' + id, is_error: false }));
}, 1200);
`);
      fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'par-claude.cjs'), cwd: dir, turnTimeoutMs: 20000, retryBaseMs: 50, parallelTurns: parallel, interactive: false, activity: false }));
      const queue = [1, 2];
      dock = await startServer((req) => {
        if (!req.url.endsWith('/chat/claim')) return null;
        const n = queue.shift();
        return { json: { ok: true, result: { message: n ? { id: n, sessionId: `dock-par-${n}`, text: String(n) } : null } } };
      });
      bridge = spawn(process.execPath, [path.join(KIT, 'dock-chat.cjs'), 'run'], { env: { ...process.env, ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', DOCK_CHAT_TUNING: JSON.stringify({ waitGapMs: 0, doctorEveryMs: 0 }) }, cwd: KIT, stdio: 'ignore', windowsHide: true });
      const log = () => { try { return fs.readFileSync(path.join(dir, 'order.log'), 'utf8').trim().split('\n'); } catch { return []; } };
      assert.ok(await waitFor(() => log().filter((l) => l.startsWith('end-')).length === 2, 15000), `both turns finished: ${log()}`);
      const lines = log();
      if (overlap) assert.deepEqual(lines.slice(0, 2).sort(), ['start-1', 'start-2'], `both started before any ended: ${lines}`);
      else assert.deepEqual(lines, ['start-1', 'end-1', 'start-2', 'end-2']);
      assert.ok(await waitFor(() => dock.requests.filter((q) => q.url.endsWith('/chat/delta') && q.body.done === true).length === 2), 'both turns reported done');
    } finally {
      if (bridge) bridge.kill('SIGKILL');
      if (dock) await dock.close();
      rmrf(dir);
    }
  }
});

test('bridge run: the one-shot path uses the permission mode the message asks for, else the configured one', async () => {
  for (const [options, configured, expected] of [[{ permissionMode: 'auto' }, null, 'auto'], [{ permissionMode: 'bogus' }, 'acceptEdits', 'acceptEdits'], [undefined, null, null]]) {
    const dir = tmp('chat-legacy-mode');
    let dock, bridge;
    try {
      fs.writeFileSync(path.join(dir, 'args-claude.cjs'), `
const fs = require('fs'), path = require('path');
if (process.argv.includes('--help')) process.exit(0);
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'args.json'), JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'result', session_id: 's-1', is_error: false }));
`);
      fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'args-claude.cjs'), cwd: dir, turnTimeoutMs: 20000, retryBaseMs: 50, permissionMode: configured, interactive: false, activity: false }));
      let sent = false;
      dock = await startServer((req) => {
        if (!req.url.endsWith('/chat/claim')) return null;
        const message = sent ? null : { id: 1, sessionId: 'dock-mode-1', text: 'hello', options };
        sent = true;
        return { json: { ok: true, result: { message } } };
      });
      bridge = spawn(process.execPath, [path.join(KIT, 'dock-chat.cjs'), 'run'], { env: { ...process.env, ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', DOCK_CHAT_TUNING: JSON.stringify({ waitGapMs: 0, doctorEveryMs: 0 }) }, cwd: KIT, stdio: 'ignore', windowsHide: true });
      assert.ok(await waitFor(() => fs.existsSync(path.join(dir, 'args.json')), 15000), 'claude ran');
      const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
      const at = args.indexOf('--permission-mode');
      assert.equal(at === -1 ? null : args[at + 1], expected, JSON.stringify(args));
    } finally {
      if (bridge) bridge.kill('SIGKILL');
      if (dock) await dock.close();
      rmrf(dir);
    }
  }
});

test('bridge run: pushes a doctor report on start and when a claim asks for one', async () => {
  for (const [tuning, asked] of [[{ waitGapMs: 0, doctorEveryMs: 0 }, true], [{ waitGapMs: 0 }, false]]) {
    const dir = tmp('chat-doctor');
    let dock, bridge;
    try {
      fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: process.execPath, cwd: dir, retryBaseMs: 50, interactive: false, activity: false }));
      let claims = 0;
      dock = await startServer((req) => {
        if (req.url.endsWith('/doctor')) return { json: { ok: true, result: {} } };
        if (!req.url.endsWith('/chat/claim')) return null;
        claims++;
        return { json: { ok: true, result: { message: null, ...(asked && claims === 1 ? { wantDoctor: true } : {}) } } };
      });
      bridge = spawn(process.execPath, [path.join(KIT, 'dock-chat.cjs'), 'run'], { env: { ...process.env, ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', DOCK_CHAT_TUNING: JSON.stringify(tuning) }, cwd: KIT, stdio: 'ignore', windowsHide: true });
      const reports = () => dock.requests.filter((q) => q.url.endsWith('/doctor'));
      assert.ok(await waitFor(() => reports().length === 1, 60000), asked ? 'the asked doctor run reached DOCK' : 'the start-up doctor run reached DOCK');
      assert.ok(Array.isArray(reports()[0].body.checks) && reports()[0].body.checks.length > 0, 'the report carries its checks');
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(reports().length, 1, 'one run, not one per claim');
    } finally {
      if (bridge) bridge.kill('SIGKILL');
      if (dock) await dock.close();
      rmrf(dir);
    }
  }
});
