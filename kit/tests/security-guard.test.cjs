'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePaths } = require('../paths.cjs');
const { createGuard, answer } = require('../guard.cjs');

const HOME = '/home/coder';
const REPO = '/home/coder/projects/ms-admin-worker-backend';
const linuxPaths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
const winPaths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:\\Users\\danus\\.claude-kantor\\kit', local: {} });
const unattended = () => createGuard({ platform: 'linux', paths: linuxPaths, env: { DOCK_CHAT_TURN: '1' }, home: HOME });
const interactive = () => createGuard({ platform: 'linux', paths: linuxPaths, env: {}, home: HOME });
const verdict = (guard, command, cwd, env, softUntil = '2999-01-01') => {
  const out = answer(command, cwd, { guard, env, cfg: { softUntil }, log: false });
  if (!out) return null;
  return JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny' ? 'deny' : 'warn';
};

const BYPASSES = [
  'bash -c "git push --force origin main"',
  "sh -c 'gh pr merge 12 --squash'",
  'echo $(git push --force origin main)',
  '(git push -f origin main)',
  "g''it push --force origin main",
  "git push origin HEAD:mai''n",
  'eval "git push -f origin main"',
  'B=main; git push origin HEAD:$B',
  'gh pr -R o/r merge 12',
  'gh api -X PUT repos/o/r/pulls/12/merge',
  'git push origin x --mirror',
  "bash -c 'git branch -D old'",
  'powershell -c "git push --force origin main"',
];

test('unattended: every wrapping, quoting and variable bypass of a destructive command is refused', () => {
  const g = unattended();
  for (const c of BYPASSES) assert.equal(verdict(g, c, REPO, { DOCK_CHAT_TURN: '1' }), 'deny', c);
});

test('unattended: more spellings of the same commands are refused', () => {
  const g = unattended();
  const more = [
    'zsh -lc "git push -f origin main"', 'dash -c \'git push --force origin main\'', '/bin/bash -c "git push origin :main"', 'bash -c "bash -c \\"git push -f origin main\\""',
    'echo `git push --force origin main`', '{ git push -f origin main; }', 'cd /tmp && (git push -f origin main)', 'git push origin "HEAD:ma"in', 'g\\it push --force origin main',
    'git push origin mai\\n', 'pwsh -Command "git push --force origin main"', 'powershell.exe -NoProfile -Command "git push -f origin main"', 'cmd /c "git push --force origin main"',
    'cmd.exe /c git push -f origin main', 'bash <<< "git push -f origin main"', 'Invoke-Expression "git push -f origin main"', 'iex "gh pr merge 3"',
    'gh --repo o/r pr merge 12', 'gh pr merge -R o/r 12', 'gh -R=o/r pr close 4', 'gh api repos/o/r/pulls/12/merge -X PUT', 'gh api --method=PUT repos/o/r/pulls/12/merge', 'gh api -XPUT /repos/o/r/pulls/9/merge',
    'gh api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc', 'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc', 'gh api --method DELETE repos/o/r/branches/x',
    'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }\'', 'gh api repos/o/r/pulls/3 -X PATCH -f state=closed',
    'git push --mirror', 'git push --mirror origin', 'git push origin --del x', 'git push origin +HEAD:feat/x', 'git push origin HEAD:refs/heads/main', 'git push origin $(git branch --show-current)',
    'git push origin "$BRANCH"', 'git push origin ${B}', 'bash -c "git push origin $B"', "git push origin $'main'", 'git push origin ma{in,}', 'git branch -Df old', 'git branch -fd old', 'git branch --delete --force old',
    'bash -c \'cd /x && git push -f origin main\'', 'xargs git push -f origin main', 'env GIT_TRACE=1 git push -f origin main', 'git -C /x push -f origin main',
    'git --git-dir /x/.git push origin main', 'bash -c "$CMD"; git push origin $X', 'git branch -d $OLD', 'gh pr $ACTION 12', 'gh api $ENDPOINT -X PUT', '$G push -f origin main',
  ];
  for (const c of more) assert.equal(verdict(g, c, REPO, { DOCK_CHAT_TURN: '1' }), 'deny', c);
});

test('unattended: an unparseable command that mentions git push fails closed', () => {
  const g = unattended();
  for (const c of ['git push origin "main', 'bash -c "git push origin $(echo main"', 'echo $(( git push']) assert.equal(verdict(g, c, REPO, { DOCK_CHAT_TURN: '1' }), 'deny', c);
});

test('legitimate commands still pass in the unattended profile', () => {
  const g = unattended();
  const ok = [
    'git push origin feat/x', 'git push -u origin HEAD:feat/x', 'git push -u origin feature/x', 'gh pr create', 'gh pr create --base develop --head feat/x', 'gh pr view 3', 'gh pr list', 'gh -R o/r pr view 3',
    'gh api repos/o/r/pulls/12', 'gh api repos/o/r/pulls/12/comments -f body=hi', 'gh api repos/o/r/git/refs/heads/feat/x', 'gh api graphql -f query=\'query { viewer { login } }\'', 'git branch -d merged', 'git status',
    'bash -c "git status"', "sh -c 'ls && git diff'", 'echo $(git rev-parse HEAD)', '(cd src && ls)', 'eval "echo hi"', 'git commit -m "docs: say git push --force is refused"', 'echo "git push origin main"',
    'git push origin feat/g-main', 'git log --oneline | head', 'powershell -c "Get-ChildItem"', 'cmd /c dir', 'git push origin feat/x:feat/x', 'git branch', 'git branch -a', 'rm -rf node_modules', 'npm run build && git add src/a.ts',
    'eval "$(ssh-agent -s)"', 'git push origin feat/x # not main', 'git push origin HEAD', 'ls $HOME',
  ];
  for (const c of ok) assert.equal(verdict(g, c, '/tmp/elsewhere', { DOCK_CHAT_TURN: '1' }), null, c);
  const twins = [
    ['git push origin feat/x', 'git push origin main'],
    ['git push origin feat/x', 'git push --force origin feat/x'],
    ['git push -u origin HEAD:feat/x', 'git push -u origin HEAD:main'],
    ['git push --repo=origin feat/x', 'git push --repo=origin main'],
    ['git send-pack origin refs/heads/feat/x', 'git send-pack --force origin refs/heads/feat/x'],
    ['git branch -d merged', 'git branch -D merged'],
    ['git -c core.quotepath=off status', 'git -c core.hooksPath=/x push origin feat/x'],
    ['git -c alias.s=status s', "git -c alias.p='push --force origin main' p"],
    ['git config user.name x', 'git config alias.p "push --force origin main" && git p'],
    ['git remote -v', 'git remote set-url origin x && git push origin feat/x'],
    ['git commit -m "docs: never run git push --force origin main"', 'git push --force origin main'],
    ['gh pr create --title "how to pr merge" --body x', 'gh pr merge 5'],
    ['gh pr comment 5 --body "please pr merge this"', 'gh pr -R o/r merge 5'],
    ['gh pr view 5', 'gh pr close 5'],
    ['gh api repos/o/r/pulls/12', 'gh api -X PUT repos/o/r/pulls/12/merge'],
    ["gh api graphql -f query='query { viewer { login } }'", 'gh api graphql -F query=@q.graphql'],
    ['gh run list', 'gh workflow run ci.yml'],
    ['curl https://api.github.com/repos/o/r/pulls/12', 'curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge'],
    ['curl -X POST https://example.com/hook -d x', 'curl -X POST https://api.github.com/graphql -d x'],
    ['curl -sS https://api.github.com/repos/o/r/git/refs/heads/feat/x', 'curl -sS -X DELETE https://api.github.com/repos/o/r/git/refs/heads/feat/x'],
  ];
  for (const [fine, forbidden] of twins) {
    assert.equal(verdict(g, fine, '/tmp/elsewhere', { DOCK_CHAT_TURN: '1' }), null, fine);
    assert.equal(verdict(g, forbidden, '/tmp/elsewhere', { DOCK_CHAT_TURN: '1' }), 'deny', forbidden);
  }
});

test('the interactive profile gets the same bypass fixes as soft warnings, and nothing new for plain commands', () => {
  const g = interactive();
  for (const c of ['bash -c "git push --force origin main"', 'echo $(git push -f origin main)', "g''it push --force origin main", 'gh pr -R o/r merge 12', 'git push origin x --mirror', 'gh api -X PUT repos/o/r/pulls/12/merge']) {
    assert.equal(verdict(g, c, REPO, {}), 'warn', c);
    assert.equal(verdict(g, c, REPO, {}, '2000-01-01'), 'deny', c);
  }
  for (const c of ['git push origin feat/x', 'git push -u origin HEAD:feat/x', 'gh pr create', 'gh pr view 3', 'git branch -d merged', 'bash -c "git status"', 'B=main; git push origin HEAD:$B']) assert.equal(verdict(g, c, REPO, {}), null, c);
});

test('Windows paths and PowerShell-style commands are not damaged by backslash handling', () => {
  const g = createGuard({ platform: 'win32', paths: winPaths, env: {}, home: 'C:/Users/danus' });
  assert.equal(g.check('cd E:\\qonflo && git add .', 'C:/Users/danus').rule, 'git-add-all');
  assert.equal(g.check('rmdir /s /q E:\\qonflo\\wt-9-be', 'E:/qonflo').rule, 'rm-worktree');
  assert.equal(g.check('Remove-Item -Recurse -Force .\\wt-5-fe', 'E:/qonflo').rule, 'rm-worktree');
  assert.equal(g.check('git add src\\a.ts', 'E:/qonflo'), null);
});

test('a nested cd does not leak into the commands after it', () => {
  const g = interactive();
  assert.equal(g.check('(cd /home/coder/projects/wt-1-be && ls) ; git reset --hard', REPO).rule, 'discard-local');
});
