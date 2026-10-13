'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { createGuard, answer } = require('../guard.cjs');
const { tmp, rmrf } = require('./helpers.cjs');

const ENV = { DOCK_CHAT_TURN: '1' };
const guard = () => createGuard({ env: ENV });
const verdict = (g, command, cwd) => {
  const out = answer(command, cwd, { guard: g, env: ENV, cfg: { softUntil: '2999-01-01' }, log: false });
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
const repoOn = (branch) => {
  const dir = tmp('guard-repo');
  git(dir, '-c', 'init.defaultBranch=main', 'init');
  git(dir, 'commit', '--allow-empty', '-m', 'x');
  if (branch !== 'main') git(dir, 'checkout', '-b', branch);
  return dir;
};
const denied = (cmds, cwd = '/tmp/elsewhere') => {
  const g = guard();
  for (const c of cmds) assert.equal(verdict(g, c, cwd), 'deny', c);
};
const allowed = (cmds, cwd = '/tmp/elsewhere') => {
  const g = guard();
  for (const c of cmds) assert.equal(verdict(g, c, cwd), null, c);
};

test('A: send-pack is a push, and push --receive-pack / --exec is refused', () => {
  denied([
    'git send-pack --force origin refs/heads/main', 'git send-pack origin main', 'git send-pack origin HEAD:refs/heads/main', 'git send-pack --all origin',
    'git push --receive-pack=evil origin feat/x', 'git push --exec=evil origin feat/x', 'git push --receive-pack evil origin feat/x', 'git send-pack --receive-pack=evil origin feat/x',
    'git push --all origin',
  ]);
  allowed(['git send-pack origin refs/heads/feat/x', 'git push origin feat/x']);
});

test('B: aliases defined in the same command are inspected as the real command', () => {
  denied([
    "git -c alias.p='push --force origin main' p",
    "git config alias.p 'push --force origin main' && git p",
    "git config --global alias.p 'push --force origin main'; git p",
    "git config --local alias.p 'push origin main' && git p",
    "git -c alias.d='branch -D old' d",
    "git -c alias.p='!git push --force origin main' p",
    "bash -c \"git -c alias.p='push -f origin main' p\"",
  ]);
  allowed(["git -c alias.p='push origin feat/x' p", "git config alias.s status && git s", 'git -c alias.s=status s']);
});

test('B: settings that redirect a push are refused only together with a push', () => {
  denied([
    'git -c remote.origin.pushurl=https://x.test/r push origin feat/x', 'git -c remote.origin.url=https://x.test/r push origin feat/x', 'git -c remote.origin.push=refs/heads/a:refs/heads/main push origin',
    'git -c url.https://x.test/.insteadOf=https://y.test/ push origin feat/x', 'git -c url.https://x.test/.pushInsteadOf=https://y.test/ push origin feat/x',
    'git -c push.default=matching push', 'git -c branch.feat.merge=refs/heads/main push', 'git -c branch.feat.remote=up push', 'git -c core.sshCommand=evil push origin feat/x',
    'git -c core.hooksPath=/x push origin feat/x', 'git -c credential.helper=x push origin feat/x',
    'git config remote.origin.pushurl https://x.test/r && git push origin feat/x', 'git config --global push.default matching; git push',
    'git remote set-url origin https://x.test/r && git push origin feat/x', 'git remote add up https://x.test/r; git push up feat/x',
  ]);
  allowed([
    'git config remote.origin.url https://x.test/r', 'git config push.default current', 'git remote set-url origin https://x.test/r', 'git remote add up https://x.test/r',
    'git -c core.hooksPath=/x status', 'git config --get remote.origin.url', 'git remote -v', 'git config user.name x', 'git -c core.quotepath=off status',
  ]);
});

test('B: an unknown git verb fails closed when an alias could exist and the arguments look like a push', () => {
  denied(['git frob push --force origin main', 'git frob origin main', 'git frob --force', 'git frob origin HEAD:feat/x']);
  allowed(['git frob', 'git frob --version', 'git status', 'git lfs ls-files']);
});

test('B: an alias stored in the repository config is resolved for the verb in that directory', () => {
  const dir = repoOn('feat/x');
  try {
    git(dir, 'config', 'alias.zp', 'push --force origin main');
    git(dir, 'config', 'alias.zs', '!git push origin main');
    git(dir, 'config', 'alias.ok', 'status');
    const g = guard();
    for (const c of ['git zp', 'git zs', 'git -C . zp']) assert.equal(verdict(g, c, dir), 'deny', c);
    assert.equal(verdict(g, 'git ok', dir), null);
    assert.equal(verdict(g, 'git nothere', dir), null);
  } finally { rmrf(dir); }
});

test('C: --repo names the remote, so the positionals are refspecs', () => {
  denied(['git push --repo=origin main', 'git push --repo origin main', 'git push --repo=origin HEAD:main', 'git push --repo origin HEAD:refs/heads/main', 'git push -o ci.skip --repo origin main', 'git push --repo=origin develop']);
  allowed(['git push --repo=origin feat/x', 'git push --repo origin feat/x', 'git push -o ci.skip origin feat/x']);
});

test('C: a push with no refspec is judged by the current branch', () => {
  const onMain = repoOn('main');
  const onFeature = repoOn('feat/x');
  try {
    const g = guard();
    for (const c of ['git push origin', 'git push', 'git push --repo=origin', 'git push -u origin HEAD', 'git push origin HEAD']) {
      assert.equal(verdict(g, c, onMain), 'deny', `main: ${c}`);
      assert.equal(verdict(g, c, onFeature), null, `feature: ${c}`);
    }
  } finally { rmrf(onMain); rmrf(onFeature); }
});

test('D: gh decides from the parsed subcommand, never from free text', () => {
  allowed([
    'gh pr create --title "how to pr merge" --body x', 'gh pr comment 5 --body "please pr merge this"', 'gh pr create -t "pr close" -b "release delete"', 'gh issue create --title "repo delete" --body "workflow run"',
    'gh pr view 5', 'gh pr checks 5', 'gh api repos/o/r/pulls/12', 'gh api repos/o/r/issues/5/comments -f body="pr merge now" -F title="pr merge"', 'gh pr edit 5 --body "gh pr merge 5"',
    "gh api graphql -f query='query { viewer { login } }'", 'gh alias set co "pr checkout"', 'gh workflow list', 'gh run view 5',
  ]);
  denied([
    'gh pr merge 5', 'gh pr close 5', 'gh -R o/r pr merge 5', 'gh repo delete o/r --yes', 'gh release delete v1', 'gh workflow run ci.yml', 'gh workflow run ci.yml -f x=y',
    'gh alias set m "pr merge"', 'gh alias set d "repo delete $1"', 'gh api graphql -F query=@q.graphql', 'gh api graphql --input q.json', 'gh api -X DELETE repos/o/r/git/refs/heads/x',
    'gh api -X POST repos/o/r/actions/workflows/ci.yml/dispatches', "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'",
  ]);
});

test('E: raw GitHub API writes to merge, ref, protection and graphql paths are refused, reads are not', () => {
  denied([
    'curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge', 'curl -XPUT https://api.github.com/repos/o/r/pulls/12/merge', 'curl --request PUT https://api.github.com/repos/o/r/pulls/12/merge',
    'curl -d "{}" https://api.github.com/repos/o/r/pulls/12/merge', 'curl -F a=b https://api.github.com/repos/o/r/merges', 'curl -X POST -d @q https://api.github.com/graphql',
    'curl -X PATCH https://api.github.com/repos/o/r/git/refs/heads/main -d x', 'curl -X DELETE https://api.github.com/repos/o/r/git/refs/heads/x', 'curl -X PUT https://api.github.com/repos/o/r/branches/main/protection',
    'curl -X POST https://github.com/o/r.git/git-receive-pack', 'curl -X PUT https://api.github.com/repos/o/r/pulls/$N/merge',
    'wget --method=DELETE https://api.github.com/repos/o/r/git/refs/heads/x', 'wget --post-data=x https://api.github.com/repos/o/r/git/refs',
    'Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/o/r/pulls/1/merge', 'Invoke-WebRequest -Method Post https://api.github.com/graphql', 'iwr -Method POST https://api.github.com/graphql',
    'irm https://api.github.com/graphql -Body x', 'http PUT api.github.com/repos/o/r/pulls/12/merge', 'http POST https://api.github.com/graphql query=x', 'https PUT api.github.com/repos/o/r/merges',
    'rtk proxy curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge', 'bash -c "curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge"',
  ]);
  allowed([
    'curl https://api.github.com/repos/o/r/pulls/12', 'curl -s https://api.github.com/repos/o/r/pulls/12/merge', 'curl -X GET https://api.github.com/graphql', 'curl -G -d q=x https://api.github.com/search/issues',
    'curl -x http://proxy:3128 https://api.github.com/repos/o/r', 'curl -X POST https://example.com/merge -d x', 'curl -X PUT https://api.github.com/repos/o/r/issues/5/labels -d x',
    'wget -qO- https://api.github.com/repos/o/r/git/refs', 'Invoke-RestMethod https://api.github.com/repos/o/r/pulls/12', 'http GET api.github.com/repos/o/r/pulls/12/merge', 'http api.github.com/repos/o/r/pulls/12',
  ]);
});

test('false positives: ordinary commands stay allowed in the unattended profile', () => {
  const dir = repoOn('feat/x');
  try {
    const g = guard();
    for (const c of [
      'git push origin feat/x', 'git push -u origin HEAD', 'git commit -m "docs: never run git push --force origin main"', 'echo "git push --force origin main"', 'rg "push --force" .',
      'gh pr create --title "how to pr merge" --body x', 'gh pr comment 5 --body "please pr merge this"', 'gh pr view 5', 'gh pr checks 5', 'gh api repos/o/r/pulls/12',
      'curl https://api.github.com/repos/o/r/pulls/12', 'git config user.name x', 'git -c core.quotepath=off status', 'git remote -v', 'npm test', 'FOO=$BAR node build.js',
    ]) assert.equal(verdict(g, c, dir), null, c);
  } finally { rmrf(dir); }
});

test('known limits: these need branch protection or the permission prompt, the guard does not stop them', () => {
  const g = guard();
  const notStopped = [
    `python3 -c "import subprocess; subprocess.run(['git','push','--force','origin','main'])"`,
    `node -e "require('child_process').execSync('git push --force origin main')"`,
    `perl -e 'system("git", "push", "--force", "origin", "main")'`,
    'bash x.sh', './x.sh', 'node x.js',
  ];
  for (const c of notStopped) assert.equal(verdict(g, c, '/tmp/elsewhere'), null, `currently allowed (a known limit, not coverage): ${c}`);
});
