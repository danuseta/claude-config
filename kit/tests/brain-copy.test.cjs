'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SOURCE_COMMIT = '701f6a2';
const RECORDED_SHA256 = '31cb56f7d2a962e0081546d80fe0bcf7596b35aaab0718da5f37ef15799c1c99';
const COPY = path.join(__dirname, '..', 'brain.py');
const VAULT_SOURCE = 'E:/obsidian/Brain/scripts/brain.py';
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test(`kit/brain.py matches the hash recorded from danuseta/brain ${SOURCE_COMMIT}`, () => {
  assert.equal(sha256(COPY), RECORDED_SHA256, 'kit/brain.py drifted; refresh it as docs/architecture.md describes');
});

test('kit/brain.py --help exits 0 and lists the remote mode', () => {
  const r = spawnSync(PYTHON, [COPY, '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  assert.match(r.stdout, /remote/);
});

test('kit/brain.py is byte-identical to the vault copy when the vault is on this machine', (t) => {
  if (!fs.existsSync(VAULT_SOURCE)) return t.skip(`${VAULT_SOURCE} not present`);
  assert.equal(sha256(COPY), sha256(VAULT_SOURCE), `kit/brain.py differs from ${VAULT_SOURCE}`);
});
