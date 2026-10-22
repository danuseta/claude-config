'use strict';
// status.cjs handoff: an absolute evidence path counts as proof on Linux too, not only a Windows drive path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, runNode, sandboxEnv } = require('./helpers.cjs');

test('a handoff whose evidence is an absolute path without a drive letter is recorded with proof', async () => {
  const base = tmp('handoff-evidence');
  const evidence = path.join(base, 'evidence');
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const proof = path.join(base, 'review.md');
  fs.writeFileSync(proof, 'review notes\n');
  // /home/coder/... on Linux; the same file without its drive letter on Windows.
  const posixProof = proof.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  const status = (...args) => runNode([path.join(KIT, 'status.cjs'), ...args], { env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence } });
  try {
    await status('init', 'ZED-301', 'Invented review', '-', '-', '-', '-');
    let r = await status('handoff', 'ZED-301', 'runner', 'status=done', 'summary=reviewed', 'unverified=none', `evidence=${posixProof}`);
    assert.match(r.stdout, /recorded with proof/);
    r = await status('handoff', 'ZED-301', 'runner', 'status=done', 'summary=reviewed', 'unverified=none', `evidence=${posixProof}.missing.md`);
    assert.match(r.stdout, /UNPROVEN \(evidence path not found/);
  } finally {
    rmrf(base);
  }
});
