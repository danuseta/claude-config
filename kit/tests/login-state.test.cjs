'use strict';
// kit/login-state.cjs: finds the FE repo's playwright and starts the right browser on each system.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { playwrightDir, launchOptions, isLocalMongo, ensureSubscription, SEED_SCRIPT } = require('../login-state.cjs');
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

test('isLocalMongo: only mongodb:// strings whose every host is this machine', () => {
  assert.equal(isLocalMongo('mongodb://127.0.0.1:27017'), true);
  assert.equal(isLocalMongo('mongodb://user:pw@localhost:27017/qonflo?authSource=admin'), true);
  assert.equal(isLocalMongo('mongodb://127.0.0.1:27017,localhost:27018'), true);
  assert.equal(isLocalMongo('mongodb://127.0.0.1:27017,db.example.com:27017'), false, 'one remote host is enough to refuse');
  assert.equal(isLocalMongo('mongodb+srv://user:pw@cluster0.example.net/qonflo'), false);
  assert.equal(isLocalMongo('mongodb://localhost.example.com:27017'), false);
  assert.equal(isLocalMongo(''), false);
});

test('ensureSubscription: seeds through mongosh only for a local MongoDB from the BE .env, and never throws', () => {
  const be = tmp('login-state-be');
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'seeded\n', stderr: '' }; };
  try {
    assert.match(ensureSubscription(be, 'local@test.com', run), /skipped, no MONGO_CONN_STRING/);
    fs.writeFileSync(path.join(be, '.env'), 'MONGO_CONN_STRING="mongodb+srv://u:p@prod.example.net"\nMONGO_CONN_DBNAME=qonflo\n');
    assert.match(ensureSubscription(be, 'local@test.com', run), /skipped, MongoDB is not on this machine/);
    assert.equal(calls.length, 0, 'a remote database is never touched');
    fs.writeFileSync(path.join(be, '.env'), 'MONGO_CONN_STRING=mongodb://127.0.0.1:27017\nMONGO_CONN_DBNAME=qonflo\n');
    assert.equal(ensureSubscription(be, 'local@test.com', run), 'subscription: seeded');
    assert.equal(calls[0].cmd, 'mongosh');
    assert.deepEqual([calls[0].opts.env.SEED_DB, calls[0].opts.env.SEED_EMAIL], ['qonflo', 'local@test.com']);
    assert.match(ensureSubscription(be, 'x@y', () => ({ error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) })), /mongosh not found/);
    assert.match(ensureSubscription(be, 'x@y', () => ({ status: 1, stdout: '', stderr: 'boom\nMongoServerError: auth' })), /failed, MongoServerError: auth/);
  } finally { rmrf(be); }
});

test('the seed adds a zero-amount ACTIVE row only when the group has no ACTIVE or PAST_DUE subscription', () => {
  assert.match(SEED_SCRIPT, /status: \{ \$in: \["ACTIVE", "PAST_DUE"\] \}/);
  assert.match(SEED_SCRIPT, /referenceId: "LOCAL-TEST-SEED"/);
  assert.match(SEED_SCRIPT, /amount: 0/);
  assert.match(SEED_SCRIPT, /upsert: true/);
});
