'use strict';
// demo-upload.cjs sends the MP4 to DOCK with the machine token and prints the link DOCK answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

test('the demo video goes to DOCK as video/mp4 for its ticket, and a refusal is reported', async () => {
  const base = tmp('demo-upload');
  const seen = [];
  const dock = await startServer((req) => {
    seen.push({ url: req.url, type: req.headers['content-type'], length: Number(req.headers['content-length']) });
    if (req.url.includes('key=BAD')) return { status: 400, json: { error: 'A valid ticket key is required' } };
    return { json: { ok: true, result: { ticketKey: 'QRD-1363', url: 'https://kencana.basic.box.cloudeka.id/porto-rzwbgw/demo-qonflo/QRD-1363.mp4' } } };
  });
  const machine = 'workspace';
  const env = { ...sandboxEnv(path.join(base, 'sandbox')), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: `dock_ing_${machine}` };
  try {
    fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
    const file = path.join(base, 'demo.mp4');
    fs.writeFileSync(file, Buffer.alloc(2048, 1));

    let r = await runNode([path.join(KIT, 'demo-upload.cjs'), 'QRD-1363', file], { env });
    assert.equal(r.stdout.trim(), 'https://kencana.basic.box.cloudeka.id/porto-rzwbgw/demo-qonflo/QRD-1363.mp4');
    assert.deepEqual(seen[0], { url: '/ingest/orchestrator/demo-video?key=QRD-1363', type: 'video/mp4', length: 2048 });

    r = await runNode([path.join(KIT, 'demo-upload.cjs'), 'BAD', file], { env });
    assert.match(r.stderr, /DOCK refused the demo video: 400 A valid ticket key is required/);
    assert.equal(r.code, 1);
    r = await runNode([path.join(KIT, 'demo-upload.cjs'), 'QRD-1', path.join(base, 'missing.mp4')], { env });
    assert.match(r.stderr, /no such file/);
  } finally {
    await dock.close();
    rmrf(base);
  }
});
