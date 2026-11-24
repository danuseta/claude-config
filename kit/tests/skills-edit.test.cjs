'use strict';
// kit/skills-edit.cjs and the Guild Master skill ops of gm.cjs: only text files under <config>/skills, atomic writes, and no write
// without DOCK's nonce, with a backup and a log entry that rolls back.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSkills, normalize } = require('../skills-edit.cjs');
const { createGm, sha256, skillPutSha, resolveSha } = require('../gm.cjs');
const { libraryJob } = require('../dock-chat.cjs');
const { tmp, rmrf } = require('./helpers.cjs');

const KEY = 'k'.repeat(64);
const SKILL = '---\r\nname: review-message\r\n---\r\n\r\n4. at most 2 per blocker and 10 per message\r\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function setup() {
  const base = tmp('skills');
  const cfg = path.join(base, 'cfg');
  const file = path.join(cfg, 'skills', 'review-message', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'kit'), { recursive: true });
  fs.writeFileSync(file, SKILL);
  const nonces = new Map();
  const settings = { confirm: async (c) => { const n = c && nonces.get(c.nonce); if (!n || n !== c.sha256) throw new Error('DOCK did not confirm'); nonces.delete(c.nonce); return { ok: true }; } };
  const mint = (sha) => { const nonce = crypto.randomBytes(8).toString('hex'); nonces.set(nonce, sha); return nonce; };
  const gm = createGm({ stateDir: base, configDir: cfg, kitDir: path.join(cfg, 'kit'), evidence: path.join(base, 'ev') });
  return { base, cfg, file, gm, settings, mint, skills: createSkills({ configDir: cfg }), done: () => rmrf(base) };
}

test('skills-edit: paths outside skills, .., absolute, links, binaries, other types and large files are refused', () => {
  const t = setup();
  try {
    for (const bad of ['../agents/x.md', 'review-message/../../kit/guard.cjs', '/etc/passwd', 'C:/x/SKILL.md', 'review-message/run.py', 'SKILL.md', 'review-message/./SKILL.md', 'review-message/SKILL.md.kit-new', '']) {
      assert.throws(() => normalize(bad), Error, bad);
    }
    assert.equal(normalize('skills\\review-message\\SKILL.md'), 'review-message/SKILL.md', 'a leading skills/ and backslashes are normalized');
    assert.equal(t.skills.put({ path: 'review-message/lexicon.json', text: 'a\u0000b' }).ok, false, 'no NUL byte');
    assert.match(t.skills.put({ path: 'review-message/big.md', text: 'x'.repeat(100 * 1024 + 1) }).error, /100 KB/);
    assert.match(t.skills.put({ path: 'nope/SKILL.md', text: 'x' }).error, /No skill folder/);
    fs.writeFileSync(path.join(t.cfg, 'skills', 'review-message', 'blob.txt'), Buffer.from([1, 0, 2]));
    assert.throws(() => t.skills.get({ path: 'review-message/blob.txt' }), /binary/);
    const target = path.join(t.base, 'outside');
    fs.mkdirSync(target);
    let linked = true;
    try { fs.symlinkSync(target, path.join(t.cfg, 'skills', 'linked'), 'junction'); } catch { linked = false; }
    if (linked) {
      assert.match(t.skills.put({ path: 'linked/SKILL.md', text: 'x' }).error, /link/);
      assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), false);
      assert.ok(!t.skills.list().some((f) => f.path.startsWith('linked/')), 'list skips links');
    }
    assert.throws(() => t.skills.run('put', { path: 'review-message/SKILL.md', text: 'x' }), /Unknown skill op/, 'the bridge hands out no write');
  } finally { t.done(); }
});

test('skills-edit: preview writes nothing; put is atomic, keeps CRLF and returns the diff', () => {
  const t = setup();
  try {
    const next = SKILL.replace(/\r\n/g, '\n').replace('at most 2', 'at most 1');
    const p = t.skills.preview({ path: 'review-message/SKILL.md', text: next });
    assert.match(p.diff, /^--- a\/skills\/review-message\/SKILL\.md\n\+\+\+ b\/skills\/review-message\/SKILL\.md\n/);
    assert.match(p.diff, /-4\. at most 2 per blocker/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), SKILL, 'preview wrote nothing');
    const r = t.skills.put({ path: 'review-message/SKILL.md', text: next });
    assert.deepEqual(r, { ok: true, diff: p.diff });
    assert.equal(fs.readFileSync(t.file, 'utf8'), next.replace(/\n/g, '\r\n'));
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)).filter((f) => f.endsWith('.tmp')), [], 'no tmp file is left');
    assert.deepEqual(t.skills.list().map((f) => f.path), ['review-message/SKILL.md']);
    assert.equal(libraryJob({ op: 'skill-get', input: { path: 'review-message/SKILL.md' } }, { configDir: t.cfg }).text, next.replace(/\n/g, '\r\n'));
  } finally { t.done(); }
});

test('gm: propose-skill waits for DOCK, the ya writes with a backup and a log entry, and rollback restores it', async () => {
  const t = setup();
  try {
    const c = t.gm.proposeSkill('gm-1', 'review-message/SKILL.md', { find: b64('at most 2 per blocker'), replace: b64('at most 1 per blocker') });
    assert.equal(c.type, 'skill');
    assert.match(c.diff, /\+4\. at most 1 per blocker/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), SKILL, 'a proposal writes nothing');
    assert.throws(() => t.gm.proposeSkill('gm-1', 'review-message/SKILL.md', { find: b64('nowhere'), replace: b64('x') }), /not in skills/);
    assert.throws(() => t.gm.proposeSkill('gm-1', '../kit/guard.cjs', { find: b64('x'), replace: b64('y') }), /\.\./);
    t.gm.proposeSkill('gm-1', 'review-message/SKILL.md', { find: b64('at most 2 per blocker'), replace: b64('at most 1 per blocker') });
    const sha = sha256(t.gm.pendingRaw('gm-1'));
    const refused = await t.gm.apply({ sessionId: 'gm-1', gmConfirm: { nonce: 'made-up', sha256: sha, exp: Date.now() + 60000 }, key: KEY, settings: t.settings });
    assert.equal(refused.ok, false, 'no nonce DOCK minted, no write');
    assert.equal(fs.readFileSync(t.file, 'utf8'), SKILL);
    t.gm.proposeSkill('gm-1', 'review-message/SKILL.md', { find: b64('at most 2 per blocker'), replace: b64('at most 1 per blocker') });
    const sha2 = sha256(t.gm.pendingRaw('gm-1'));
    const r = await t.gm.apply({ sessionId: 'gm-1', gmConfirm: { nonce: t.mint(sha2), sha256: sha2, exp: Date.now() + 60000 }, key: KEY, settings: t.settings });
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(t.file, 'utf8'), SKILL.replace('at most 2', 'at most 1'));
    assert.equal(r.entry.type, 'skill');
    assert.equal(r.entry.path, 'review-message/SKILL.md');
    assert.equal(t.gm.backupBytes(r.entry.backup).toString('utf8'), SKILL);
    const back = await t.gm.rollback({ id: r.entry.id, key: KEY, settings: t.settings, confirm: { sessionId: null, nonce: t.mint(`rollback:${r.entry.id}`), sha256: `rollback:${r.entry.id}` } });
    assert.equal(back.ok, true, back.error);
    assert.equal(fs.readFileSync(t.file, 'utf8'), SKILL);
  } finally { t.done(); }
});

test('gm: a stale proposal is refused, and the owner save needs a nonce for that exact text', async () => {
  const t = setup();
  try {
    t.gm.proposeSkill('gm-1', 'review-message/SKILL.md', { find: b64('at most 2'), replace: b64('at most 3') });
    fs.writeFileSync(t.file, `${SKILL}more\r\n`);
    const sha = sha256(t.gm.pendingRaw('gm-1'));
    const r = await t.gm.apply({ sessionId: 'gm-1', gmConfirm: { nonce: t.mint(sha), sha256: sha, exp: Date.now() + 60000 }, key: KEY, settings: t.settings });
    assert.match(r.error, /changed since the proposal/);
    const text = 'edited by the owner\n';
    const wrong = await t.gm.putSkill({ path: 'review-message/SKILL.md', text, settings: t.settings, key: KEY, nonce: t.mint(skillPutSha('review-message/SKILL.md', 'other text')) });
    assert.equal(wrong.ok, false, 'a nonce for other text writes nothing');
    assert.equal((await t.gm.putSkill({ path: 'review-message/SKILL.md', text, settings: t.settings, key: KEY })).ok, false, 'no nonce');
    const ok = await t.gm.putSkill({ path: 'review-message/SKILL.md', text, settings: t.settings, key: KEY, nonce: t.mint(skillPutSha('review-message/SKILL.md', text)) });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(fs.readFileSync(t.file, 'utf8'), text.replace(/\n/g, '\r\n'));
    assert.equal(ok.entry.by, 'owner (skill editor)');
  } finally { t.done(); }
});

test('gm: an install conflict resolved from DOCK is logged with a backup; an agent merge keeps the kit hooks and tools', async () => {
  const t = setup();
  try {
    const agent = (body, tools = 'Read') => `---\nname: sous-x\ndescription: d\nmodel: sonnet\ntools: ${tools}\n---\n\n${body}\n`;
    const write = (rel, text) => { const f = path.join(t.cfg, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    write('agents/sous-x.md', agent('local body'));
    write('agents/sous-x.md.kit-new', agent('kit body'));
    write('kit/.base/agents/sous-x.md', agent('base body'));
    write('kit/merge-report.json', JSON.stringify({ at: 'x', merged: [], kept: [], conflicts: [{ path: 'agents/sous-x.md', kitNew: 'agents/sous-x.md.kit-new' }] }));
    const bad = agent('merged body', 'Read, Bash');
    const refused = await t.gm.resolveConflict({ path: 'agents/sous-x.md', action: 'edit', text: bad, settings: t.settings, key: KEY, nonce: t.mint(resolveSha('agents/sous-x.md', 'edit', bad)) });
    assert.match(refused.error, /tools/);
    const merged = agent('merged body');
    assert.equal((await t.gm.resolveConflict({ path: 'agents/sous-x.md', action: 'edit', text: merged, settings: t.settings, key: KEY, nonce: t.mint(resolveSha('agents/sous-x.md', 'kit', null)) })).ok, false, 'a nonce for another action writes nothing');
    const r = await t.gm.resolveConflict({ path: 'agents/sous-x.md', action: 'edit', text: merged, settings: t.settings, key: KEY, nonce: t.mint(resolveSha('agents/sous-x.md', 'edit', merged)) });
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(path.join(t.cfg, 'agents', 'sous-x.md'), 'utf8'), merged);
    assert.equal(fs.existsSync(path.join(t.cfg, 'agents', 'sous-x.md.kit-new')), false);
    assert.equal(fs.readFileSync(path.join(t.cfg, 'kit', '.base', 'agents', 'sous-x.md'), 'utf8'), agent('kit body'));
    assert.deepEqual(r.report.conflicts, []);
    assert.equal(r.entry.type, 'agent');
    assert.equal(t.gm.backupBytes(r.entry.backup).toString('utf8'), agent('local body'));
  } finally { t.done(); }
});

test('guard: a gm session may run the skill ops with base64 snippets; cli prints the file with line numbers', () => {
  const { createGuard, answer } = require('../guard.cjs');
  const { resolvePaths } = require('../paths.cjs');
  const { cli } = require('../gm.cjs');
  const guard = createGuard({ platform: 'linux', paths: resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} }), env: { DOCK_GM: '1' }, home: '/home/coder' });
  const decide = (command) => { const out = answer(command, '/home/coder/projects', { guard, env: { DOCK_GM: '1' }, cfg: { softUntil: '2999-01-01' }, log: false }); return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'; };
  const K = '/home/coder/.claude/kit';
  assert.equal(decide(`node ${K}/gm.cjs skill review-message/SKILL.md`), 'allow');
  assert.equal(decide(`node ${K}/gm.cjs propose-skill review-message/SKILL.md --find ${b64('at most 2 per <b>')} --replace ${b64('at most "1"')}`), 'allow');
  assert.equal(decide(`node ${K}/gm.cjs propose-skill ../kit/guard.cjs --find eA== --replace eQ==`), 'deny');
  const t = setup();
  try {
    const lines = [];
    cli(['skill', 'review-message/SKILL.md'], { gm: t.gm, env: { DOCK_GM_SESSION: 'gm-1' }, out: (s) => lines.push(s) });
    assert.match(lines[0], /^skills\/review-message\/SKILL\.md\n {3}1 {2}---\n/);
    cli(['propose-skill', 'review-message/SKILL.md', '--find', b64('2 per'), '--replace', b64('1 per')], { gm: t.gm, env: { DOCK_GM_SESSION: 'gm-1' }, out: (s) => lines.push(s) });
    assert.match(lines[1], /Nothing is written until the owner answers "ya"/);
  } finally { t.done(); }
});
