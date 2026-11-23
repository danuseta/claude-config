'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmp, rmrf, KIT } = require('./helpers.cjs');

const SCRIPT = path.join(KIT, 'qa-skill-sync.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeSource(root) {
  git(root, 'init', '-q', '-b', 'main');
  for (const [tag, marker] of [['v1.0.4', 'four'], ['v1.0.5', 'five'], ['v1.0.10', 'ten'], ['v2-draft', 'draft']]) {
    write(root, 'skill/skill-qonflo-qa/SKILL.md', `skill ${marker}`);
    write(root, 'skill/skill-qonflo-qa/judge.md', `base judge ${marker}`);
    write(root, 'skill/skill-qonflo-qa/scripts/compute-verdict.mjs', `verdict ${marker}`);
    write(root, 'skill-v2/skill-qonflo-qa/planner.md', `planner ${marker}`);
    write(root, 'skill-v2/skill-qonflo-qa/judge.md', `v2 judge ${marker}`);
    write(root, 'skill-v2/skill-qonflo-qa/scripts/plan-check.mjs', `plan-check ${marker}`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', marker);
    git(root, 'tag', tag);
  }
}

function setup() {
  const base = tmp('qa-sync');
  const source = path.join(base, 'source');
  fs.mkdirSync(source);
  makeSource(source);
  const env = {
    ...process.env,
    QA_SYNC_SOURCE: source,
    QA_SYNC_SKILLS_DIR: path.join(base, 'skills'),
    QA_SYNC_CACHE: path.join(base, 'cache'),
    QA_SYNC_PIN_FILE: path.join(base, 'qa-release-pin'),
  };
  const s = { base, source, env, dest: path.join(base, 'skills', 'skill-qonflo-qa') };
  s.run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: s.env, timeout: 120000 });
  s.read = (rel) => fs.readFileSync(path.join(s.dest, rel), 'utf8');
  s.tag = () => s.read('VERSION').split(' ')[0];
  return s;
}

test('installs the newest vX.Y.Z tag, v2 files over the base skill, and writes VERSION', () => {
  const s = setup();
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    const [tag, commit] = s.read('VERSION').trim().split(' ');
    assert.equal(tag, 'v1.0.10');
    assert.equal(commit, git(s.source, 'rev-parse', '--short', 'v1.0.10'));
    assert.equal(s.read('SKILL.md'), 'skill ten');
    assert.equal(s.read('planner.md'), 'planner ten');
    assert.equal(s.read('judge.md'), 'v2 judge ten');
    assert.equal(s.read('scripts/compute-verdict.mjs'), 'verdict ten');
    assert.equal(s.read('scripts/plan-check.mjs'), 'plan-check ten');
    assert.ok(fs.existsSync(path.join(s.base, 'cache', 'v1.0.10', 'skill')));
  } finally { rmrf(s.base); }
});

test('does nothing when VERSION already names the target tag', () => {
  const s = setup();
  try {
    s.run();
    write(s.dest, 'SKILL.md', 'local edit');
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already installed/);
    assert.equal(s.read('SKILL.md'), 'local edit');
  } finally { rmrf(s.base); }
});

test('a pin file wins over the newest tag, and clearing it moves back to the newest', () => {
  const s = setup();
  try {
    fs.writeFileSync(s.env.QA_SYNC_PIN_FILE, 'v1.0.4\n');
    assert.equal(s.run().status, 0);
    assert.equal(s.tag(), 'v1.0.4');
    assert.equal(s.read('planner.md'), 'planner four');
    fs.writeFileSync(s.env.QA_SYNC_PIN_FILE, '\n');
    assert.equal(s.run().status, 0);
    assert.equal(s.tag(), 'v1.0.10');
  } finally { rmrf(s.base); }
});

test('--daily skips while the last pass is recent; a manual run does not', () => {
  const s = setup();
  try {
    s.run('--daily');
    assert.equal(s.tag(), 'v1.0.10');
    git(s.source, 'tag', 'v1.1.0');
    s.run('--daily');
    assert.equal(s.tag(), 'v1.0.10');
    s.run();
    assert.equal(s.tag(), 'v1.1.0');
  } finally { rmrf(s.base); }
});

test('an unknown pin or an unreachable source keeps the installed files and exits 0', () => {
  const s = setup();
  try {
    s.run();
    fs.writeFileSync(s.env.QA_SYNC_PIN_FILE, 'v9.9.9\n');
    const r = s.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /fetch of v9.9.9 failed/);
    assert.equal(s.tag(), 'v1.0.10');
    fs.writeFileSync(s.env.QA_SYNC_PIN_FILE, '');
    s.env.QA_SYNC_SOURCE = path.join(s.base, 'missing');
    const r2 = s.run();
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /could not list the tags/);
    assert.equal(s.tag(), 'v1.0.10');
  } finally { rmrf(s.base); }
});

test('--status changes nothing', () => {
  const s = setup();
  try {
    const r = s.run('--status');
    assert.match(r.stdout, /installed none, target v1\.0\.10/);
    assert.equal(fs.existsSync(s.dest), false);
  } finally { rmrf(s.base); }
});
