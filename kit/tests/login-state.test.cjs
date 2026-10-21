'use strict';
// kit/login-state.cjs: finds the FE repo's playwright and starts the right browser on each system.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { playwrightDir, launchOptions } = require('../login-state.cjs');
const { tmp, rmrf } = require('./helpers.cjs');

test('playwrightDir: the newest playwright the FE repo pins under node_modules/.pnpm, or null', () => {
  const fe = tmp('login-state-fe');
  try {
    assert.equal(playwrightDir(fe), null, 'no node_modules');
    for (const v of ['1.55.0', '1.56.1']) {
      const dir = path.join(fe, 'node_modules', '.pnpm', `playwright@${v}`, 'node_modules', 'playwright');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    }
    fs.mkdirSync(path.join(fe, 'node_modules', '.pnpm', 'playwright-core@1.57.0'), { recursive: true });
    assert.equal(playwrightDir(fe), path.join(fe, 'node_modules', '.pnpm', 'playwright@1.56.1', 'node_modules', 'playwright'));
  } finally { rmrf(fe); }
});

test('launchOptions: installed Chrome on Windows, the system chromium on Linux when it exists', () => {
  assert.deepEqual(launchOptions('win32', {}), { channel: 'chrome' });
  const bin = path.join(tmp('login-state-bin'), 'chromium');
  try {
    fs.writeFileSync(bin, '');
    assert.deepEqual(launchOptions('linux', { PLAYWRIGHT_CHROMIUM: bin }), { executablePath: bin });
    assert.deepEqual(launchOptions('linux', { PLAYWRIGHT_CHROMIUM: `${bin}-missing` }), {}, 'playwright falls back to its own browser');
  } finally { rmrf(path.dirname(bin)); }
});
