'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { KIT, tmp, rmrf } = require('./helpers.cjs');

const SCRIPT = path.join(KIT, 'account-usage.py');
const hasPython = (py) => new Promise((r) => execFile(py, ['--version'], (e) => r(!e)));
const findPython = async () => ((await hasPython('python3')) ? 'python3' : (await hasPython('python')) ? 'python' : null);

const FAKE_CYCLE = `VAR = 'CLAUDE_CODE_OAUTH_TOKEN'
def names():
    return ['claude2', 'IT', 'claude4']
def secret_get(name):
    return {'claude2': 'tok-two-secret', 'IT': 'tok-it-secret'}.get(name)
`;
const RESET = 1793700000;
const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const P = 'anthropic-ratelimit-unified-';

// A local API that answers by bearer token and records the requests; it can set response headers, which the shared helper cannot.
function startApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const auth = req.headers.authorization;
      let status = 200;
      let h = {};
      if (auth === 'Bearer tok-one-secret') h = { status: 'allowed', '5h-utilization': '0.25', '5h-reset': String(RESET), '7d-utilization': '0.5', '7d-reset': String(RESET + 3600) };
      else if (auth === 'Bearer tok-two-secret') h = { status: 'allowed', '7d-utilization': '0.1', '7d-reset': String(RESET) };
      else { status = 429; h = { status: 'rejected', '5h-utilization': '1', '5h-reset': String(RESET), '7d-utilization': '0.99', '7d-reset': String(RESET) }; }
      const headers = { 'content-type': 'application/json' };
      for (const [k, v] of Object.entries(h)) headers[P + k] = v;
      res.writeHead(status, headers);
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

function run(py, dir, api, extra = []) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, ACCOUNT_USAGE_API: api, CLAUDE_CODE_OAUTH_TOKEN: 'tok-one-secret' };
  return new Promise((resolve) => execFile(py, [SCRIPT, ...extra], { env, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
  }));
}

test('account-usage.py reports 5h and 7d, a 7d-only account, a 429 rejection and a missing token without leaking a token', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('no python');
  const dir = tmp('acctusage');
  fs.mkdirSync(path.join(dir, 'account-cycle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'account-cycle', 'cycle.py'), FAKE_CYCLE);
  const srv = await startApi();
  try {
    const r = await run(py, dir, srv.url);
    assert.equal(r.code, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    const by = Object.fromEntries(rows.map((x) => [x.name, x]));
    assert.deepEqual(rows.map((x) => x.name), ['claude1', 'claude2', 'IT', 'claude4']);
    assert.equal(by.claude1.status, 'allowed');
    assert.deepEqual(by.claude1.fiveHour, { usedPercentage: 25, resetsAt: iso(RESET) });
    assert.deepEqual(by.claude1.sevenDay, { usedPercentage: 50, resetsAt: iso(RESET + 3600) });
    assert.equal(by.claude2.fiveHour, null);
    assert.equal(by.claude2.sevenDay.usedPercentage, 10);
    assert.equal(by.IT.status, 'rejected');
    assert.equal(by.IT.fiveHour.usedPercentage, 100);
    assert.equal(by.IT.sevenDay.usedPercentage, 99);
    assert.equal(by.claude4.status, 'no-token');
    const fp = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
    assert.equal(by.claude1.fp, fp('tok-one-secret'));
    assert.equal(by.claude2.fp, fp('tok-two-secret'));
    assert.match(by.IT.fp, /^[0-9a-f]{12}$/);
    assert.equal(by.claude4.fp, undefined);
    assert.equal(srv.requests.length, 3);
    assert.equal(srv.requests[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(srv.requests[0].body.max_tokens, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /tok-(one|two|it)-secret/);
    const only = await run(py, dir, srv.url, ['--names', 'claude2,IT']);
    assert.deepEqual(JSON.parse(only.stdout).map((x) => x.name), ['claude2', 'IT']);
  } finally {
    await srv.close();
    rmrf(dir);
  }
});

test('account-usage.py exits 2 when cycle.py is missing', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('no python');
  const dir = tmp('acctusage-none');
  try {
    const r = await run(py, dir, 'http://127.0.0.1:9');
    assert.equal(r.code, 2);
    assert.deepEqual(JSON.parse(r.stdout), { error: 'cycle.py not found' });
  } finally {
    rmrf(dir);
  }
});
