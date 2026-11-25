'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'linux', 'personalize.sh');
const hasBash = (() => { try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// The repo step's functions, from track_branch up to install_pinned, run against a throwaway origin and checkout.
function repoStep() {
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('track_branch()'));
  const end = lines.findIndex((l) => l.startsWith('install_pinned()'));
  return lines.slice(start, end).join('\n');
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=stable', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfg-repo-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, seed);
  fs.mkdirSync(path.join(seed, 'agents'));
  fs.writeFileSync(path.join(seed, 'agents', 'video.md'), 'step 1\nstep 2 old\nstep 3\n');
  fs.writeFileSync(path.join(seed, 'versions.env'), 'A=1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'push', '-q', 'origin', 'HEAD:stable');
  git(root, 'clone', '-q', '-b', 'stable', origin, repo);
  return { root, seed, repo, local: path.join(root, 'local') };
}

function run({ repo, local }) {
  const body = `${repoStep()}\nnote() { echo "NOTE $*"; }\nCCFG_LOCAL_DIR="$3"\ns_repo; echo "RC $?"`;
  return execFileSync('bash', ['-c', `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false; CCFG_REPO="$1"; CCFG_BRANCH=stable; DRY=0; ${body}`, 'x', repo, 'stable', local], { encoding: 'utf8' });
}

test('a pull keeps local edits: clean ones stay, a conflict takes upstream and keeps a .local copy', { skip: !hasBash }, () => {
  const s = setup();
  fs.writeFileSync(path.join(s.repo, 'agents', 'video.md'), 'step 1\nstep 2 local\nstep 3\n');
  fs.writeFileSync(path.join(s.repo, 'versions.env'), 'A=1\nFFMPEG=1\n');
  fs.writeFileSync(path.join(s.seed, 'agents', 'video.md'), 'step 1\nstep 2 new\nstep 3\n');
  fs.mkdirSync(path.join(s.seed, 'skills'));
  fs.writeFileSync(path.join(s.seed, 'skills', 'SKILL.md'), 'upstream skill\n');
  fs.mkdirSync(path.join(s.repo, 'skills'));
  fs.writeFileSync(path.join(s.repo, 'skills', 'SKILL.md'), 'local skill\n');
  git(s.seed, 'commit', '-q', '-am', 'two');
  git(s.seed, 'add', '.');
  git(s.seed, 'commit', '-q', '-m', 'three');
  git(s.seed, 'push', '-q', 'origin', 'HEAD:stable');

  const out = run(s);
  assert.match(out, /RC 0/);
  assert.match(out, /local edits kept, upstream wins on .*agents\/video\.md/);
  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), git(s.seed, 'rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(path.join(s.repo, 'agents', 'video.md'), 'utf8'), 'step 1\nstep 2 new\nstep 3\n');
  assert.equal(fs.readFileSync(path.join(s.local, 'agents', 'video.md.local'), 'utf8'), 'step 1\nstep 2 local\nstep 3\n');
  assert.equal(fs.readFileSync(path.join(s.repo, 'versions.env'), 'utf8'), 'A=1\nFFMPEG=1\n', 'a clean local edit stays in place');
  assert.equal(fs.readFileSync(path.join(s.repo, 'skills', 'SKILL.md'), 'utf8'), 'upstream skill\n');
  assert.equal(fs.readFileSync(path.join(s.local, 'skills', 'SKILL.md.local'), 'utf8'), 'local skill\n');
  assert.equal(git(s.repo, 'diff', '--name-only', '--diff-filter=U'), '');
  assert.equal(git(s.repo, 'stash', 'list'), '');

  const again = run(s);
  assert.match(again, /RC 0/);
  assert.match(again, /already up to date/);
  assert.equal(fs.readFileSync(path.join(s.repo, 'versions.env'), 'utf8'), 'A=1\nFFMPEG=1\n', 'the next pass keeps the edit again');
});

test('a checkout without local edits pulls as before', { skip: !hasBash }, () => {
  const s = setup();
  fs.writeFileSync(path.join(s.seed, 'versions.env'), 'A=2\n');
  git(s.seed, 'commit', '-q', '-am', 'two');
  git(s.seed, 'push', '-q', 'origin', 'HEAD:stable');
  const out = run(s);
  assert.match(out, /RC 0/);
  assert.match(out, /NOTE updated/);
  assert.doesNotMatch(out, /local edits kept/);
  assert.equal(fs.readFileSync(path.join(s.repo, 'versions.env'), 'utf8'), 'A=2\n');
});
