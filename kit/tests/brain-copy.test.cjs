'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SOURCE_COMMIT = 'c1998e6';
const RECORDED_SHA256 = '58a5f6bd52f566b0cc4095bdeaed8c0461a2dcefa3dbef61c42edfa86d4c5f3d';
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

test('kit/brain.py is byte-identical to scripts/brain.py at the recorded vault commit', (t) => {
  const vault = path.dirname(path.dirname(VAULT_SOURCE));
  if (!fs.existsSync(vault)) return t.skip(`${vault} not present`);
  const r = spawnSync('git', ['-C', vault, 'show', `${SOURCE_COMMIT}:scripts/brain.py`], { encoding: 'buffer', timeout: 30000 });
  if (r.status !== 0) return t.skip(`commit ${SOURCE_COMMIT} not in ${vault}; run git fetch there`);
  assert.equal(sha256(COPY), crypto.createHash('sha256').update(r.stdout).digest('hex'), `kit/brain.py differs from ${SOURCE_COMMIT}:scripts/brain.py`);
});
