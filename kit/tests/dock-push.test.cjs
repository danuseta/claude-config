'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const path = require('path');
const { KIT, SOURCE_KIT, hasSource, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv } = require('./helpers.cjs');

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const normalize = (reqs) => reqs.map((q) => JSON.stringify({ method: q.method, url: q.url, auth: q.headers.authorization, type: q.headers['content-type'], body: q.body })
  .replace(ISO, '<time>'));

// An HTTP CONNECT proxy that tunnels to whatever it is asked for and remembers the targets.
function startProxy() {
  const targets = [];
  const server = http.createServer((req, res) => res.writeHead(405).end());
  server.on('connect', (req, socket, head) => {
    targets.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, targets, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

test('send() reaches DOCK through the DOCK_PROXY CONNECT tunnel, same request and same answer as a direct call', async () => {
  const dir = tmp('push-proxy');
  const dock = await startServer(() => ({ json: { ok: true, result: { message: null } } }));
  const proxy = await startProxy();
  try {
    const script = "require(process.argv[1]).send('/chat/claim', { wait: 0 }, 5000).then((r) => console.log(JSON.stringify(r)))";
    const env = { ...sandboxEnv(dir), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' };
    const direct = await runNode(['-e', script, path.join(KIT, 'dock-push.cjs')], { env: { ...env, DOCK_PROXY: '' } });
    const tunneled = await runNode(['-e', script, path.join(KIT, 'dock-push.cjs')], { env: { ...env, DOCK_PROXY: proxy.url } });
    assert.equal(tunneled.code, 0, tunneled.stderr);
    assert.deepEqual(JSON.parse(tunneled.stdout), JSON.parse(direct.stdout));
    assert.deepEqual(JSON.parse(tunneled.stdout), { status: 200, ok: true, result: { message: null } });
    assert.deepEqual(proxy.targets, [`127.0.0.1:${new URL(dock.url).port}`]);
    assert.equal(dock.requests.length, 2);
    assert.deepEqual(normalize([dock.requests[1]]), normalize([dock.requests[0]]));
    assert.equal(dock.requests[1].headers.authorization, 'Bearer dock_ing_test');
  } finally { await proxy.close(); await dock.close(); rmrf(dir); }
});

test('send() with DOCK not configured is a silent skip', async () => {
  const dir = tmp('push-unset');
  try {
    const r = await runNode(['-e', "require(process.argv[1]).send('/x', {}, 1000).then((v) => console.log(JSON.stringify(v)))", path.join(KIT, 'dock-push.cjs')], { env: { ...sandboxEnv(dir), DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '' } });
    assert.deepEqual(JSON.parse(r.stdout), { skipped: true });
  } finally { rmrf(dir); }
});

// The same recorded-shape input through the source file and the new one, DOCK pointed at a local fake.
async function viaFake(kitDir, file, args, input, expected) {
  const dir = tmp('parity');
  const dock = await startServer();
  try {
    const r = await runNode([path.join(kitDir, file), ...args], {
      input,
      env: { ...sandboxEnv(dir), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', DOCK_TICKET: 'ZED-101' },
    });
    await waitFor(() => dock.requests.length >= expected, 10000);
    await new Promise((res) => setTimeout(res, 400));
    return { stdout: r.stdout, requests: normalize(dock.requests) };
  } finally { await dock.close(); rmrf(dir); }
}

const HOOK_INPUTS = [
  { hook_event_name: 'UserPromptSubmit', session_id: 'sess-aaaa-1111', cwd: 'E:/qonflo/wt-101-be', prompt: 'do it' },
  { hook_event_name: 'PreToolUse', session_id: 'sess-aaaa-1111', cwd: 'E:/qonflo/wt-101-be', tool_name: 'Bash', tool_input: { command: 'ls' } },
  { hook_event_name: 'PreToolUse', session_id: 'sess-aaaa-1111', cwd: 'E:/qonflo/wt-101-be', tool_name: 'Task', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'executor', description: 'ZED-101 worker' } },
  { hook_event_name: 'Notification', session_id: 'sess-aaaa-1111', cwd: 'E:/qonflo/wt-101-be', message: 'needs your permission', notification_type: 'permission_prompt' },
  { hook_event_name: 'Stop', session_id: 'sess-aaaa-1111', cwd: 'E:/qonflo/wt-101-be' },
];

for (const [i, input] of HOOK_INPUTS.entries()) {
  test(`dock-push hook (${input.hook_event_name} #${i}): source and new file send identical requests`, { skip: !hasSource }, async () => {
    const a = await viaFake(SOURCE_KIT, 'dock-push.cjs', ['hook'], JSON.stringify(input), 1);
    const b = await viaFake(KIT, 'dock-push.cjs', ['hook'], JSON.stringify(input), 1);
    assert.ok(a.requests.length >= 1, 'the source file sent something');
    assert.deepEqual(b.requests, a.requests);
  });
}

const STATUSLINE = {
  session_id: 'sess-bbbb-2222', model: { display_name: 'Opus 4.5' }, effort: { level: 'high' }, fast_mode: false,
  context_window: { used_percentage: 42, total_input_tokens: 84000, context_window_size: 200000 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1790000000 }, seven_day: { used_percentage: 55, resets_at: 1790500000 } },
  cost: { total_cost_usd: 1.234, total_duration_ms: 3725000, total_lines_added: 10, total_lines_removed: 2 },
  prompt_cache: { warm: true, hit_ratio: 0.9 },
};

test('statusline: same line on screen and the same /chat/status request, with no theme file present', { skip: !hasSource }, async () => {
  const a = await viaFake(SOURCE_KIT, 'statusline.cjs', [], JSON.stringify(STATUSLINE), 1);
  const b = await viaFake(KIT, 'statusline.cjs', [], JSON.stringify(STATUSLINE), 1);
  assert.ok(a.stdout.trim().length > 0 && a.stdout.includes('Opus 4.5'));
  assert.equal(b.stdout, a.stdout);
  assert.equal(a.requests.length, 1);
  assert.deepEqual(b.requests, a.requests);
  assert.match(b.requests[0], /"url":"\/ingest\/orchestrator\/chat\/status"/);
});

test('statusline: prints a line with no theme file and with unusable input', async () => {
  const dir = tmp('statusline');
  try {
    const off = { DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '' };
    const ok = await runNode([path.join(KIT, 'statusline.cjs')], { input: JSON.stringify(STATUSLINE), env: { ...sandboxEnv(dir), ...off } });
    assert.ok(ok.stdout.includes('Opus 4.5'));
    const bad = await runNode([path.join(KIT, 'statusline.cjs')], { input: 'not json', env: { ...sandboxEnv(dir), ...off } });
    assert.equal(bad.stdout, '\n');
  } finally { rmrf(dir); }
});

function startBinaryServer(payload, extraHeaders = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length, ...extraHeaders });
      res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

const BINARY_SCRIPT = "require(process.argv[1]).sendBinary('/chat/attachment', { id: 'a1' }, 5000, Number(process.argv[2] || 0) || undefined).then((r) => console.log(JSON.stringify({ status: r.status, hex: r.buffer.toString('hex'), type: r.headers['content-type'], sha: r.headers['x-dock-sha256'] }))).catch((e) => console.log(JSON.stringify({ error: e.message })))";

test('sendBinary() returns the raw bytes and headers, direct and through DOCK_PROXY', async () => {
  const dir = tmp('push-binary');
  const bytes = Buffer.from([0, 255, 1, 254, 128, 10, 13, 0]);
  const dock = await startBinaryServer(bytes, { 'x-dock-sha256': 'abc' });
  const proxy = await startProxy();
  try {
    const env = { ...sandboxEnv(dir), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' };
    const direct = await runNode(['-e', BINARY_SCRIPT, path.join(KIT, 'dock-push.cjs')], { env: { ...env, DOCK_PROXY: '' } });
    const tunneled = await runNode(['-e', BINARY_SCRIPT, path.join(KIT, 'dock-push.cjs')], { env: { ...env, DOCK_PROXY: proxy.url } });
    for (const r of [direct, tunneled]) {
      assert.deepEqual(JSON.parse(r.stdout), { status: 200, hex: bytes.toString('hex'), type: 'application/octet-stream', sha: 'abc' });
    }
    assert.deepEqual(proxy.targets, [`127.0.0.1:${new URL(dock.url).port}`]);
    assert.equal(dock.requests.length, 2);
    for (const q of dock.requests) {
      assert.equal(q.method, 'POST');
      assert.equal(q.url, '/ingest/orchestrator/chat/attachment');
      assert.equal(q.headers.authorization, 'Bearer dock_ing_test');
      assert.deepEqual(JSON.parse(q.body), { id: 'a1' });
    }
  } finally { await proxy.close(); await dock.close(); rmrf(dir); }
});

test('sendBinary() stops reading past maxBytes, direct and through DOCK_PROXY', async () => {
  const dir = tmp('push-binary-cap');
  const dock = await startBinaryServer(Buffer.alloc(5000, 7));
  const proxy = await startProxy();
  try {
    const env = { ...sandboxEnv(dir), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' };
    for (const via of ['', proxy.url]) {
      const r = await runNode(['-e', BINARY_SCRIPT, path.join(KIT, 'dock-push.cjs'), '1000'], { env: { ...env, DOCK_PROXY: via } });
      assert.match(JSON.parse(r.stdout).error, /too large/);
      const ok = await runNode(['-e', BINARY_SCRIPT, path.join(KIT, 'dock-push.cjs'), '5000'], { env: { ...env, DOCK_PROXY: via } });
      assert.equal(JSON.parse(ok.stdout).status, 200);
    }
  } finally { await proxy.close(); await dock.close(); rmrf(dir); }
});

test('sendBinary() with DOCK not configured is a silent skip', async () => {
  const dir = tmp('push-binary-unset');
  try {
    const r = await runNode(['-e', "require(process.argv[1]).sendBinary('/x', {}, 1000).then((v) => console.log(JSON.stringify(v)))", path.join(KIT, 'dock-push.cjs')], { env: { ...sandboxEnv(dir), DOCK_INGEST_URL: '', DOCK_INGEST_TOKEN: '' } });
    assert.deepEqual(JSON.parse(r.stdout), { skipped: true });
  } finally { rmrf(dir); }
});
