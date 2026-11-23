'use strict';
// dock-chat.cjs: a message's optional `account` runs the turn on that account-cycle token without switching the machine's active
// account, a missing token file refuses the turn, no account changes nothing; a Judge prompt marks the turn DOCK_JUDGE=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chat = require('../dock-chat.cjs');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

const fp = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const FAKE_JUDGE = 'fake-judge-v1';
const FAKE_BASE = 'fake-base-v1';

test('turnAccount: no account is today\'s turn, a name reads tokens/<name>.token, a bad name or a missing file is an error', () => {
  const dir = tmp('acct-unit');
  try {
    fs.mkdirSync(path.join(dir, 'tokens'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tokens', 'claude4.token'), `${FAKE_JUDGE}\n`);
    assert.deepEqual(chat.turnAccount({ text: 'hello' }, {}, dir), { token: null, judge: false });
    assert.deepEqual(chat.turnAccount({ text: 'hello', account: '' }, {}, dir), { token: null, judge: false });
    assert.deepEqual(chat.turnAccount({ text: 'Pakai skill judge: session s1 input /x until -', account: 'claude4' }, {}, dir), { token: FAKE_JUDGE, judge: true });
    assert.equal(chat.turnAccount({ text: 'lanjut', title: 'Judge-a3c23286' }, {}, dir).judge, true);
    assert.match(chat.turnAccount({ text: 'x', account: '../tokens/claude4' }, {}, dir).error, /not an account-cycle name/);
    assert.match(chat.turnAccount({ text: 'x', account: 'claude9' }, {}, dir).error, /claude9 has no token file.*not started on another account/);
  } finally {
    rmrf(dir);
  }
});

test('childEnv: an account token replaces CLAUDE_CODE_OAUTH_TOKEN and drops the keys that outrank it; judge sets DOCK_JUDGE', () => {
  const base = { PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: FAKE_BASE, ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', DOCK_JUDGE: '1' };
  const plain = chat.childEnv({ configDir: null }, base);
  assert.equal(plain.CLAUDE_CODE_OAUTH_TOKEN, FAKE_BASE);
  assert.equal(plain.ANTHROPIC_API_KEY, 'k');
  assert.ok(!('DOCK_JUDGE' in plain), 'a turn that is not a Judge turn never inherits the flag');
  const judged = chat.childEnv({ configDir: null, accountToken: FAKE_JUDGE, judge: true }, base);
  assert.equal(judged.CLAUDE_CODE_OAUTH_TOKEN, FAKE_JUDGE);
  assert.ok(!('ANTHROPIC_API_KEY' in judged) && !('ANTHROPIC_AUTH_TOKEN' in judged));
  assert.equal(judged.DOCK_JUDGE, '1');
});

async function turn(dir, message, extraEnv = {}) {
  let claimed = false;
  const dock = await startServer((req) => {
    if (req.url.endsWith('/chat/claim')) {
      if (claimed) return { json: { ok: true, result: { message: null } } };
      claimed = true;
      return { json: { ok: true, result: { message: { id: 7, sessionId: 'dock-j1', claudeSessionId: null, ...message } } } };
    }
    return null;
  });
  try {
    const r = await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], {
      env: { ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test', ...extraEnv },
    });
    assert.equal(r.code, 0, r.stderr);
    const deltas = dock.requests.filter((q) => q.url.endsWith('/chat/delta'));
    const text = deltas.flatMap((d) => d.body.items || []).map((i) => i.text).join('\n');
    const at = text.indexOf('FACTS ');
    return { deltas, text, facts: at < 0 ? null : JSON.parse(text.slice(at + 6).split('\n')[0]) };
  } finally {
    await dock.close();
  }
}

function machine(label, conf = {}) {
  const dir = tmp(label);
  const cfgDir = path.join(dir, 'claude-cfg');
  const cycle = path.join(cfgDir, 'account-cycle');
  fs.mkdirSync(path.join(cycle, 'tokens'), { recursive: true });
  fs.writeFileSync(path.join(cycle, 'tokens', 'claude4.token'), `${FAKE_JUDGE}\n`);
  fs.writeFileSync(path.join(cycle, 'accounts.txt'), 'claude2\nclaude4\n');
  fs.writeFileSync(path.join(cycle, 'state'), 'claude2\n');
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ env: { BRAIN_MODE: 'remote' } }));
  fs.writeFileSync(path.join(dir, 'fake-claude.cjs'), `
const env = process.env;
if (process.argv.includes('-p')) require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'ran'))}, 'yes');
const fp = (s) => s ? require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 12) : null;
const at = process.argv.indexOf('--settings');
let settings = null;
if (at > 0) {
  const file = process.argv[at + 1];
  require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'settings-path'))}, file);
  const body = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  settings = { mode: require('fs').statSync(file).mode & 0o777, keys: Object.keys(body).concat(Object.keys(body.env || {})), acct: fp(body.env && body.env.CLAUDE_CODE_OAUTH_TOKEN) };
}
const facts = { acct: fp(env.CLAUDE_CODE_OAUTH_TOKEN), keyed: ('ANTHROPIC_API_KEY' in env), judge: env.DOCK_JUDGE || null, settings };
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
console.log(JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'FACTS ' + JSON.stringify(facts) }] } }));
if (env.FAKE_MODE === 'hang') setTimeout(() => {}, 60000);
else if (env.FAKE_MODE === 'fail') process.exit(3);
else console.log(JSON.stringify({ type: 'result', session_id: 'sess-1', is_error: false }));
`);
  fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'fake-claude.cjs'), cwd: dir, configDir: cfgDir, turnTimeoutMs: 20000, retryBaseMs: 50, ...conf }));
  const snapshot = () => ['account-cycle/state', 'account-cycle/accounts.txt', 'account-cycle/tokens/claude4.token', 'settings.json'].map((f) => fs.readFileSync(path.join(cfgDir, f), 'utf8')).join('|');
  const leftovers = () => fs.readdirSync(dir).filter((n) => n.startsWith('dock-judge-'));
  return { dir, snapshot, leftovers };
}
const POSIX = process.platform !== 'win32';

test('a Judge turn with account claude4 runs on that token, through env and a private --settings file that is gone afterwards', async () => {
  const { dir, snapshot, leftovers } = machine('acct-judge');
  try {
    const before = snapshot();
    const { facts } = await turn(dir, { text: 'Pakai skill judge: session a3c23286 input /tmp/in.md until -', account: 'claude4' }, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_BASE, ANTHROPIC_API_KEY: 'k' });
    const { settings, ...rest } = facts;
    assert.deepEqual(rest, { acct: fp(FAKE_JUDGE), keyed: false, judge: '1' });
    assert.deepEqual([settings.keys, settings.acct], [['env', 'CLAUDE_CODE_OAUTH_TOKEN'], fp(FAKE_JUDGE)], 'the file holds only the token');
    if (POSIX) assert.equal(settings.mode, 0o600);
    const file = fs.readFileSync(path.join(dir, 'settings-path'), 'utf8');
    assert.ok(path.basename(path.dirname(file)).startsWith('dock-judge-'), 'its own mkdtemp folder');
    assert.ok(!fs.existsSync(file) && !fs.existsSync(path.dirname(file)), 'file and folder are removed after the turn');
    assert.deepEqual(leftovers(), []);
    assert.equal(snapshot(), before, 'account-cycle state, accounts and settings.json are untouched');
  } finally {
    rmrf(dir);
  }
});

test('an account without a token file refuses the turn with a clear error and never starts claude on the work account', async () => {
  const { dir } = machine('acct-missing');
  try {
    const { deltas, facts } = await turn(dir, { text: 'Pakai skill judge: session s2 input /tmp/in.md until -', account: 'claude9' }, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_BASE });
    assert.equal(facts, null);
    assert.ok(!fs.existsSync(path.join(dir, 'ran')), 'claude was not started');
    assert.match(deltas.at(-1).body.error, /account claude9 has no token file on this machine: Judge needs .*claude9\.token \(a keyring or a \.dpapi file is not supported\)/);
  } finally {
    rmrf(dir);
  }
});

test('no account: the turn keeps the machine\'s token and is not a Judge turn', async () => {
  const { dir } = machine('acct-none');
  try {
    const { facts } = await turn(dir, { text: 'hello' }, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_BASE, ANTHROPIC_API_KEY: 'k' });
    assert.deepEqual(facts, { acct: fp(FAKE_BASE), keyed: true, judge: null, settings: null }, 'no --settings without an account');
  } finally {
    rmrf(dir);
  }
});

for (const [name, conf, env, want] of [
  ['claude fails', {}, { FAKE_MODE: 'fail' }, /exited with code 3/],
  ['the turn is killed on its timeout', { turnTimeoutMs: 2000 }, { FAKE_MODE: 'hang' }, /ran longer than 2 seconds and was stopped/],
  ['claude cannot be started', { claudeBin: 'no-such-claude-binary' }, {}, /not found on this machine/],
]) {
  test(`the --settings file is removed when ${name}, and the active account stays as it was`, async () => {
    const { dir, snapshot, leftovers } = machine('acct-end', conf);
    try {
      const before = snapshot();
      const { deltas } = await turn(dir, { text: 'Pakai skill judge: session s3 input /tmp/in.md until -', account: 'claude4' }, { CLAUDE_CODE_OAUTH_TOKEN: FAKE_BASE, ...env });
      assert.match(String(deltas.at(-1).body.error), want);
      if (fs.existsSync(path.join(dir, 'settings-path'))) assert.ok(!fs.existsSync(fs.readFileSync(path.join(dir, 'settings-path'), 'utf8')));
      assert.deepEqual(leftovers(), []);
      assert.equal(snapshot(), before);
    } finally {
      rmrf(dir);
    }
  });
}
