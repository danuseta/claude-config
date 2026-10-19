'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chat = require('../dock-chat.cjs');
const { KIT, tmp, rmrf, startServer, runNode, sandboxEnv } = require('./helpers.cjs');

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

function repo(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('touchedPath: Edit, Write, MultiEdit and NotebookEdit give an absolute path, other tools none', () => {
  const cwd = path.resolve('/work');
  assert.equal(chat.touchedPath({ name: 'Edit', input: { file_path: 'src/a.ts' } }, cwd), path.resolve(cwd, 'src/a.ts'));
  assert.equal(chat.touchedPath({ name: 'Write', input: { file_path: path.resolve('/abs/x.ts') } }, cwd), path.resolve('/abs/x.ts'));
  assert.equal(chat.touchedPath({ name: 'MultiEdit', input: { file_path: 'm.ts' } }, cwd), path.resolve(cwd, 'm.ts'));
  assert.equal(chat.touchedPath({ name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }, cwd), path.resolve(cwd, 'n.ipynb'));
  assert.equal(chat.touchedPath({ name: 'Bash', input: { command: 'ls' } }, cwd), null);
  assert.equal(chat.touchedPath({ name: 'Edit', input: {} }, cwd), null);
});

test('changedFiles: groups by repo, counts untracked lines, skips non-repo files', async () => {
  const root = tmp('changed-files');
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root).split(path.sep).join('/');
  try {
    const one = repo(root, 'wt-one'), two = repo(root, 'wt-two');
    fs.writeFileSync(path.join(one, 'src', 'a.ts'), 'one\nthree\nfour\n');
    fs.writeFileSync(path.join(one, 'src', 'new.ts'), 'p\nq\nr\n');
    fs.writeFileSync(path.join(two, 'src', 'b.ts'), '');
    const outside = path.join(root, 'loose.txt');
    fs.writeFileSync(outside, 'z\n');
    const files = await chat.changedFiles([path.join(one, 'src', 'a.ts'), path.join(one, 'src', 'new.ts'), path.join(two, 'src', 'b.ts'), outside]);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.deepEqual(by['wt-one/src/a.ts'], { path: 'wt-one/src/a.ts', added: 2, removed: 1 });
    assert.deepEqual(by['wt-one/src/new.ts'], { path: 'wt-one/src/new.ts', added: 3, removed: 0 });
    assert.deepEqual(by['wt-two/src/b.ts'], { path: 'wt-two/src/b.ts', added: 0, removed: 1 });
    assert.equal(files.length, 3);
    assert.deepEqual(await chat.changedFiles([]), []);
  } finally { delete process.env.GIT_CEILING_DIRECTORIES; rmrf(root); }
});

test('changedFiles: a touched file with no diff left (reverted or deleted) is sent with zeros', async () => {
  const root = tmp('changed-files');
  try {
    const one = repo(root, 'wt-one');
    fs.writeFileSync(path.join(one, 'src', 'b.ts'), 'edited\n');
    assert.deepEqual(await chat.changedFiles([path.join(one, 'src', 'a.ts'), path.join(one, 'src', 'gone.ts')]), [{ path: 'wt-one/src/a.ts', added: 0, removed: 0 }, { path: 'wt-one/src/gone.ts', added: 0, removed: 0 }]);
  } finally { rmrf(root); }
});

test('one-shot turn: the claimed agent setting reaches the claude environment', async () => {
  const dir = tmp('oneshot-agent');
  let dock;
  try {
    fs.writeFileSync(path.join(dir, 'env-claude.cjs'), `
const fs = require('fs'), path = require('path');
if (process.argv.includes('--help')) process.exit(0);
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'env.json'), JSON.stringify({ caveman: process.env.CAVEMAN_DEFAULT_MODE, rtk: process.env.DOCK_RTK || null }));
console.log(JSON.stringify({ type: 'result', session_id: 's-1', is_error: false }));
`);
    fs.writeFileSync(path.join(dir, 'dock-chat.json'), JSON.stringify({ claudeBin: path.join(dir, 'env-claude.cjs'), cwd: dir, turnTimeoutMs: 20000, retryBaseMs: 50, interactive: false, activity: false }));
    let sent = false;
    dock = await startServer((req) => {
      if (!req.url.endsWith('/chat/claim')) return null;
      const message = sent ? null : { id: 1, sessionId: 'dock-agent-1', text: 'hi', agent: { rtk: false, caveman: 'lite' } };
      sent = true;
      return { json: { ok: true, result: { message } } };
    });
    await runNode([path.join(KIT, 'dock-chat.cjs'), 'once', '--wait', '1'], { env: { ...sandboxEnv(dir), DOCK_CHAT_CONFIG: path.join(dir, 'dock-chat.json'), DOCK_INGEST_URL: `${dock.url}/ingest/orchestrator`, DOCK_INGEST_TOKEN: 'dock_ing_test' } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')), { caveman: 'lite', rtk: process.platform === 'win32' ? null : 'off' });
  } finally { if (dock) await dock.close(); rmrf(dir); }
});
