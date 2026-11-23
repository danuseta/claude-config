'use strict';
// sous-guard.cjs judge: a Judge session is read-only (no git, gh or Jira write); reads pass; any other session is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkJudge, isJudgeSession } = require('../sous-guard.cjs');
const { KIT, tmp, rmrf, runNode, sandboxEnv } = require('./helpers.cjs');

const bash = (command) => checkJudge('Bash', { command });

test('git, gh and network writes are refused in a Judge session; reads pass', () => {
  for (const c of [
    'git push origin feat/QRD-1-x', 'rtk git commit -m "x"', 'git -C E:/qonflo/wt-1-be merge origin/develop', 'git fetch origin', 'git add kit/a.cjs',
    'git stash', 'git checkout -b x', 'git reset --hard', 'git branch -D x', 'git config user.name x', 'cd E:/qonflo && git rebase develop',
    'git status; git push', 'git log | head -5 && git tag v1', 'bash -c "git push origin x"', 'eval "git push"', 'echo $(git push)',
    'gh pr create --title x', 'gh pr merge 12', 'gh pr comment 12 --body x', 'gh issue create --title x', 'gh api repos/o/r/pulls/1/merge -X PUT',
    'gh api graphql -f query=mutation{x}', 'gh api repos/o/r/issues -f title=x', 'gh repo delete o/r',
    'curl -X POST https://acme.atlassian.net/rest/api/3/issue -d @x.json', 'curl --data "{}" https://acme.atlassian.net/rest/api/3/issue/QRD-1/transitions',
    'wget --post-data=x https://acme.atlassian.net/rest/api/3/issue', 'acli jira workitem transition --key QRD-1',
    'node K/status.cjs set QRD-1 stage=done', 'node "C:/x/kit/status.cjs" decide QRD-1 "x"', 'kit-node status.cjs finding QRD-1 "x"', 'rtk node /k/status.cjs render QRD-1',
    'node K/status.cjs lock verify QRD-1', 'node K/status.cjs checkpoint QRD-1 s "t"',
  ]) assert.match(bash(c) || '', /Judge session, which is read-only.*do not try it another way/, c);
  for (const c of [
    'git status', 'rtk git log --oneline -5', 'git -C E:/qonflo/wt-1-be diff develop...HEAD', 'git --no-pager show HEAD:kit/a.cjs', 'git blame kit/a.cjs',
    'gh pr view 12 --json state', 'gh pr list --state open', 'gh pr diff 12', 'gh issue view 7', 'gh api repos/o/r/pulls/1', 'gh api repos/o/r/pulls -X GET',
    'curl -s https://acme.atlassian.net/rest/api/3/issue/QRD-1', 'cat /tmp/in.md | head -40', 'node K/judge.cjs post /x/r.json', 'node K/retro.cjs post @/x/d.json',
    'rtk rg -n "BLOCKER" /tmp/in.md', 'echo "git push is what it did"',
    'node K/status.cjs', 'node K/status.cjs show QRD-1516', 'node K/status.cjs metrics', 'kit-node status.cjs remote', 'node K/paths.cjs --print',
  ]) assert.equal(bash(c), null, c);
});

test('Jira and Confluence writes through MCP are refused, reads pass; other MCP writes are refused too', () => {
  for (const t of ['mcp__claude_ai_Atlassian__editJiraIssue', 'mcp__atlassian__transitionJiraIssue', 'mcp__atlassian__addCommentToJiraIssue', 'mcp__claude_ai_Atlassian__createJiraIssue', 'mcp__atlassian__executeWrite', 'mcp__atlassian__updateConfluenceContent', 'mcp__github__merge_pull_request', 'mcp__github__create_issue']) {
    assert.match(checkJudge(t, {}) || '', /writes through .*Judge session/, t);
  }
  for (const t of ['mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql', 'mcp__atlassian__getConfluenceContent', 'mcp__atlassian__executeRead', 'mcp__serena__find_symbol', 'Read', 'Write']) {
    assert.equal(checkJudge(t, {}), null, t);
  }
});

test('a Judge session is DOCK_JUDGE=1, or a transcript whose first prompt is the Judge prompt', () => {
  const dir = tmp('judge-transcript');
  try {
    const line = (o) => JSON.stringify(o);
    const judge = path.join(dir, 'judge.jsonl'), work = path.join(dir, 'work.jsonl');
    fs.writeFileSync(judge, [line({ type: 'summary' }), line({ type: 'user', isMeta: true, message: { content: 'hook context' } }), line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Pakai skill judge: session a3c23286 input /tmp/in.md until -' }] } }), line({ type: 'user', message: { content: 'lanjut' } })].join('\n'));
    fs.writeFileSync(work, [line({ type: 'user', message: { content: 'Pakai skill sous. Kerjakan QRD-1' } }), line({ type: 'user', message: { content: 'Pakai skill judge: session x input y until -' } })].join('\n'));
    assert.equal(isJudgeSession({ transcript_path: judge }, {}), true);
    assert.equal(isJudgeSession({ transcript_path: work }, {}), false, 'only the first prompt counts');
    assert.equal(isJudgeSession({ transcript_path: path.join(dir, 'none.jsonl') }, {}), false);
    assert.equal(isJudgeSession({}, { DOCK_JUDGE: '1' }), true);
  } finally {
    rmrf(dir);
  }
});

test('the hook: denies a git write in a Judge session, says nothing for reads and for every other session', async () => {
  const dir = tmp('judge-hook');
  try {
    const env = { ...sandboxEnv(dir), SOUS_GUARD_NOLOG: '1', DOCK_JUDGE: '' };
    const hook = (payload, extra = {}) => runNode([path.join(KIT, 'sous-guard.cjs'), 'judge'], { env: { ...env, ...extra }, input: JSON.stringify(payload) });
    let r = await hook({ tool_name: 'Bash', tool_input: { command: 'git push origin x' } }, { DOCK_JUDGE: '1' });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.deepEqual([out.permissionDecision, /git push is not a read/.test(out.permissionDecisionReason)], ['deny', true]);
    r = await hook({ tool_name: 'mcp__atlassian__editJiraIssue', tool_input: {} }, { DOCK_JUDGE: '1' });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    r = await hook({ tool_name: 'Bash', tool_input: { command: 'git log -3' } }, { DOCK_JUDGE: '1' });
    assert.equal(r.stdout, '');
    r = await hook({ tool_name: 'Bash', tool_input: { command: 'git push origin x' } });
    assert.equal(r.stdout, '', 'not a Judge session: this mode stays out of the way');
    r = await runNode([path.join(KIT, 'sous-guard.cjs'), 'judge'], { env, input: 'not json' });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'unreadable input fails closed');
  } finally {
    rmrf(dir);
  }
});

test('the settings hook: Linux runs node only when DOCK_JUDGE=1; Windows runs the guard, which passes other sessions', async (t) => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(KIT, '..', 'settings', f), 'utf8'));
  const cmds = (s) => (s.hooks.PreToolUse || []).filter((e) => e.matcher === 'Bash|PowerShell|mcp__.*').flatMap((e) => e.hooks.map((h) => h.command));
  const linux = '[ "$DOCK_JUDGE" = 1 ] || exit 0; {{kit:sous-guard.cjs judge}} || exit 2';
  assert.deepEqual(cmds(read('settings.linux.json')), [linux]);
  assert.deepEqual(cmds(read('settings.windows.json')), ['{{kit:sous-guard.cjs judge}} || exit 2']);
  assert.deepEqual(cmds(read('settings.base.json')), [], 'not in the base, so each system gets its own form');
  const bashOk = require('child_process').spawnSync('bash', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
  if (!bashOk) return t.skip('no bash');
  const dir = tmp('judge-gate');
  try {
    const fwd = (p) => p.split(path.sep).join('/');
    const marker = fwd(path.join(dir, 'node-ran'));
    const rendered = linux.replace('{{kit:sous-guard.cjs judge}}', `echo x > "${marker}"; "${fwd(process.execPath)}" "${fwd(path.join(KIT, 'sous-guard.cjs'))}" judge`);
    const run = (judge) => require('child_process').spawnSync('bash', ['-c', rendered], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin x' } }), encoding: 'utf8', env: { ...process.env, ...sandboxEnv(dir), SOUS_GUARD_NOLOG: '1', DOCK_JUDGE: judge }, windowsHide: true });
    let r = run('');
    assert.deepEqual([r.status, r.stdout, fs.existsSync(marker)], [0, '', false], 'no Judge flag: node is never started');
    r = run('1');
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(fs.existsSync(marker));
  } finally {
    rmrf(dir);
  }
});
