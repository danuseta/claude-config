'use strict';
// kit/agents.cjs: list/get/preview/put/delete of <config>/agents for DOCK's agent library, on a temp config dir with copies of repo agents.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createAgents, parse, hooksFor, hooksClosed, unifiedDiff, PROFILES } = require('../agents.cjs');
const { createSousGuard } = require('../sous-guard.cjs');
const { resolvePaths } = require('../paths.cjs');
const { KIT, tmp, rmrf } = require('./helpers.cjs');

const REPO = path.resolve(KIT, '..');

function setup(files = ['browser-verifier.md', 'sous-explorer.md', 'test-runner.md']) {
  const base = tmp('agents');
  const cfg = path.join(base, 'cfg');
  const kit = path.join(cfg, 'kit');
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.mkdirSync(kit, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(REPO, 'agents', f), path.join(cfg, 'agents', f));
  const lib = createAgents({ configDir: cfg, kitDir: kit, repoDir: REPO, home: base });
  return { base, cfg, kit, lib, file: (slug) => path.join(cfg, 'agents', `${slug}.md`), allow: () => { try { return JSON.parse(fs.readFileSync(path.join(kit, 'agents-allow.json'), 'utf8')); } catch { return null; } } };
}

const custom = (extra = {}) => ({ slug: 'my-reader', create: true, description: 'Reads the worktree: answers questions', model: 'sonnet', tools: ['Read', 'Bash'], body: 'You read.\n', guardProfile: 'read', dispatchable: true, ...extra });

test('list: kit agents from the repo, custom ones by elimination, sorted, locked as the contract says', () => {
  const t = setup();
  try {
    fs.writeFileSync(t.file('zz-mine'), '---\nname: zz-mine\ndescription: mine\ntools: Read\n---\n\nhello\n');
    fs.writeFileSync(path.join(t.cfg, 'agents', 'Bad_Name.md'), '---\nname: x\n---\n');
    const items = t.lib.list();
    assert.deepEqual(items.map((i) => i.slug), ['browser-verifier', 'sous-explorer', 'test-runner', 'zz-mine'], 'a file whose name is not a slug is left out');
    const by = Object.fromEntries(items.map((i) => [i.slug, i]));
    assert.deepEqual(Object.keys(by['browser-verifier']).sort(), ['description', 'dispatchable', 'guardProfile', 'hasHooks', 'locked', 'model', 'slug', 'source', 'tools']);
    assert.equal(by['browser-verifier'].source, 'kit');
    assert.equal(by['browser-verifier'].guardProfile, 'browser', 'browser-verifier hooks are the browser profile');
    assert.equal(by['browser-verifier'].dispatchable, true);
    assert.deepEqual(by['browser-verifier'].locked, { slug: true, tools: true, hooks: true });
    assert.equal(by['test-runner'].source, 'kit');
    assert.equal(by['test-runner'].hasHooks, false);
    assert.equal(by['test-runner'].guardProfile, null);
    assert.equal(by['zz-mine'].source, 'custom');
    assert.equal(by['zz-mine'].model, 'inherit');
    assert.deepEqual(by['zz-mine'].tools, ['Read']);
    assert.deepEqual(by['zz-mine'].locked, { slug: true, tools: false, hooks: true });
    assert.equal(by['zz-mine'].dispatchable, false);
  } finally { rmrf(t.base); }
});

test('the install record names kit agents and holds the kit body when the repo is not on the machine', () => {
  const t = setup([]);
  try {
    const shipped = '---\nname: shipped-one\ndescription: from the kit\ntools: Read\n---\n\nkit body\n';
    fs.writeFileSync(path.join(t.kit, 'agents-kit.json'), JSON.stringify({ repo: path.join(t.base, 'gone'), agents: { 'shipped-one': shipped } }));
    fs.writeFileSync(t.file('shipped-one'), shipped.replace('kit body', 'edited body'));
    const lib = createAgents({ configDir: t.cfg, kitDir: t.kit, repoDir: null, home: t.base });
    const g = lib.get({ slug: 'shipped-one' });
    assert.equal(g.source, 'kit');
    assert.equal(g.body, 'edited body\n');
    assert.equal(g.kitBody, 'kit body\n');
    assert.deepEqual(lib.delete({ slug: 'shipped-one' }), { ok: false, error: 'Kit agents cannot be deleted' });
  } finally { rmrf(t.base); }
});

test('get: body without frontmatter, hooksText read-only, kitBody for kit agents only, unknown slug refused', () => {
  const t = setup();
  try {
    const g = t.lib.get({ slug: 'browser-verifier' });
    assert.match(g.body, /^You verify acceptance criteria/);
    assert.match(g.hooksText, /^hooks:\n  PreToolUse:\n/);
    assert.equal(g.kitBody, g.body);
    assert.equal(g.hooksText, hooksFor('browser'));
    assert.throws(() => t.lib.get({ slug: 'nobody-here' }), /No agent named nobody-here/);
    assert.throws(() => t.lib.get({ slug: '../etc' }), /slug/);
    t.lib.put(custom());
    assert.equal(t.lib.get({ slug: 'my-reader' }).kitBody, null);
  } finally { rmrf(t.base); }
});

test('kit agents take body and model only; frontmatter and hooks stay byte for byte', () => {
  const t = setup();
  try {
    const before = fs.readFileSync(t.file('browser-verifier'), 'utf8');
    const g = t.lib.get({ slug: 'browser-verifier' });
    const base = { slug: g.slug, create: false, description: g.description, model: g.model, tools: g.tools, body: g.body, guardProfile: g.guardProfile, dispatchable: g.dispatchable };
    assert.equal(t.lib.preview(base).diff, '', 'nothing changed, nothing to diff');
    const r = t.lib.put({ ...base, model: 'opus', body: `${g.body}One more line.\n`, guardProfile: null, dispatchable: false });
    assert.equal(r.ok, true, r.error);
    assert.match(r.diff, /^-model: sonnet$/m);
    assert.match(r.diff, /^\+model: opus$/m);
    assert.match(r.diff, /^\+One more line\.$/m);
    const after = fs.readFileSync(t.file('browser-verifier'), 'utf8');
    assert.equal(after.split('\n---\n')[0], before.split('\n---\n')[0].replace('model: sonnet', 'model: opus'));
    assert.equal(parse(after).hooksText, parse(before).hooksText);
    for (const change of [{ tools: [...g.tools, 'Edit'] }, { description: 'Something else' }]) {
      assert.deepEqual(t.lib.put({ ...base, ...change }), { ok: false, error: 'Kit agents only take body and model changes' });
    }
    assert.deepEqual(t.lib.put({ ...base, create: true }), { ok: false, error: 'An agent named browser-verifier already exists' });
    assert.equal(t.lib.put({ ...base, slug: 'sous-planner', create: true }).ok, false, 'a kit name is never a custom agent');
    assert.match(t.lib.put(custom({ slug: 'sous-mine' })).error, /sous-mine is a kit agent name/, 'sous-* names belong to the kit');
    assert.equal(t.allow(), null, 'kit agents never touch agents-allow.json');
  } finally { rmrf(t.base); }
});

test('custom put: hooks generated from the profile, guard key, allowlist only when dispatchable', () => {
  const t = setup();
  try {
    const p = t.lib.preview(custom());
    assert.match(p.diff, /^--- \/dev\/null\n\+\+\+ b\/agents\/my-reader\.md\n@@ -0,0 \+1,\d+ @@/);
    assert.ok(p.checks.every((c) => typeof c.ok === 'boolean' && typeof c.text === 'string'));
    assert.ok(p.checks.some((c) => c.ok && /Hooks block generated from the read profile/.test(c.text)));
    assert.ok(p.checks.some((c) => c.ok && /agents-allow\.json/.test(c.text)));
    assert.ok(p.checks.some((c) => !c.ok && /Not run yet/.test(c.text)));
    assert.equal(fs.existsSync(t.file('my-reader')), false, 'preview writes nothing');

    const r = t.lib.put(custom());
    assert.equal(r.ok, true, r.error);
    assert.equal(r.diff, p.diff);
    const text = fs.readFileSync(t.file('my-reader'), 'utf8');
    assert.match(text, /^---\nname: my-reader\ndescription: "Reads the worktree: answers questions"\nmodel: sonnet\ntools: Read, Bash\nguard: read\nhooks:\n/);
    assert.ok(hooksClosed(parse(text).hooksText));
    for (const l of parse(text).hooksText.split('\n').filter((x) => /command:/.test(x))) {
      assert.match(l, /^ {10}command: '"\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/kit\/bin\/kit-node" sous-guard\.cjs (path|bash|browser)( [^']*)? \|\| exit 2'$/);
    }
    assert.deepEqual(t.allow(), ['my-reader']);
    const item = t.lib.list().find((i) => i.slug === 'my-reader');
    assert.equal(item.guardProfile, 'read');
    assert.equal(item.dispatchable, true);
    assert.deepEqual(t.lib.put(custom()), { ok: false, error: 'An agent named my-reader already exists' });

    assert.equal(t.lib.put(custom({ create: false, dispatchable: false })).ok, true);
    assert.deepEqual(t.allow(), []);
    assert.equal(t.lib.put(custom({ create: false, guardProfile: 'worktree', tools: ['Read', 'Edit', 'Write', 'Bash'], dispatchable: true })).ok, true);
    assert.match(fs.readFileSync(t.file('my-reader'), 'utf8'), /matcher: "Edit\|Write\|NotebookEdit"\n {6}hooks:\n {8}- type: command\n {10}command: '.* path @wt \|\| exit 2'/);
    assert.deepEqual(t.allow(), ['my-reader']);
  } finally { rmrf(t.base); }
});

test('a draft has no hooks, is never dispatchable and leaves the allowlist', () => {
  const t = setup();
  try {
    t.lib.put(custom());
    const p = t.lib.preview(custom({ create: false, guardProfile: null }));
    assert.ok(p.checks.some((c) => !c.ok && c.text === 'Draft: no guard profile, runners cannot dispatch it'));
    const r = t.lib.put(custom({ create: false, guardProfile: null, dispatchable: true }));
    assert.equal(r.ok, true, r.error);
    const text = fs.readFileSync(t.file('my-reader'), 'utf8');
    assert.doesNotMatch(text, /^hooks:|^guard:/m);
    assert.deepEqual(t.allow(), []);
    const item = t.lib.list().find((i) => i.slug === 'my-reader');
    assert.deepEqual([item.guardProfile, item.hasHooks, item.dispatchable], [null, false, false]);
  } finally { rmrf(t.base); }
});

test('custom put refuses tools outside the profile, bad slugs, models and empty tools', () => {
  const t = setup();
  try {
    assert.match(t.lib.put(custom({ tools: ['Read', 'Agent'] })).error, /Agent is not allowed for the read profile/);
    assert.match(t.lib.put(custom({ tools: ['Read', 'Write'] })).error, /Write is not allowed for the read profile/);
    assert.match(t.lib.put(custom({ guardProfile: null, tools: ['Agent'] })).error, /Agent is not allowed for a draft/);
    assert.match(t.lib.put(custom({ tools: ['Read', 'mcp__claude_ai_Atlassian__createJiraIssue'] })).error, /not allowed/);
    assert.equal(t.lib.put(custom({ tools: ['Read', 'mcp__claude_ai_Atlassian__getJiraIssue'] })).ok, true);
    assert.match(t.lib.put(custom({ slug: 'x2', tools: [] })).error, /at least one tool/);
    assert.match(t.lib.put(custom({ slug: 'x2', tools: ['Read, Write'] })).error, /Not a tool name/);
    assert.match(t.lib.put(custom({ slug: 'x2', model: 'gpt' })).error, /model must be one of/);
    assert.match(t.lib.put(custom({ slug: 'x2', guardProfile: 'root' })).error, /guardProfile must be one of/);
    assert.match(t.lib.put(custom({ slug: 'x2', description: '' })).error, /description is required/);
    for (const slug of ['../evil', 'A', 'Upper', 'a/b', '-lead']) assert.equal(t.lib.put(custom({ slug })).ok, false, slug);
    assert.match(t.lib.put(custom({ slug: 'x3', create: false })).error, /No agent named x3/);
    assert.deepEqual(fs.readdirSync(path.join(t.cfg, 'agents')).filter((f) => !f.endsWith('.md')), [], 'no temp file is left behind');
  } finally { rmrf(t.base); }
});

test('delete: custom only, drops the allowlist entry', () => {
  const t = setup();
  try {
    t.lib.put(custom());
    assert.deepEqual(t.lib.delete({ slug: 'browser-verifier' }), { ok: false, error: 'Kit agents cannot be deleted' });
    assert.deepEqual(t.lib.delete({ slug: 'nobody' }), { ok: false, error: 'No agent named nobody' });
    assert.deepEqual(t.lib.delete({ slug: 'my-reader' }), { ok: true });
    assert.equal(fs.existsSync(t.file('my-reader')), false);
    assert.deepEqual(t.allow(), []);
  } finally { rmrf(t.base); }
});

test('run: unknown op throws for the bridge to answer as an error', () => {
  const t = setup();
  try {
    assert.throws(() => t.lib.run('format', {}), /Unknown agent op format/);
    assert.ok(Array.isArray(t.lib.run('list', {})));
  } finally { rmrf(t.base); }
});

test('every profile hook fails closed, and the runner guard follows agents-allow.json only for files with hooks', () => {
  for (const p of Object.keys(PROFILES)) assert.ok(hooksClosed(hooksFor(p)), p);
  const t = setup([]);
  try {
    const paths = resolvePaths({ platform: 'win32', env: {}, kitDir: t.kit, local: { root: 'E:/qonflo', configDir: t.cfg } });
    const guard = createSousGuard({ platform: 'win32', paths, cwd: 'E:/qonflo' });
    const agent = (s) => ({ tool_name: 'Agent', tool_input: { subagent_type: s } });
    assert.match(guard.check('runner', ['@wt'], agent('my-reader')), /subagent type not allowed/);
    t.lib.put(custom());
    assert.equal(guard.check('runner', ['@wt'], agent('my-reader')), null);
    fs.writeFileSync(t.file('my-reader'), fs.readFileSync(t.file('my-reader'), 'utf8').replace(/^hooks:[\s\S]*?(?=\n---)/m, 'x: y'));
    assert.match(guard.check('runner', ['@wt'], agent('my-reader')), /subagent type not allowed/, 'listed but without hooks is refused');
    t.lib.put(custom({ slug: 'other-one', dispatchable: false }));
    assert.match(guard.check('runner', ['@wt'], agent('other-one')), /subagent type not allowed/, 'guarded but not dispatchable');
  } finally { rmrf(t.base); }
});

test('unifiedDiff: hunks with three lines of context', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n';
  const b = a.replace('l2\n', 'L2\n').replace('l17\n', '');
  const d = unifiedDiff(a, b, 'x.md');
  assert.equal(d, ['--- a/agents/x.md', '+++ b/agents/x.md', '@@ -1,6 +1,6 @@', ' l0', ' l1', '-l2', '+L2', ' l3', ' l4', ' l5', '@@ -15,6 +15,5 @@', ' l14', ' l15', ' l16', '-l17', ' l18', ' l19', ''].join('\n'));
  assert.equal(unifiedDiff(a, a, 'x.md'), '');
});
