'use strict';
// kit/kit-merge.cjs and its use in install/install.cjs: local skill and agent edits survive an install, a conflict keeps local and writes
// <file>.kit-new, locked paths always take the kit version, and no git means keep local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mergeable, mergeFile, writeReport, createKitMerge } = require('../kit-merge.cjs');
const { tmp, rmrf, runNode } = require('./helpers.cjs');

const REL = 'skills/review-message/SKILL.md';
const BASE = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n';

function setup() {
  const dir = tmp('kit-merge');
  const cfg = path.join(dir, 'cfg');
  const src = path.join(dir, 'repo', 'SKILL.md');
  const dst = path.join(cfg, ...REL.split('/'));
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const base = path.join(cfg, 'kit', '.base', ...REL.split('/'));
  const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  const read = (f) => fs.readFileSync(f, 'utf8');
  const run = (opts = {}) => mergeFile({ src, dst, rel: REL, configDir: cfg, apply: true, ...opts });
  return { dir, cfg, src, dst, base, write, read, run, done: () => rmrf(dir) };
}

test('kit-merge: no base yet overwrites as before and records the base', () => {
  const t = setup();
  try {
    t.write(t.dst, 'my edit\n');
    t.write(t.src, BASE);
    assert.equal(t.run().action, 'installed');
    assert.equal(t.read(t.dst), BASE);
    assert.equal(t.read(t.base), BASE);
  } finally { t.done(); }
});

test('kit-merge: local equal to base takes the new kit and moves the base', () => {
  const t = setup();
  try {
    t.write(t.base, BASE);
    t.write(t.dst, BASE.replace(/\n/g, '\r\n'));
    t.write(t.src, BASE.replace('line 7', 'line 7 kit'));
    assert.equal(t.run().action, 'updated', 'a CRLF copy of the base counts as untouched');
    assert.equal(t.read(t.dst), BASE.replace('line 7', 'line 7 kit'));
    assert.equal(t.read(t.base), BASE.replace('line 7', 'line 7 kit'));
  } finally { t.done(); }
});

test('kit-merge: a local edit the kit did not touch is kept', () => {
  const t = setup();
  try {
    t.write(t.base, BASE);
    t.write(t.dst, BASE.replace('line 2', 'line 2 local'));
    t.write(t.src, BASE);
    assert.equal(t.run().action, 'kept');
    assert.equal(t.read(t.dst), BASE.replace('line 2', 'line 2 local'));
    assert.equal(t.read(t.base), BASE);
  } finally { t.done(); }
});

test('kit-merge: edits on different lines merge cleanly and the base becomes the kit version', () => {
  const t = setup();
  try {
    const kit = BASE.replace('line 7', 'line 7 kit');
    t.write(t.base, BASE);
    t.write(t.dst, BASE.replace('line 1', 'line 1 local'));
    t.write(t.src, kit);
    assert.equal(t.run().action, 'merged');
    assert.equal(t.read(t.dst), BASE.replace('line 1', 'line 1 local').replace('line 7', 'line 7 kit'));
    assert.equal(t.read(t.base), kit);
    assert.equal(fs.existsSync(`${t.dst}.kit-new`), false);
  } finally { t.done(); }
});

test('kit-merge: edits on the same line leave local untouched, write .kit-new and keep the old base', () => {
  const t = setup();
  try {
    const local = BASE.replace('line 4', 'line 4 local');
    const kit = BASE.replace('line 4', 'line 4 kit');
    t.write(t.base, BASE);
    t.write(t.dst, local);
    t.write(t.src, kit);
    const r = t.run();
    assert.equal(r.action, 'conflict');
    assert.match(r.reason, /same lines/);
    assert.equal(t.read(t.dst), local);
    assert.equal(t.read(`${t.dst}.kit-new`), kit);
    assert.equal(t.read(t.base), BASE);
    assert.equal(t.run().action, 'conflict', 'the next install reports it again');
  } finally { t.done(); }
});

test('kit-merge: without git a changed file keeps local and gets .kit-new', () => {
  const t = setup();
  try {
    const local = BASE.replace('line 1', 'line 1 local');
    t.write(t.base, BASE);
    t.write(t.dst, local);
    t.write(t.src, BASE.replace('line 7', 'line 7 kit'));
    const r = t.run({ git: path.join(t.dir, 'no-such-git') });
    assert.equal(r.action, 'conflict');
    assert.match(r.reason, /git unavailable/);
    assert.equal(t.read(t.dst), local);
    assert.equal(t.read(`${t.dst}.kit-new`), BASE.replace('line 7', 'line 7 kit'));
  } finally { t.done(); }
});

test('kit-merge: only skills and agent markdown merge; guards, the allow-list, settings, hooks and linux never do', () => {
  for (const rel of ['skills/a/SKILL.md', 'skills/a/lexicon.json', 'skills/a/scripts/run.py', 'agents/sous-verifier.md']) assert.equal(mergeable(rel), true, rel);
  for (const rel of ['kit/guard.cjs', 'kit/guard.json', 'kit/sous-guard.cjs', 'kit/agents-allow.json', 'settings/settings.base.json', 'settings.json', 'skills/a/hooks/pre.sh', 'linux/personalize.sh', 'agents/x/y.md', 'agents/a.json', 'skills/a/logo.png', 'skills/../kit/guard.cjs', 'skills/a/SKILL.md.kit-new', 'install/install.cjs']) {
    assert.equal(mergeable(rel), false, rel);
  }
});

test('kit-merge: the report lists merged, kept and conflicts; DOCK reads it and resolves a conflict', () => {
  const t = setup();
  try {
    t.write(t.base, BASE);
    t.write(t.dst, BASE.replace('line 4', 'line 4 local'));
    t.write(t.src, BASE.replace('line 4', 'line 4 kit'));
    const r = t.run();
    writeReport(t.cfg, [r, { action: 'merged', rel: 'skills/b/SKILL.md' }, { action: 'kept', rel: 'agents/sous-verifier.md' }, { action: 'same', rel: 'skills/c/SKILL.md' }]);
    const lib = createKitMerge({ configDir: t.cfg });
    const rep = lib.report();
    assert.deepEqual(rep.merged.map((m) => m.path), ['skills/b/SKILL.md']);
    assert.deepEqual(rep.kept.map((m) => m.path), ['agents/sous-verifier.md']);
    assert.deepEqual(rep.conflicts.map((m) => [m.path, m.kitNew]), [[REL, `${REL}.kit-new`]]);
    const f = lib.run('file', { path: REL });
    assert.equal(f.local, BASE.replace('line 4', 'line 4 local'));
    assert.equal(f.kit, BASE.replace('line 4', 'line 4 kit'));
    assert.match(f.merged, /<<<<<<< local[\s\S]*>>>>>>> kit/);
    assert.throws(() => lib.resolvePlan({ path: REL, action: 'edit', text: f.merged }), /conflict markers/);
    assert.throws(() => lib.run('file', { path: 'skills/b/SKILL.md' }), /no open conflict/);
    assert.throws(() => lib.run('file', { path: 'kit/guard.cjs' }), /Not a skill or agent file/);
    const after = lib.resolveCommit(lib.resolvePlan({ path: REL, action: 'kit' }));
    assert.equal(t.read(t.dst), BASE.replace('line 4', 'line 4 kit'));
    assert.equal(t.read(t.base), BASE.replace('line 4', 'line 4 kit'));
    assert.equal(fs.existsSync(`${t.dst}.kit-new`), false);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.resolved.map((x) => [x.path, x.action]), [[REL, 'kit']]);
  } finally { t.done(); }
});

// One real install into a temp config dir: a locked kit file is overwritten, a conflicting skill edit is kept with .kit-new.
const INSTALL = path.join(__dirname, '..', '..', 'install', 'install.cjs');
const REPO = path.join(__dirname, '..', '..');
test('install: a second install keeps a local skill edit, reports a conflict, and still overwrites a locked kit file', async () => {
  const dir = tmp('install-merge3');
  const install = () => runNode([INSTALL, '--os', 'linux', '--config-dir', dir, '--secrets-file', path.join(dir, 'none.env'), '--apply'], { cwd: dir });
  try {
    assert.equal((await install()).code, 0);
    const skill = fs.readdirSync(path.join(REPO, 'skills')).find((d) => fs.existsSync(path.join(REPO, 'skills', d, 'SKILL.md')) && d !== 'synced');
    const rel = `skills/${skill}/SKILL.md`;
    const local = path.join(dir, ...rel.split('/'));
    const kitText = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(fs.readFileSync(path.join(dir, 'kit', '.base', ...rel.split('/')), 'utf8'), kitText, 'the first install records the base');
    fs.writeFileSync(local, `${kitText}\nmy local line\n`);
    // Pretend the kit changed the end of the same file since: the base differs from the kit at the same place as the local edit.
    fs.writeFileSync(path.join(dir, 'kit', '.base', ...rel.split('/')), `${kitText}\nold kit line\n`);
    fs.writeFileSync(path.join(dir, 'kit', 'guard.cjs'), '// edited\n');
    const out = await install();
    assert.equal(out.code, 0);
    assert.match(out.stdout, new RegExp(`conflict +${rel.replace(/[.]/g, '\\.')}`));
    assert.equal(fs.readFileSync(local, 'utf8'), `${kitText}\nmy local line\n`, 'local stays');
    assert.equal(fs.readFileSync(`${local}.kit-new`, 'utf8').replace(/\r\n/g, '\n'), kitText);
    assert.notEqual(fs.readFileSync(path.join(dir, 'kit', 'guard.cjs'), 'utf8'), '// edited\n', 'a guard is never merged');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'kit', 'merge-report.json'), 'utf8'));
    assert.deepEqual(report.conflicts.map((c) => c.path), [rel]);
    assert.equal((await runNode([INSTALL, '--os', 'linux', '--config-dir', dir, '--secrets-file', path.join(dir, 'none.env'), '--check'], { cwd: dir })).code, 0, 'a reported conflict is not pending again');
  } finally { rmrf(dir); }
});
