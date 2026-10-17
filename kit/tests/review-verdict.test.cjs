'use strict';
// status.cjs finding --severity, lgtm and verdict on a scratch evidence folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, runNode, sandboxEnv } = require('./helpers.cjs');

test('a review records severities, lgtm parts and a verdict that approve cannot give over a blocker', async () => {
  const base = tmp('review-verdict');
  const evidence = path.join(base, 'evidence');
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const status = (...args) => runNode([path.join(KIT, 'status.cjs'), ...args], { env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence } });
  const ledger = () => JSON.parse(fs.readFileSync(path.join(evidence, 'ZED-201', 'status.json'), 'utf8'));
  try {
    await status('init', 'ZED-201', 'Invented review', '-', '-', '-', '-');
    let r = await status('finding', 'ZED-201', 'loose', 'text');
    assert.match(r.stdout, /finding #1 \(non-blocking\)/);
    r = await status('finding', 'ZED-201', '--severity', 'blocker', 'drops', 'the', 'retry');
    assert.match(r.stdout, /finding #2 \(blocker\)/);
    r = await status('finding', 'ZED-201', '--severity', 'major', 'x');
    assert.match(r.stdout, /REFUSED: --severity must be one of/);
    assert.equal(r.code, 2);
    await status('lgtm', 'ZED-201', 'the migration');

    r = await status('verdict', 'ZED-201', 'approve');
    assert.match(r.stdout, /REFUSED: ZED-201 has 1 blocker finding/);
    r = await status('verdict', 'ZED-201', 'request-change');
    assert.match(r.stdout, /verdict: request-change/);

    const s = ledger();
    assert.deepEqual(s.findings.map((f) => [f.severity, f.text]), [['non-blocking', 'loose text'], ['blocker', 'drops the retry']]);
    assert.deepEqual(s.lgtm.map((l) => l.text), ['the migration']);
    assert.equal(s.verdict.value, 'request-change');
  } finally {
    rmrf(base);
  }
});
