'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolvePaths } = require('../paths.cjs');
const { createGuard, answer } = require('../guard.cjs');
const { SOURCE_KIT, hasSource, tmp, rmrf } = require('./helpers.cjs');

const HOME = '/home/coder';
const REPO = '/home/coder/projects/ms-admin-worker-backend';
const linuxPaths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
const winPaths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:\\Users\\danus\\.claude-kantor\\kit', local: {} });
const linuxGuard = (turn) => createGuard({ platform: 'linux', paths: linuxPaths, env: turn ? { DOCK_CHAT_TURN: '1' } : {}, home: HOME });
const decide = (guard, command, cwd, env, softUntil = '2999-01-01') => {
  const out = answer(command, cwd, { guard, env, cfg: { softUntil }, log: false });
  if (!out) return null;
  const h = JSON.parse(out).hookSpecificOutput;
  return h.permissionDecision === 'deny' ? 'deny' : 'warn';
};

// One or more commands per row of the P.2 table of hard denies.
const HARD_DENY = {
  'force push': ['git push --force origin feat/x', 'git push -f origin feat/x', 'git push --force-with-lease origin feat/x', 'git push origin +feat/x', 'rtk git push -f origin feat/x'],
  'push to a protected branch': ['git push origin develop', 'git push origin development', 'git push origin main', 'git push origin master', 'git push origin HEAD:main', 'git push origin feat/x:develop', 'rtk git push origin main'],
  'branch delete': ['git push origin --delete feat/x', 'git push origin :feat/x', 'git branch -D feat/x', 'gh api -X DELETE repos/o/r/git/refs/heads/x', 'gh api --method DELETE repos/o/r/git/refs/heads/x'],
  'PR merge / close, repo and release delete': ['gh pr merge 12', 'gh pr close 12', 'gh repo delete o/r --yes', 'gh release delete v1', 'rtk gh pr merge 12 --squash'],
  'git add all': ['git add .', 'git add -A', 'git add --all', 'rtk git add .'],
  'discard local work in a main clone': ['git reset --hard', 'git reset --hard origin/develop', 'git clean -fd', 'git checkout -- .', 'git restore .'],
  'recursive delete of a protected target': ['rm -rf ~', 'rm -rf /', 'rm -rf ~/projects', 'rm -rf /home/coder/projects/ms-admin-worker-backend', 'rm -rf ~/.claude', 'rm -rf ~/claude-config', 'rm -rf ~/brain', 'rm -rf ~/.config', 'rm -rf $HOME', 'rm -rf /*', 'rm -rf ~/projects/*'],
  'database': ['mongosh --eval "db.dropDatabase()"', "mongosh mydb --eval 'db.users.deleteMany({})'", 'mongo --eval "db.x.remove({})"', 'mongorestore --drop dump/', 'redis-cli FLUSHALL', 'redis-cli flushdb', 'bash /home/coder/scripts/mongo-restore-seed.sh'],
  'machine control': ['sudo apt install x', 'coder ssh danu', 'tailscale status', 'ccfg doctor', 'bash ~/claude-config/linux/ccfg doctor', 'rtk sudo ls', 'cat ~/.config/claude-config/secrets.env', 'rg KEY ~/.config/claude-config'],
  'official ports': ['kill $(lsof -ti :3000)', 'npx kill-port 5174', 'kill -9 $(lsof -ti:1055)', 'pkill -f 13337', 'kill $(lsof -ti :27017)'],
};

const ALLOWED = [
  'git push origin feature/x', 'git push -u origin feature/x', 'rtk git push -u origin feat/ZED-101-x', 'gh pr create', 'rtk gh pr create --base develop --head feat/ZED-101-x',
  'gh pr view 3', 'gh pr list', 'rtk git status', 'git commit -m "x"', 'git add src/a.ts', 'git diff --cached --name-only', 'rg tailscale src', 'git branch -d merged', 'git clean -n',
  'rm -rf node_modules', 'rm -rf dist/', 'rm -rf ~/projects/ms-admin-worker-backend/node_modules', 'git restore --staged .', 'kill $(lsof -ti :3203)', 'ls ~/.config',
  'mongosh --eval "db.users.find()"', 'redis-cli GET a', 'git fetch origin', 'bash /home/coder/.claude/kit/status.cjs show ZED-101',
];

for (const [row, commands] of Object.entries(HARD_DENY)) {
  test(`DOCK_CHAT_TURN=1 denies: ${row}`, () => {
    const g = linuxGuard(true);
    for (const c of commands) assert.equal(decide(g, c, REPO, { DOCK_CHAT_TURN: '1' }), 'deny', c);
  });
}

test('DOCK_CHAT_TURN=1 denies a bare `git push` on a protected branch', () => {
  const dir = tmp('guard-branch');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    assert.equal(decide(linuxGuard(true), 'git push', dir, { DOCK_CHAT_TURN: '1' }), 'deny');
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'feat/x']);
    assert.equal(decide(linuxGuard(true), 'git push', dir, { DOCK_CHAT_TURN: '1' }), null);
  } finally { rmrf(dir); }
});

test('DOCK_CHAT_TURN=1 allows git push of a working branch, gh pr create and ordinary work', () => {
  const g = linuxGuard(true);
  for (const c of ALLOWED) assert.equal(decide(g, c, REPO, { DOCK_CHAT_TURN: '1' }), null, c);
});

test('discarding local work is allowed inside a wt-* worktree', () => {
  const g = linuxGuard(true);
  for (const c of ['git reset --hard', 'git clean -fd', 'git checkout -- .', 'git restore .']) assert.equal(decide(g, c, '/home/coder/projects/wt-101-be', { DOCK_CHAT_TURN: '1' }), null, c);
  assert.equal(decide(g, 'git reset --hard', '/home/coder/projects', { DOCK_CHAT_TURN: '1' }), 'deny');
});

test('unattended rules apply outside the workspace root too', () => {
  assert.equal(decide(linuxGuard(true), 'git add .', '/tmp/elsewhere', { DOCK_CHAT_TURN: '1' }), 'deny');
  assert.equal(decide(linuxGuard(false), 'git add .', '/tmp/elsewhere', {}), null);
});

test('interactive session: the new rules warn until softUntil and deny after it', () => {
  const g = linuxGuard(false);
  for (const c of ['git push --force origin feat/x', 'git branch -D x', 'gh pr merge 1', 'git reset --hard', 'sudo ls', 'mongosh --eval "db.dropDatabase()"', 'rm -rf ~/brain']) {
    assert.equal(decide(g, c, REPO, {}, '2999-01-01'), 'warn', c);
    assert.equal(decide(g, c, REPO, {}, '2000-01-01'), 'deny', c);
  }
});

test('P3 test 6: git add . in the Linux workspace answers with a guard message', () => {
  const out = answer('git add .', '/home/coder/projects', { guard: linuxGuard(false), env: {}, cfg: { softUntil: '2999-01-01' }, log: false });
  assert.match(out, /guard/);
  const denied = answer('git add .', '/home/coder/projects', { guard: linuxGuard(true), env: { DOCK_CHAT_TURN: '1' }, cfg: {}, log: false });
  assert.match(denied, /"permissionDecision":"deny"/);
  assert.match(denied, /guard: /);
});

test('the real hook entry point answers on stdin (Windows paths, unattended)', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'guard.cjs')], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: 'E:/qonflo', tool_input: { command: 'git push --force origin feat/x' } }),
    env: { ...process.env, DOCK_CHAT_TURN: '1' }, encoding: 'utf8',
  });
  assert.match(out, /"permissionDecision":"deny"/);
  try { fs.rmSync(path.join(__dirname, '..', 'guard.log'), { force: true }); } catch {}
});

// The same inputs through the source guard and the new one, without DOCK_CHAT_TURN: same rule, same hardness, same reason.
const PARITY = [
  ['git add .', 'E:/qonflo'], ['git add -A', 'E:/qonflo'], ['git add --all', 'E:/qonflo'], ['git add src/a.ts', 'E:/qonflo'], ['git status', 'E:/qonflo'],
  ['git push origin main', 'E:/qonflo'], ['git push origin develop', 'E:/qonflo'], ['git push origin HEAD:master', 'E:/qonflo'], ['git push origin feature/x', 'E:/qonflo'],
  ['git push --force origin main', 'E:/qonflo'], ['git -C E:/qonflo/ms-admin-worker-backend push origin development', 'C:/Users/danus'],
  ['git worktree remove --force E:/qonflo/wt-1-be', 'E:/qonflo'], ['git worktree remove "$D"', 'E:/qonflo'], ['git worktree remove -f x', '/e/qonflo'],
  ['rm -rf wt-1234-be', 'E:/qonflo'], ['rm -rf E:/qonflo/wt-1-be/node_modules', 'C:/Users/danus'], ['rm -rf E:/qonflo/wt-1-be/dist', 'C:/Users/danus'], ['rm -rf *', 'E:/qonflo'], ['rm -rf *', 'C:/Users/danus'],
  ['rm -rf wt-*', 'E:/qonflo'], ['Remove-Item -Recurse wt-5-fe', 'E:/qonflo'], ['rmdir /s /q E:\\qonflo\\wt-9-be', 'E:/qonflo'],
  ['taskkill /F /PID 3000', 'E:/qonflo'], ['npx kill-port 5173', 'E:/qonflo'], ['kill $(lsof -ti :3001)', '/e/qonflo'], ['bash stack.sh down 3000', 'E:/qonflo'], ['kill 5174', 'E:/qonflo'],
  ['cd E:/qonflo && git add .', 'C:/Users/danus'], ['git add .', 'C:/Users/danus'], ['npm test', 'E:/qonflo'], ['', 'E:/qonflo'],
];

test('without DOCK_CHAT_TURN the new guard decides like the source guard', { skip: !hasSource }, () => {
  const source = require(path.join(SOURCE_KIT, 'guard.cjs'));
  const fresh = createGuard({ platform: 'win32', paths: winPaths, env: {}, home: 'C:/Users/danus' });
  const kit = SOURCE_KIT;
  let compared = 0;
  for (const [command, cwd] of PARITY) {
    const a = source.check(command, cwd), b = fresh.check(command, cwd);
    if (a === null) assert.equal(b, null, `${command} @ ${cwd}`);
    else {
      assert.ok(b, `${command} @ ${cwd}: source answers ${a.rule}`);
      assert.equal(b.rule, a.rule, `${command} @ ${cwd}`);
      assert.equal(Boolean(b.hard), Boolean(a.hard), `${command} @ ${cwd}`);
      assert.equal(b.why.split(winPaths.configDir + '/kit').join(kit), a.why, `${command} @ ${cwd}`);
    }
    compared++;
  }
  assert.equal(compared, PARITY.length);
});

test('a junction node_modules is still a hard deny for git worktree remove', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp('guard-junction');
  try {
    const real = path.join(dir, 'real'), wt = path.join(dir, 'wt-1-be');
    fs.mkdirSync(real); fs.mkdirSync(wt);
    fs.symlinkSync(real, path.join(wt, 'node_modules'), 'junction');
    const fresh = createGuard({ platform: 'win32', paths: { ...winPaths, root: dir.replace(/\\/g, '/') }, env: {}, home: 'C:/Users/danus' });
    const hit = fresh.check(`git worktree remove ${wt.replace(/\\/g, '/')}`, dir.replace(/\\/g, '/'));
    assert.equal(hit.rule, 'worktree-remove');
    assert.equal(hit.hard, true);
  } finally { rmrf(dir); }
});
