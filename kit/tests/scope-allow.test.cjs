'use strict';
// kit/scope-allow.cjs: DOCK turns get an allow for work inside the qonflo folder, nothing for the machine; deny from guard.cjs still wins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../paths.cjs');
const { createScopeAllow, ALLOW } = require('../scope-allow.cjs');
const { createGuard, answer } = require('../guard.cjs');
const { KIT, tmp, rmrf, runNode } = require('./helpers.cjs');

const HOME = '/home/coder';
const ROOT = '/home/coder/projects';
const WT = `${ROOT}/wt-1387-be`;
const linuxPaths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
const winPaths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:/Users/danus/.claude-kantor/kit', local: {} });
const linux = createScopeAllow({ platform: 'linux', paths: linuxPaths, home: HOME });
const win = createScopeAllow({ platform: 'win32', paths: winPaths, home: 'C:/Users/danus' });
const bash = (command, cwd = ROOT) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const file = (tool, file_path, cwd = ROOT) => ({ tool_name: tool, cwd, tool_input: { file_path } });

test('allows file tools inside the root, a worktree, a dated folder, evidence and qonflo-out', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit']) {
    for (const p of [`${WT}/src/a.ts`, `${ROOT}/1021/qrd-1/shot.png`, `${ROOT}/.evidence/blackboard/QRD-1/prompts/S1.md`, `${HOME}/qonflo-out/1021/QRD-1/video/a.json`, 'src/a.ts']) {
      assert.equal(linux.decide(file(tool, p, WT)), true, `${tool} ${p}`);
    }
  }
  assert.equal(linux.decide({ tool_name: 'NotebookEdit', cwd: ROOT, tool_input: { notebook_path: `${WT}/n.ipynb` } }), true);
  assert.equal(win.decide(file('Edit', 'E:\\qonflo\\wt-1-be\\src\\a.ts', 'E:/qonflo')), true);
  assert.equal(win.decide(file('Edit', '/e/qonflo/wt-1-be/src/a.ts', 'E:/qonflo')), true);
});

test('no answer for file tools outside the root, on .git or the project settings, or writes to the config dir', () => {
  for (const p of ['/etc/passwd', `${HOME}/.claude/settings.json`, `${HOME}/.claude/kit/guard.cjs`, `${HOME}/.ssh/id_rsa`, `${WT}/../../x`, `${WT}/.git/config`, `${ROOT}/.claude/settings.json`, `${ROOT}/.claude/settings.local.json`]) {
    assert.equal(linux.decide(file('Edit', p)), false, p);
  }
  assert.equal(linux.decide(file('Read', `${HOME}/.claude/kit/guard.cjs`)), true, 'reading the kit is allowed');
  assert.equal(linux.decide(file('Read', `${HOME}/.claude/skills/x/SKILL.md`)), true);
  assert.equal(linux.decide(file('Read', `${HOME}/.claude/settings.json`)), false);
  assert.equal(linux.decide({ tool_name: 'Edit', cwd: ROOT, tool_input: {} }), false);
});

test('allows ordinary Bash work inside the root', () => {
  for (const c of ['rtk rg x src', 'rtk proxy rg x src', `cd ${WT} && npm test`, `cd ${WT} && timeout 120 npx vitest run src/a.test.ts`, 'rtk git status', 'git add src/a.ts', 'git push -u origin feat/QRD-1-x',
    'rtk gh pr create --base develop --head feat/QRD-1-x', 'rm -rf node_modules dist/', 'npm test 2>&1 | tail -n 20', `rtk read ${HOME}/.claude/kit/status.cjs`, 'NODE_ENV=test npx jest src/a.test.ts', 'ls > /dev/null', 'git commit -m "fix ssh retry"']) {
    assert.equal(linux.decide(bash(c, WT)), true, c);
  }
  assert.equal(win.decide(bash('rtk rg x src', 'E:\\qonflo\\wt-1-be')), true);
  assert.equal(win.decide(bash('cd /e/qonflo/wt-1-be && npm test', 'E:/qonflo')), true);
});

test('no answer for the machine, paths outside the root, nested shells and expansion', () => {
  for (const c of ['coder ssh danu', 'rtk proxy ssh x', 'ssh host', 'scp a host:b', 'sudo ls', 'tailscale status', 'docker ps', 'systemctl restart x', 'rtk sudo ls', 'npx docker ps', 'ccfg doctor',
    'cat /etc/passwd', `ls ${HOME}/.claude`, `cat ${HOME}/.claude/settings.json`, 'cat ~/.bashrc', `rtk rg x ${HOME}/.claude/projects`, `cp ${HOME}/.claude/kit/a.cjs x`, 'cd /tmp && ls', 'cd ../.. && ls', 'git -C /tmp status', 'echo x > /tmp/a',
    'bash -c "ls"', 'sh -c ls', 'eval ls', 'pwsh -Command ls', 'echo $(whoami)', 'echo `id`', 'ls $HOME', 'echo "a $(id)"', '(cd /tmp; ls)', 'cat <<EOF', 'source ./x.sh', '. ./x.sh', 'echo "unterminated']) {
    assert.equal(linux.decide(bash(c, WT)), false, c);
  }
  assert.equal(linux.decide(bash('ls', '/tmp')), false, 'a cwd outside the root');
  assert.equal(win.decide(bash('ls', 'C:/Users/danus')), false);
});

test('allows the work tools and the read MCP tools, nothing else', () => {
  for (const t of ['Skill', 'Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'WebSearch', 'mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__atlassian__searchConfluenceUsingCql', 'mcp__figma__get_screenshot', 'mcp__figma__get_design_context']) {
    assert.equal(linux.decide({ tool_name: t, cwd: ROOT, tool_input: {} }), true, t);
  }
  for (const t of ['mcp__claude_ai_Atlassian__editJiraIssue', 'mcp__claude_ai_Atlassian__createJiraIssue', 'mcp__figma__use_figma', 'mcp__coder__coder_workspace_bash', 'WebFetch', 'Glob']) {
    assert.equal(linux.decide({ tool_name: t, cwd: ROOT, tool_input: {} }), false, t);
  }
});

test('the hook prints the allow only with DOCK_CHAT_TURN=1, and nothing on bad input', async () => {
  const dir = tmp('scope-allow');
  try {
    const script = path.join(KIT, 'scope-allow.cjs');
    const root = resolvePaths().root;
    const input = JSON.stringify({ tool_name: 'Edit', cwd: root, tool_input: { file_path: `${root}/wt-1-be/src/a.ts` } });
    const on = await runNode([script], { env: { DOCK_CHAT_TURN: '1' }, input, cwd: dir });
    assert.equal(on.code, 0);
    assert.equal(on.stdout, ALLOW);
    assert.deepEqual(JSON.parse(on.stdout).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'inside qonflo' });
    const off = await runNode([script], { env: { DOCK_CHAT_TURN: '' }, input, cwd: dir });
    assert.equal(off.code, 0);
    assert.equal(off.stdout, '');
    for (const bad of ['not json', '', '{"tool_name":']) {
      const r = await runNode([script], { env: { DOCK_CHAT_TURN: '1' }, input: bad, cwd: dir });
      assert.equal(r.code, 0, JSON.stringify(bad));
      assert.equal(r.stdout, '');
    }
    const ssh = await runNode([script], { env: { DOCK_CHAT_TURN: '1' }, input: JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: 'coder ssh danu' } }), cwd: dir });
    assert.equal(ssh.stdout, '');
  } finally { rmrf(dir); }
});

test('the hook never denies: no output of it carries a deny', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(KIT, 'scope-allow.cjs'), 'utf8'), /permissionDecision:\s*"deny"/);
});

// Claude Code takes deny over ask over allow across all hooks and settings rules, so a guard deny wins over this allow.
test('deny still wins: guard.cjs denies what scope-allow grants inside the root', () => {
  const guard = createGuard({ platform: 'linux', paths: linuxPaths, env: { DOCK_CHAT_TURN: '1' }, home: HOME });
  for (const c of ['git push origin main', 'rtk git push origin develop', 'git add .', 'rm -rf ~/projects', `rm -rf ${WT}`, `rm -rf ${ROOT}/ms-admin-worker-backend`]) {
    assert.equal(linux.decide(bash(c, ROOT)), true, `scope-allow grants ${c}`);
    const out = answer(c, ROOT, { guard, env: { DOCK_CHAT_TURN: '1' }, cfg: {}, log: false });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny', c);
  }
  const base = JSON.parse(fs.readFileSync(path.join(KIT, '..', 'settings', 'settings.base.json'), 'utf8'));
  for (const rule of ['Bash(git push origin main:*)', 'Bash(rtk git push origin main:*)', 'Bash(git add .:*)', 'Bash(rtk git push -f:*)']) assert.ok(base.permissions.deny.includes(rule), rule);
});

test('settings: scope-allow is the last PreToolUse entry of the base, matcher *', () => {
  const base = JSON.parse(fs.readFileSync(path.join(KIT, '..', 'settings', 'settings.base.json'), 'utf8'));
  const last = base.hooks.PreToolUse[base.hooks.PreToolUse.length - 1];
  assert.equal(last.matcher, '*');
  assert.deepEqual(last.hooks.map((h) => h.command), ['{{kit:scope-allow.cjs}}']);
});
