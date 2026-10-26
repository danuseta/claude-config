'use strict';
// kit/discord-files.cjs: thread id parsing, DOCK credentials lookup, and safe file names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { threadIdOf, dockConfig, safeName } = require('../discord-files.cjs');
const { tmp, rmrf } = require('./helpers.cjs');

test('threadIdOf: a bare id or the thread id of a discord.com link; anything else is null', () => {
  assert.equal(threadIdOf('1564141300721393694'), '1564141300721393694');
  assert.equal(threadIdOf('https://discord.com/channels/1100000000000000000/1564141300721393694'), '1564141300721393694');
  assert.equal(threadIdOf('https://discordapp.com/channels/1100000000000000000/1564141300721393694/1564141300721399999'), '1564141300721393694');
  assert.equal(threadIdOf('../etc'), null);
  assert.equal(threadIdOf(''), null);
});

test('dockConfig: the environment first, then the Linux secrets file; none means null', (t) => {
  if (process.platform === 'win32') return t.skip('the secrets file is read on Linux only');
  const home = tmp('discord-files-home');
  try {
    assert.equal(dockConfig({}, home), null);
    fs.mkdirSync(path.join(home, '.config', 'claude-config'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-config', 'secrets.env'), 'DOCK_INGEST_URL="http://127.0.0.1:4100/ingest/orchestrator/"\nDOCK_INGEST_TOKEN=abc\n');
    assert.deepEqual(dockConfig({}, home), { url: 'http://127.0.0.1:4100/ingest/orchestrator', token: 'abc' });
    assert.deepEqual(dockConfig({ DOCK_INGEST_URL: 'http://x/ingest/orchestrator', DOCK_INGEST_TOKEN: 'env' }, home), { url: 'http://x/ingest/orchestrator', token: 'env' });
  } finally { rmrf(home); }
});

test('safeName: no folder parts, odd characters replaced, a repeated name numbered', () => {
  const taken = new Set();
  assert.equal(safeName('../../evil.sh', taken), 'evil.sh');
  assert.equal(safeName('bukti uji (1).pdf', taken), 'bukti uji (1).pdf');
  assert.equal(safeName('bukti uji (1).pdf', taken), 'bukti uji (1)-2.pdf');
  assert.equal(safeName('a:b?.png', taken), 'a_b_.png');
});

test('main: asks DOCK for the thread with the ingest token, prints the messages and saves each file', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const out = tmp('discord-files-out');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers.authorization, body]);
      if (req.url === '/ingest/orchestrator/discord-thread') {
        const url = `http://127.0.0.1:${server.address().port}/files/evidence.pdf`;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: true, result: { threadId: '1564141300721393694', messages: [{ at: '2026-10-26T08:00:00Z', author: 'aken', text: 'evidence', files: [{ name: 'evidence.pdf', size: 8, type: 'application/pdf', url }] }] } }));
      }
      res.end('%PDF-1.4');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env, DOCK_INGEST_URL: `http://127.0.0.1:${server.address().port}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'tok' };
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(__dirname, '..', 'discord-files.cjs'), '1564141300721393694', out], { env });
      let stdout = '';
      p.stdout.on('data', (c) => { stdout += c; });
      p.on('close', (code) => resolve({ code, stdout }));
    });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /aken: evidence/);
    assert.equal(fs.readFileSync(path.join(out, 'evidence.pdf'), 'utf8'), '%PDF-1.4');
    assert.deepEqual(seen[0].slice(0, 4), ['POST', '/ingest/orchestrator/discord-thread', 'Bearer tok', '{"threadId":"1564141300721393694"}']);
  } finally {
    server.close();
    rmrf(out);
  }
});
