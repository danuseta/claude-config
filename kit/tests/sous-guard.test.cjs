'use strict';
// kit/sous-guard.cjs: the path, bash, runner, verify, publish and jira guards of the sous agents, on both systems' paths, plus the hook command form.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolvePaths } = require('../paths.cjs');
const { createSousGuard } = require('../sous-guard.cjs');
const { KIT, tmp, rmrf, runNode } = require('./helpers.cjs');

const winPaths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:/Users/danus/.claude-kantor/kit', local: {} });
const linuxPaths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
const winGuard = (extra = {}) => createSousGuard({ platform: 'win32', paths: winPaths, cwd: 'E:/qonflo', ...extra });
const linuxGuard = (extra = {}) => createSousGuard({ platform: 'linux', paths: linuxPaths, cwd: '/home/coder/projects', ...extra });
const write = (file) => ({ tool_name: 'Write', tool_input: { file_path: file } });
const read = (file) => ({ tool_name: 'Read', tool_input: { file_path: file } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('path guard: a worker writes inside a ticket worktree only, never the protected files', () => {
  for (const [g, wt, board] of [[winGuard(), 'E:/qonflo/wt-1387-be', 'E:/qonflo/.evidence/blackboard'], [linuxGuard(), '/home/coder/projects/wt-1387-fe', '/home/coder/projects/.evidence/blackboard']]) {
    assert.equal(g.check('path', ['@wt'], write(`${wt}/src/a.ts`)), null);
    for (const f of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', '.github/workflows/ci.yml', '.husky/pre-commit', '.git/config', '.env', '.env.local', 'CLAUDE.md', 'AGENTS.md', 'node_modules/x/index.js', 'sub/package.json']) {
      assert.match(g.check('path', ['@wt'], write(`${wt}/${f}`)), /protected/, f);
    }
    assert.match(g.check('path', ['@wt'], write(`${path.posix.dirname(wt)}/ms-admin-worker-backend/src/a.ts`)), /outside/);
    assert.match(g.check('path', ['@wt'], write(`${wt}/../wt-other/../../etc/passwd`)), /outside/);
    assert.equal(g.check('path', ['@board'], write(`${board}/QRD-1/prompts/S1.md`)), null);
    for (const f of ['status.md', 'decisions.md', 'issues.md', 'NOW.md', 'EPIC.md', 'tickets/QRD-2/NOW.md', 'tickets/QRD-2/status.md']) assert.match(g.check('path', ['@board'], write(`${board}/QRD-1/${f}`)), /generated from the ledger/, f);
    for (const f of ['tickets/QRD-2/ac.txt', 'tickets/QRD-2/tasks.md', 'prompts/S2.md', 'materials/contract.md']) assert.equal(g.check('path', ['@board'], write(`${board}/QRD-1/${f}`)), null, f);
    assert.match(g.check('path', ['@wt'], { tool_name: 'Write', tool_input: {} }), /no file path/);
  }
  const g = winGuard();
  assert.equal(g.check('path', ['@wt'], write('E:\\qonflo\\wt-1387-be\\src\\a.ts')), null);
  assert.equal(g.check('path', ['@wt'], write('/e/qonflo/wt-1387-be/src/a.ts')), null);
  assert.equal(g.check('path', ['@wt'], write('e:/QONFLO/WT-1387-BE/src/a.ts')), null);
  assert.match(g.check('path', ['@wt'], write('E:\\qonflo\\wt-1387-be\\Package.JSON')), /outside|protected/);
  assert.match(g.check('path', ['@wt'], { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }), /outside/, 'a relative path resolves against the cwd, the workspace root');
});

test('path guard --read: under the roots, never a secret file', () => {
  const g = linuxGuard();
  assert.equal(g.check('path', ['--read', '@root', '@config'], read('/home/coder/projects/ms-admin-worker-backend/src/a.ts')), null);
  assert.equal(g.check('path', ['--read', '@root', '@config'], read('/home/coder/.claude/rules/ticket-contract.md')), null);
  assert.match(g.check('path', ['--read', '@root'], read('/home/coder/.ssh/id_rsa')), /outside/);
  for (const f of ['/home/coder/.claude/kit/status.cjs', '/home/coder/.claude/skills/sous/SKILL.md', '/home/coder/.claude/agents/sous-planner.md']) assert.equal(g.check('path', ['--read', '@config'], read(f)), null, f);
  for (const f of ['/home/coder/.claude/projects/-home-coder-projects/a.jsonl', '/home/coder/.claude/settings.json', '/home/coder/.claude/.credentials.json', '/home/coder/.claude/history.jsonl']) {
    assert.match(g.check('path', ['--read', '@config'], read(f)), /outside/, `@config is kit, skills, agents and rules only: ${f}`);
  }
  assert.match(g.check('bash', ['@config'], bash('rtk rg token /home/coder/.claude/projects')), /outside/);
  for (const f of ['/home/coder/projects/wt-1-be/.env', '/home/coder/.claude/kit/dock.json', '/home/coder/.claude/secrets.local.json', '/home/coder/projects/x/server.pem']) {
    assert.match(g.check('path', ['--read', '@root', '@config'], read(f)), /secret/, f);
  }
  assert.equal(g.check('path', ['--read', '@root'], read('/home/coder/projects/wt-1-be/.env.example')), null);
  assert.equal(g.check('path', ['--read', '@root'], { tool_name: 'Grep', tool_input: { pattern: 'x' } }), null, 'Grep without a path searches the cwd');
});

test('bash guard: one read-only command under the roots', () => {
  const g = linuxGuard();
  const roots = ['@root', '@evidence'];
  for (const c of ['rtk rg "useFlow" /home/coder/projects/wt-1-fe/src', 'rtk read /home/coder/projects/.evidence/blackboard/QRD-1/NOW.md', 'ls /home/coder/projects', 'rtk rg "x" /home/coder/projects/wt-1-be/src', 'rtk tree /home/coder/projects/wt-1-be/src', 'grep -rn x /home/coder/projects/wt-1-be/src', 'rtk proxy rg x /home/coder/projects/wt-1-be', 'git -C /home/coder/projects/wt-1-be diff --stat', 'git -C /home/coder/projects/wt-1-be log --oneline -5', 'gh pr view 12 --repo o/r --json url', "rtk rg 'a|b' /home/coder/projects/wt-1-be"]) {
    assert.equal(g.check('bash', roots, bash(c)), null, c);
  }
  const denied = {
    'cat /home/coder/projects/a.ts | head': /operator/,
    'ls; rm -rf /': /operator/,
    'cat $HOME/.ssh/id_rsa': /operator/,
    'cat "$(whoami)"': /\$ and backticks/,
    'cat /etc/passwd': /outside/,
    'cat /home/coder/projects/wt-1-be/.env': /secret/,
    'find /home/coder/projects -delete': /-exec, -delete/,
    'git -C /home/coder/projects/wt-1-be push origin x': /not a read-only git/,
    'git -C /home/coder/projects/wt-1-be commit -m x': /not a read-only git/,
    'git status': /git -C/,
    'gh pr merge 12': /gh: only/,
    'npm test': /not allowed here/,
    'rtk rg --pre=sh x /home/coder/projects/wt-1-be': /runs a program/,
    'rg --pre sh x /home/coder/projects/wt-1-be': /runs a program/,
    'rtk rg --pre-glob "*.ts" x /home/coder/projects/wt-1-be': /runs a program/,
    'rg -z x /home/coder/projects/wt-1-be': /runs a program/,
    'rg -iz x /home/coder/projects/wt-1-be': /runs a program/,
    'rg --search-zip x /home/coder/projects/wt-1-be': /runs a program/,
    'rtk tree -o f /home/coder/projects/wt-1-be': /writes a file/,
    'tree -ao f /home/coder/projects/wt-1-be': /writes a file/,
    'find -L /home/coder/projects/wt-1-be': /-L/,
    'find /home/coder/projects -follow': /-follow/,
    'find /home/coder/projects -execdir id': /-execdir/,
    'find /home/coder/projects -fprintf /tmp/x %p': /-fprintf/,
    'grep -R x /home/coder/projects/wt-1-be': /follows links/,
    'grep --dereference-recursive x /home/coder/projects/wt-1-be': /follows links/,
    'rtk proxy rg --pre=sh x /home/coder/projects/wt-1-be': /runs a program/,
    'rtk proxy cat /etc/passwd': /outside/,
    'rtk proxy curl https://x': /not allowed here/,
    'node /home/coder/.claude/kit/status.cjs show QRD-1': /not allowed here/,
  };
  for (const [c, why] of Object.entries(denied)) assert.match(g.check('bash', roots, bash(c)) || '', why, c);
  assert.equal(g.check('bash', roots, read('/etc/passwd')), null, 'bash mode ignores other tools');
});

test('runner guard: sous agents and browser-verifier only; kit scripts by their installed path', () => {
  const g = winGuard();
  const roots = ['@root', '@evidence', '@config'];
  for (const t of ['sous-intake', 'sous-planner', 'sous-ticket-worker', 'sous-reviewer', 'sous-verifier', 'sous-arbiter', 'sous-publisher', 'sous-explorer', 'sous-jira', 'sous-video', 'browser-verifier']) {
    assert.equal(g.check('runner', roots, { tool_name: 'Agent', tool_input: { subagent_type: t } }), null, t);
  }
  assert.match(g.check('runner', roots, { tool_name: 'Agent', tool_input: { subagent_type: 'sous-ticket-worker', run_in_background: true } }), /no background agents/, 'QRD-1346: background workers died with the turn');
  assert.match(g.check('runner', roots, { tool_name: 'Bash', tool_input: { command: 'rtk ls E:/qonflo', run_in_background: true } }), /no background/);
  assert.equal(g.check('runner', roots, { tool_name: 'Agent', tool_input: { subagent_type: 'sous-ticket-worker', run_in_background: false } }), null);
  const del = (c) => ({ tool_name: 'Bash', tool_input: { command: c } });
  const wt = 'E:/qonflo/wt-77-be';
  assert.equal(g.check('runner', roots, del(`git -C ${wt} rm src/a.helper.ts tests/a.test.ts`)), null, 'QRD-1275: a decision ordered files deleted and no agent could');
  assert.match(g.check('runner', roots, del(`git -C ${wt} rm -r src`)) || '', /named files only/);
  assert.match(g.check('runner', roots, del('git -C E:/qonflo/ms-admin-worker-backend rm src/a.ts')) || '', /only inside a ticket worktree/);
  assert.match(g.check('bash', roots, del(`git -C ${wt} rm src/a.ts`)) || '', /not a read-only git/, 'a worker still cannot delete');
  for (const t of ['general-purpose', 'oh-my-claudecode:executor', 'sous-ticket-runner', undefined]) {
    assert.match(g.check('runner', roots, { tool_name: 'Task', tool_input: { subagent_type: t } }), /subagent type not allowed/, String(t));
  }
  const K = 'C:/Users/danus/.claude-kantor/kit';
  for (const c of [`node ${K}/status.cjs show QRD-1`, `node "${K}/status.cjs" decide QRD-1 "x" --status SHOV --by sous`, `node ${K}/demo-upload.cjs QRD-1 E:/qonflo/.evidence/QRD-1/evidence.mp4`, `bash ${K}/prep-ticket.sh QRD-1 slug origin/develop - "t"`, `bash ${K}/wt.sh add be E:/qonflo/wt-1-be feat/QRD-1-x origin/develop`, `bash ${K}/stack.sh up QRD-1 a b 3101 5201`, `${K}/bin/kit-node status.cjs show QRD-1`, `node ${K}/login-state.cjs 5346`, `rtk read E:/qonflo/.evidence/blackboard/QRD-1/NOW.md`]) {
    assert.equal(g.check('runner', roots, bash(c)), null, c);
  }
  assert.equal(g.check('runner', roots, bash(`node ${K}/status.cjs set QRD-1 draft=true`)), null, 'draft=true stays allowed');
  for (const c of [`node ${K}/status.cjs set QRD-1 rounds.max=9`, `node ${K}/status.cjs set QRD-1 stage=code rounds.max=3`, `node ${K}/status.cjs set QRD-1 draft=false`, `${K}/bin/kit-node status.cjs set QRD-1 rounds.max=9`, `${K}/bin/kit-node status.cjs set QRD-1 draft=false`]) {
    assert.match(g.check('runner', roots, bash(c)) || '', /owner's to set/, c);
  }
  for (const c of [`node ${K}/dock-chat.cjs`, `node E:/qonflo/evil/status.cjs show`, `bash ${K}/wt.sh remove E:/qonflo/wt-1-be`, `bash ${K}/stack.sh kill`, 'npx jest', `node ${K}/status.cjs show QRD-1 && rm -rf x`]) {
    assert.ok(g.check('runner', roots, bash(c)), c);
  }
});

test('publish guard: per path staging, commit -m, ticket branches only, gh pr create with a body under evidence', () => {
  const base = tmp('sous-publish');
  try {
    const root = path.join(base, 'root').replace(/\\/g, '/');
    const wt = `${root}/wt-77-be`;
    fs.mkdirSync(wt, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'feat/QRD-77-thing', wt]);
    fs.mkdirSync(`${root}/.evidence/QRD-77`, { recursive: true });
    fs.writeFileSync(`${root}/.evidence/QRD-77/pr-body-be.md`, 'Jira: x\n');
    fs.writeFileSync(`${root}/.evidence/QRD-77/bad-body.md`, 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    const paths = resolvePaths({ local: { root, github: { be: 'o/r', fe: 'o/f' }, bases: ['develop', 'feat/V1-Playbook'] }, kitDir: KIT });
    const g = createSousGuard({ paths, cwd: root });
    fs.mkdirSync(`${root}/.evidence/QRD-78`, { recursive: true });
    fs.writeFileSync(`${root}/.evidence/QRD-78/status.json`, JSON.stringify({ key: 'QRD-78', stackedOn: { key: 'QRD-77', be: { pr: 'https://github.com/o/r/pull/1', branch: 'feat/QRD-77-thing', base: 'develop' } } }));
    const body = `${root}/.evidence/QRD-77/pr-body-be.md`;
    const pr = (repo, base, head = 'feat/QRD-77-thing') => bash(`gh pr create${repo ? ` --repo ${repo}` : ''}${base ? ` --base ${base}` : ''} --head ${head} --title t --body-file ${body}`);
    for (const [repo, base, head] of [['o/r', 'develop'], ['o/f', 'feat/V1-Playbook'], ['O/R', 'develop'], ['o/r', 'feat/QRD-77-thing', 'feat/QRD-78-child']]) assert.equal(g.check('publish', [], pr(repo, base, head)), null, `${repo} ${base} ${head}`);
    for (const [repo, base, head, why] of [['x/r', 'develop', undefined, /not this machine's BE or FE repo/], ['o/r', 'main', undefined, /not a configured base/], ['o/r', 'feat/QRD-77-thing', undefined, /not a configured base/], ['o/f', 'feat/QRD-77-thing', 'feat/QRD-78-child', /not a configured base/], ['', 'develop', undefined, /needs --repo/], ['o/r', '', undefined, /needs --repo/]]) {
      assert.match(g.check('publish', [], pr(repo, base, head)) || '', why, `${repo} ${base} ${head}`);
    }
    const ok = [`git -C ${wt} status`, `git -C ${wt} add src/a.ts src/b.ts`, `git -C ${wt} commit -m "fix(QRD-77): thing" -m "second"`, `git -C ${wt} push -u origin feat/QRD-77-thing`, `rtk git -C ${wt} diff --cached --name-only`, `git -C ${wt} remote get-url origin`, `git -C ${wt} rm src/old.ts tests/old.test.ts`, `git -C ${wt} rm -- src/old.ts`,
      `gh pr create --repo o/r --base develop --head feat/QRD-77-thing --title "QRD-77 fix: thing" --body-file ${root}/.evidence/QRD-77/pr-body-be.md --draft`, 'gh pr list --repo o/r --head feat/QRD-77-thing --json url'];
    for (const c of ok) assert.equal(g.check('publish', [], bash(c)), null, c);
    const denied = {
      [`git -C ${wt} add -A`]: /named paths only/, [`git -C ${wt} add .`]: /named paths only/, [`git -C ${wt} add --all`]: /named paths only/, [`git -C ${wt} add -u`]: /named paths only/, [`git -C ${wt} add ${wt}`]: /named paths only/,
      [`git -C ${wt} rm -r src`]: /named files only/, [`git -C ${wt} rm -f src/a.ts`]: /named files only/, [`git -C ${wt} rm --cached src/a.ts`]: /named files only/, [`git -C ${wt} rm .`]: /named files only/, [`git -C ${wt} rm src/*.ts`]: /named files only/,
      [`git -C ${wt} rm`]: /needs the files/, [`git -C ${wt} rm ../wt-78-be/src/a.ts`]: /inside the ticket worktree/, [`git -C ${wt} rm ${wt}`]: /inside the ticket worktree/,
      [`git -C ${wt} commit --no-verify -m x`]: /-m <message> only/, [`git -C ${wt} commit -m "x" -m "Co-Authored-By: Claude"`]: /attribution/,
      [`git -C ${wt} push origin develop`]: /not a ticket branch/, [`git -C ${wt} push origin main`]: /not a ticket branch/, [`git -C ${wt} push -f origin feat/QRD-77-thing`]: /push is git/, [`git -C ${wt} push origin feat/QRD-78-other`]: /only the current branch/, [`git -C ${wt} push origin feature/QRD-77-thing`]: /not a ticket branch/,
      [`git -C ${root}/ms-admin-worker-backend push origin feat/QRD-77-thing`]: /only inside a ticket worktree/, [`git -C ${wt} reset --hard`]: /not a read-only git/,
      [`gh pr create --repo o/r --base develop --head develop --title t --body-file ${root}/.evidence/QRD-77/pr-body-be.md`]: /not a ticket branch/,
      [`gh pr create --repo o/r --base develop --head feat/QRD-77-thing --title t --body-file ${base}/elsewhere.md`]: /evidence folder/,
      [`gh pr create --repo o/r --base develop --head feat/QRD-77-thing --title t --body-file ${root}/.evidence/QRD-77/bad-body.md`]: /attribution/,
      [`gh pr create --repo o/r --base develop --head feat/QRD-77-thing --title t --body x`]: /argument not allowed/,
      'gh pr merge 3': /gh: only/, [`git -C ${wt} add a && git -C ${wt} push origin main`]: /operator/, 'curl https://x': /not allowed for the publisher/,
    };
    for (const [c, why] of Object.entries(denied)) assert.match(g.check('publish', [], bash(c)) || '', why, c);
  } finally {
    rmrf(base);
  }
});

test('jira guard: QRD only, no sprint or assignee, edits only on tickets it created', () => {
  const base = tmp('sous-jira');
  try {
    const ledgerFile = path.join(base, 'created.log');
    const g = linuxGuard({ ledgerFile });
    const create = (ti) => g.check('jira', [], { tool_name: 'mcp__claude_ai_Atlassian__createJiraIssue', tool_input: ti });
    const edit = (ti) => g.check('jira', [], { tool_name: 'mcp__atlassian__editJiraIssue', tool_input: ti });
    assert.equal(create({ projectKey: 'QRD', summary: 's', additional_fields: { labels: ['sous'] } }), null);
    assert.match(create({ projectKey: 'OPS', summary: 's' }), /only project QRD/);
    assert.match(create({ projectKey: 'QRD', assignee_account_id: 'x' }), /unassigned/);
    assert.match(create({ projectKey: 'QRD', transition: { id: '1' } }), /transition/);
    assert.match(create({ projectKey: 'QRD', additional_fields: { customfield_10020: 3 } }), /field not allowed/);
    assert.match(create({ projectKey: 'QRD', additional_fields: { labels: ['sous', 'QRD24'] } }), /sprint labels/);
    for (const extra of [undefined, {}, { labels: [] }, { labels: ['bug'] }, { labels: 'sous' }]) assert.match(create({ projectKey: 'QRD', summary: 's', additional_fields: extra }), /must include "sous"/, JSON.stringify(extra));
    assert.match(create({ projectKey: 'QRD', parent: 'QRD-1', additional_fields: { labels: ['sous'] } }), /not created by sous-jira/);
    assert.match(edit({ issueIdOrKey: 'QRD-900', fields: { summary: 'x' } }), /not created by sous-jira/);
    assert.equal(g.record({ content: [{ type: 'text', text: JSON.stringify({ id: '1', key: 'QRD-900', self: 'https://x' }) }] }), 'QRD-900');
    assert.equal(edit({ issueIdOrKey: 'QRD-900', fields: { summary: 'x', labels: ['sous', 'a'] } }), null);
    assert.equal(edit({ issueIdOrKey: 'QRD-900', fields: { summary: 'x' } }), null, 'an edit without labels keeps them');
    for (const labels of [['a'], [], null]) assert.match(edit({ issueIdOrKey: 'QRD-900', fields: { labels } }), /must keep "sous"/, JSON.stringify(labels));
    assert.match(edit({ issueIdOrKey: 'QRD-900', fields: { status: 'Done' } }), /fields not allowed: status/);
    assert.equal(create({ projectKey: 'QRD', parent: 'QRD-900', additional_fields: { labels: ['sous'] } }), null);
    assert.match(g.check('jira', [], { tool_name: 'mcp__x__addCommentToJiraIssue', tool_input: {} }), /tool not allowed/);
  } finally {
    rmrf(base);
  }
});

test('verify guard: tests and type checks inside a worktree, no installs, servers, network or inline code', () => {
  for (const [g, wt] of [[winGuard(), 'E:/qonflo/wt-1387-be'], [linuxGuard(), '/home/coder/projects/wt-1387-be']]) {
    const v = (c) => g.check('verify', ['@wt'], bash(c));
    for (const c of ['npx vitest run src/a.test.ts --maxWorkers=40%', 'npx jest src/a.test.ts', 'npx tsc --noEmit -p tsconfig.json', 'npm test', 'npm run test:unit', 'pnpm vitest run', 'pnpm exec tsc --noEmit', 'rtk vitest run', 'node --test test/a.test.cjs', `git -C ${wt} diff --stat`, 'ls src', 'rtk rg foo src']) {
      assert.equal(v(`cd ${wt} && ${c}`), null, c);
    }
    for (const [c, re] of [['npm i', /no installs/], ['npm ci', /no installs/], ['pnpm add lodash', /no installs/], ['npm run dev', /dev servers/], ['npx -y cowsay hi', /only vitest/], ['npx cowsay', /only vitest/], ['node -e 1', /inline code/], ['curl http://x', /not allowed for the verifier/], ['gh pr list', /not allowed for the verifier/], ['rm src/a.ts', /not allowed for the verifier/], [`git -C ${wt} commit -m x`, /not a read-only git/], ['npm test | tail', /operator/], ['bash -c "npm test"', /not allowed for the verifier/]]) {
      assert.match(v(`cd ${wt} && ${c}`), re, c);
    }
    assert.match(v('npm test'), /run inside a ticket worktree/, 'the cwd is the workspace root, not a worktree');
    assert.match(v(`cd ${path.posix.dirname(wt)}/ms-admin-worker-backend && npm test`), /run inside a ticket worktree/);
    assert.match(v(`cd ${wt} && npx vitest run ../../etc/x.test.ts`), /outside/);
    assert.equal(g.check('verify', ['@wt'], read(`${wt}/a.ts`)), null, 'only Bash is checked here');
    const ev = `${path.posix.dirname(wt)}/.evidence/QRD-1387/jest.json`;
    assert.equal(g.check('verify', ['@wt', '@evidence'], bash(`cd ${wt} && NO_COLOR=1 rtk jest src/a.test.ts --outputFile=${ev}`)), null, 'the agent prompt form');
    assert.match(v(`cd ${wt} && npx jest --outputFile=${ev}`), /outside/, 'evidence only when the hook names it');
    assert.match(v(`cd ${wt} && NODE_OPTIONS=--require=x npm test`), /not allowed for the verifier/);
  }
});

test('browser guard: playwright-cli on localhost only, the kit ledger and login scripts, reads and the video encode', () => {
  for (const [g, R, K] of [[winGuard(), 'E:/qonflo', 'C:/Users/danus/.claude-kantor/kit'], [linuxGuard(), '/home/coder/projects', '/home/coder/.claude/kit']]) {
    const roots = ['@wt', '@evidence', '@shots'];
    const b = (c) => g.check('browser', roots, bash(c));
    const E = `${R}/.evidence`;
    for (const c of [
      `cd ${E} && timeout 90 playwright-cli -s=QRD-1 open http://localhost:5287/workflows --config=${R}/.playwright/cli-5287.json`,
      'playwright-cli -s=QRD-1 goto http://127.0.0.1:5287/', 'timeout 90 playwright-cli -s=QRD-1 snapshot', 'playwright-cli -s=QRD-1 click e12', `playwright-cli -s=QRD-1 run-code --filename=${E}/QRD-1/scripts/ac-1.js`,
      `playwright-cli -s=QRD-1 screenshot --filename=${R}/1021/qrd-1/ac-1-dark.png`, 'playwright-cli -s=QRD-1 eval "document.title"', `playwright-cli -s=QRD-1 video-start ${E}/QRD-1/evidence.webm`, 'playwright-cli -s=QRD-1 close',
      `node ${K}/login-state.cjs 5287`, `node ${K}/paths.cjs --print`, `node "${K}/status.cjs" ac QRD-1 1 PASS "list shows 3 rows" "${R}/1021/qrd-1/ac-1-dark.png"`,
      `node ${K}/status.cjs handoff QRD-1 browser-verifier status=done summary="2 of 2 AC pass" evidence="${R}/1021/qrd-1/ac-1-dark.png"`, `${K}/bin/kit-node status.cjs show QRD-1`, `bash ${K}/stack.sh status 3101 5287`,
      `mkdir -p ${R}/1021/qrd-1`, `rtk ls ${R}/1021/qrd-1`, `ffmpeg -y -i ${E}/QRD-1/evidence.webm -c:v libx264 -pix_fmt yuv420p -crf 28 ${E}/QRD-1/evidence.mp4`, `ffprobe ${E}/QRD-1/evidence.mp4`,
      `cd ${E} && timeout 90 ffmpeg -y -i QRD-1/evidence.webm -crf 32 QRD-1/evidence.mp4`, `cd ${E} && mkdir -p QRD-1/scripts`,
    ]) assert.equal(b(c), null, c);
    assert.match(b('mkdir -p x') || '', /outside/, 'a relative folder resolves against the cwd, the workspace root');
    assert.match(b('ffmpeg -i a.webm b.mp4') || '', /outside/);
    const denied = {
      'playwright-cli -s=QRD-1 open https://example.com': /only opens localhost/, 'playwright-cli open http://localhost.evil.com/': /only opens localhost/, 'playwright-cli goto example.com': /only opens localhost/,
      'playwright-cli open file:///etc/passwd': /only opens localhost/, "playwright-cli eval \"fetch('https://x.io')\"": /only opens localhost/,
      'git status': /not allowed for the browser/, 'gh pr list': /not allowed for the browser/, 'curl http://localhost:3101': /not allowed for the browser/, 'wget http://x': /not allowed/, 'ssh host': /not allowed/, 'scp a b:': /not allowed/, 'rsync a b': /not allowed/,
      'nc -l 1': /not allowed/, 'mongosh': /not allowed/, 'redis-cli': /not allowed/, 'kill 1': /not allowed/, 'sudo ls': /not allowed/, 'chmod 777 x': /not allowed/, 'chown a x': /not allowed/, 'printenv': /not allowed/, 'env': /not allowed/,
      'timeout 90 env': /not allowed/, 'sh -c "ls"': /not allowed/, 'bash -c "ls"': /bash only runs the kit/, 'eval ls': /not allowed/, 'rtk proxy curl x': /not allowed/,
      [`cat ${R}/wt-1-be/.env`]: /protected path|secret/, 'cat ~/.ssh/id_rsa': /protected path/, [`cat ${R}/.claude/settings.json`]: /protected path/, 'playwright-cli -s=QRD-1 state-save ~/.config/x.json': /protected path/,
      'playwright-cli open http://localhost:5287 | tee x': /operator/, 'playwright-cli open "$(curl x)"': /\$ and backticks/,
      [`node ${K}/demo-upload.cjs QRD-1 x.mp4`]: /only runs the kit/, [`node ${K}/status.cjs set QRD-1 draft=false`]: /owner's to set/, [`bash ${K}/wt.sh add be x y z`]: /only runs the kit/, 'node -e 1': /only runs the kit/,
      'mkdir /tmp/x': /outside/, 'mkdir -m 777 x': /-p and folders only/, [`ffmpeg -i http://x/a.mp4 ${E}/a.mp4`]: /not a local file/, [`ffmpeg -i ${E}/a.webm /tmp/a.mp4`]: /outside/,
      [`cd ${R}/ms-admin-worker-backend && ls`]: /cd only into/, 'rm x': /not allowed for the browser/, 'npx playwright test': /not allowed for the browser/,
    };
    for (const [c, why] of Object.entries(denied)) assert.match(b(c) || '', why, c);
    assert.equal(g.check('browser', roots, read('/etc/passwd')), null, 'browser mode checks Bash only');
  }
});

test('video guard: the demo-video pipeline inside the ticket video folder only', () => {
  for (const [g, R, K, V] of [[winGuard(), 'E:/qonflo', 'C:/Users/danus/.claude-kantor/kit', 'E:/qonflo-out/1021/QRD-1346'], [linuxGuard(), '/home/coder/projects', '/home/coder/.claude/kit', '/home/coder/qonflo-out/1021/QRD-1346']]) {
    const roots = ['@video', '@skill', '@wt', '@evidence', '@config'];
    const v = (c) => g.check('video', roots, bash(c));
    const S = `${R}/.claude/skills/demo-video`;
    for (const c of [
      `cd ${V}/video && npx remotion render Demo out/demo.mp4 --codec=h264 --crf=16 --concurrency=2`, `cd ${V}/video && npx remotion still Demo out/f.png --frame=120`, `cd ${V}/video && npx tsc --noEmit`,
      `cd ${V}/video && npm i`, `cd ${V}/video && npm_config_cache=${V}/.npm-cache npm ci --no-audit`,
      `cp -r ${S}/remotion ${V}/video`, `cp ${V}/recording.mp4 ${V}/video/public/`, `cp ${V}/demo.json ${V}/video/src/demo.json`, `rm -rf ${V}/video/node_modules`,
      `python ${S}/scripts/tts.py ${V}/scenario.json --say`, `python3 ${S}/scripts/tts.py ${V}/scenario.json --test "Baru pas di-Save, servernya nolak."`,
      `ELEVENLABS_API_KEY="$(node ${K}/el-rotate.cjs get)" python3 ${S}/scripts/tts.py ${V}/scenario.json`,
      `ELEVENLABS_API_KEY="$(node ${K}/el-rotate.cjs get)" python ${S}/scripts/align.py ${V}/audio.json ${V}/audio ${V}/words.json`,
      `node ${S}/scripts/record.cjs ${V}/scenario.json`, `DEMO_FE=http://localhost:5287 node ${V}/record-api.cjs ${V}/scenario.json`, `node ${K}/el-rotate.cjs park`, `node ${K}/login-state.cjs 5287`,
      `playwright-cli -s=QRD-1346 open http://localhost:5287/ --config=${R}/.playwright/cli-5287.json`, `ffprobe ${V}/video/out/demo.mp4`, `mkdir -p ${V}/audio`,
      `rtk read ${S}/SKILL.md`, `cat ${R}/.evidence/QRD-1346/scripts/ac-1.js`, `ls ${V}/video/out`,
    ]) assert.equal(v(c), null, c);
    const denied = {
      'curl https://example.com': /not allowed for sous-video/, [`git -C ${R}/wt-1-fe push origin feat/QRD-1346-x`]: /not allowed for sous-video/, 'gh pr list': /not allowed/, 'ssh host': /not allowed/, 'env': /not allowed/, 'bash -c ls': /not allowed/,
      'node /tmp/x.js': /video folder or the demo-video skill/, 'node -e 1': /no flags/, [`node ${K}/el-rotate.cjs get`]: /prints the key/, [`node ${K}/status.cjs show QRD-1346`]: /video folder or the demo-video skill/,
      'rm -rf /tmp/x': /outside the video folder/, [`rm -rf ${R}/wt-1-fe`]: /outside the video folder/, [`cp ${V}/a.mp4 /tmp/a.mp4`]: /outside the video folder/, [`cp /etc/passwd ${V}/p`]: /outside the folders/,
      [`cd ${R}/wt-1-fe && npm i`]: /cd only into/, 'npm i': /inside the video folder only/, [`cd ${V}/video && npm i left-pad`]: /no package named/, [`cd ${V}/video && npx -y cowsay`]: /npx runs only/, [`cd ${V}/video && npx remotion render Demo /tmp/out.mp4`]: /outside the video folder/,
      [`cd ${V}/video && npm run dev`]: /only npm i or npm ci/, [`python -c "import os" ${S}/scripts/tts.py`]: /skill's scripts only/, [`python ${V}/x.py`]: /skill's scripts only/,
      [`ELEVENLABS_API_KEY="$(node ${K}/el-rotate.cjs get)" node ${V}/x.cjs`]: /only to the skill's tts.py and align.py/, [`ELEVENLABS_API_KEY="$(node /tmp/el-rotate.cjs get)" python ${S}/scripts/tts.py ${V}/s.json`]: /only comes from the kit/,
      [`ELEVENLABS_API_KEY="$(cat ${K}/x)" python ${S}/scripts/tts.py ${V}/s.json`]: /\$ and backticks/, [`python ${S}/scripts/tts.py ${V}/s.json | tee x`]: /operator/,
      'playwright-cli open https://example.com': /only opens localhost/, 'DEMO_FE=https://evil.io node x.cjs': /localhost/, [`NODE_OPTIONS=--require=x node ${V}/a.cjs`]: /not allowed here/, [`cat ${R}/wt-1-be/.env`]: /protected path|secret/,
      [`ffmpeg -i ${V}/a.webm /tmp/a.mp4`]: /outside/, 'mkdir -p /tmp/x': /outside/,
    };
    for (const [c, why] of Object.entries(denied)) assert.match(v(c) || '', why, c);
    assert.equal(g.check('video', roots, read('/etc/passwd')), null, 'video mode checks Bash only');
    assert.equal(g.check('path', ['@video', '@evidence'], write(`${V}/scenario.json`)), null);
    assert.equal(g.check('path', ['@video', '@evidence'], write(`${V}/video/src/demo.json`)), null);
    assert.match(g.check('path', ['@video', '@evidence'], write(`${V}/video/package.json`)) || '', /protected/);
    assert.match(g.check('path', ['@video', '@evidence'], write(`${R}/../qonflo-out/1021/notes.md`)) || '', /outside/);
    assert.equal(g.check('path', ['--read', '@video', '@skill'], read(`${S}/scripts/record.cjs`)), null);
  }
});

test('the hook command answers deny JSON, fails closed on bad input, and every sous agent wires it', async () => {
  const deny = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  let r = await runNode([path.join(KIT, 'sous-guard.cjs'), 'path', '@wt'], { input: JSON.stringify(write('E:\\qonflo\\wt-1-be\\package.json')), env: { QONFLO_ROOT: 'E:/qonflo', SOUS_GUARD_NOLOG: '1' } });
  if (process.platform === 'win32') assert.equal(deny(r), 'deny');
  r = await runNode([path.join(KIT, 'sous-guard.cjs'), 'path', '@wt'], { input: 'not json', env: { SOUS_GUARD_NOLOG: '1' } });
  assert.equal(deny(r), 'deny');
  r = await runNode([path.join(KIT, 'sous-guard.cjs'), 'bash', '@root'], { input: JSON.stringify({ tool_name: 'Read', tool_input: {} }) });
  assert.equal(r.stdout, '');

  const agents = path.join(KIT, '..', 'agents');
  const files = fs.readdirSync(agents).filter((f) => f.startsWith('sous-') || f === 'browser-verifier.md');
  assert.equal(files.length, 16);
  const form = /^ {10}command: '"\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/kit\/bin\/kit-node" sous-guard\.cjs (path|bash|runner|publish|jira|verify|browser|video)( [^']*)?'$/;
  for (const f of files) {
    const text = fs.readFileSync(path.join(agents, f), 'utf8');
    const head = text.split('\n---\n')[0];
    assert.match(head, new RegExp(`^---\\nname: ${f.replace('.md', '')}\\n`), f);
    assert.doesNotMatch(text, /\{\{/, `${f} has no template left`);
    const commands = head.split('\n').filter((l) => /^\s+command:/.test(l));
    assert.ok(commands.length, `${f} has guard hooks`);
    for (const c of commands) {
      assert.match(c, form, `${f}: ${c}`);
      if (!/--record'$/.test(c)) assert.match(c, /\|\| exit 2'$/, `${f} fails closed: ${c}`);
    }
  }
});

test('the frontmatter command runs through bash with the config dir and with the ~/.claude fallback', { skip: !fs.existsSync('/bin/bash') && !process.env.SHELL && process.platform !== 'win32' }, () => {
  const base = tmp('sous-hookform');
  try {
    const cfg = path.join(base, 'cfg');
    fs.cpSync(KIT, path.join(cfg, 'kit'), { recursive: true, filter: (src) => !/[\\/]tests([\\/]|$)/.test(src) });
    fs.chmodSync(path.join(cfg, 'kit', 'bin', 'kit-node'), 0o755);
    const line = fs.readFileSync(path.join(KIT, '..', 'agents', 'sous-ticket-worker.md'), 'utf8').split('\n').find((l) => / path @wt \|\| exit 2'$/.test(l));
    const cmd = line.trim().replace(/^command: '/, '').replace(/'$/, '');
    const input = JSON.stringify(write(`${'E:/qonflo'}/wt-1-be/package.json`));
    const run = (env) => {
      try { return { code: 0, out: execFileSync('bash', ['-c', cmd], { input, env: { ...process.env, QONFLO_ROOT: 'E:/qonflo', SOUS_GUARD_NOLOG: '1', ...env }, encoding: 'utf8', windowsHide: true }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; }
    };
    let r = run({ CLAUDE_CONFIG_DIR: cfg.replace(/\\/g, '/') });
    assert.equal(r.code, 0);
    assert.match(r.out, /"permissionDecision":"deny"/);
    fs.mkdirSync(path.join(base, 'home', '.claude'), { recursive: true });
    fs.cpSync(path.join(cfg, 'kit'), path.join(base, 'home', '.claude', 'kit'), { recursive: true });
    const env = { ...process.env, QONFLO_ROOT: 'E:/qonflo', SOUS_GUARD_NOLOG: '1', HOME: path.join(base, 'home').replace(/\\/g, '/') };
    delete env.CLAUDE_CONFIG_DIR;
    r = (() => { try { return { code: 0, out: execFileSync('bash', ['-c', cmd], { input, env, encoding: 'utf8', windowsHide: true }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } })();
    assert.match(r.out, /"permissionDecision":"deny"/);
    r = run({ CLAUDE_CONFIG_DIR: path.join(base, 'missing').replace(/\\/g, '/') });
    assert.equal(r.code, 2, 'a missing kit blocks the tool instead of letting it through');
  } finally {
    rmrf(base);
  }
});
