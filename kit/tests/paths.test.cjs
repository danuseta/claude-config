'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../paths.cjs');
const { KIT, runNode } = require('./helpers.cjs');

const WIN_KIT = 'C:\\Users\\danus\\.claude-kantor\\kit';
const LINUX_KIT = '/home/coder/.claude/kit';
const win = (extra = {}) => resolvePaths({ platform: 'win32', env: {}, kitDir: WIN_KIT, local: {}, ...extra });
const linux = (extra = {}) => resolvePaths({ platform: 'linux', env: {}, kitDir: LINUX_KIT, local: {}, ...extra });

test('Windows values are today\'s literals', () => {
  const p = win();
  assert.equal(p.root, 'E:/qonflo');
  assert.equal(p.evidence, 'E:/qonflo/.evidence');
  assert.deepEqual(p.repos, { be: 'E:/qonflo/ms-admin-worker-backend', fe: 'E:/qonflo/ms-client-dashboard-frontend' });
  assert.equal(p.kitDir, WIN_KIT);
  assert.equal(p.configDir, 'C:/Users/danus/.claude-kantor');
  assert.equal(p.sessionsDir, path.win32.join(WIN_KIT, '..', 'projects', 'E--qonflo'));
  assert.deepEqual(p.protectedPorts, ['3000', '3001', '5173']);
  assert.deepEqual(p.ticketPortBase, { be: 3100, fe: 5200 });
});

test('Linux gets the workspace values', () => {
  const p = linux();
  assert.equal(p.root, '/home/coder/projects');
  assert.equal(p.evidence, '/home/coder/projects/.evidence');
  assert.deepEqual(p.repos, { be: '/home/coder/projects/ms-admin-worker-backend', fe: '/home/coder/projects/ms-client-dashboard-frontend' });
  assert.equal(p.kitDir, LINUX_KIT);
  assert.equal(p.configDir, '/home/coder/.claude');
  assert.equal(p.sessionsDir, '/home/coder/.claude/projects/-home-coder-projects');
  assert.deepEqual(p.protectedPorts, ['3000', '5173', '5174', '5000', '3100', '13337', '13339', '8099', '27017', '6379', '1055']);
  assert.deepEqual(p.ticketPortBase, { be: 3200, fe: 5300 });
});

test('QONFLO_ROOT and CLAUDE_CONFIG_DIR override on both systems', () => {
  const l = linux({ env: { QONFLO_ROOT: '/srv/work', CLAUDE_CONFIG_DIR: '/srv/cfg' } });
  assert.equal(l.root, '/srv/work');
  assert.equal(l.evidence, '/srv/work/.evidence');
  assert.equal(l.configDir, '/srv/cfg');
  assert.equal(l.sessionsDir, '/srv/cfg/projects/-srv-work');
  const w = win({ env: { QONFLO_ROOT: 'D:/code' } });
  assert.equal(w.evidence, 'D:/code/.evidence');
  assert.equal(w.sessionsDir, path.win32.join(WIN_KIT, '..', 'projects', 'D--code'));
});

test('kit.local.json style overrides win over the defaults', () => {
  const p = linux({ local: { ticketPortBase: { be: 3900 }, protectedPorts: ['1'] } });
  assert.deepEqual(p.ticketPortBase, { be: 3900, fe: 5300 });
  assert.deepEqual(p.protectedPorts, ['1']);
  assert.deepEqual([p.github, p.bases], [{}, ['develop']], 'no GitHub names by default; develop is the only PR base');
  const o = linux({ local: { github: { be: 'o/be' }, bases: ['develop', 'feat/V1-Playbook'] } });
  assert.deepEqual([o.github, o.bases], [{ be: 'o/be' }, ['develop', 'feat/V1-Playbook']]);
});

test('--print contract: JSON of the F.1 keys with forward slashes', async () => {
  const r = await runNode([path.join(KIT, 'paths.cjs'), '--print'], { env: { QONFLO_ROOT: '', CLAUDE_CONFIG_DIR: '' } });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['bases', 'configDir', 'evidence', 'github', 'kitDir', 'protectedPorts', 'repos', 'root', 'sessionsDir', 'ticketPortBase']);
  assert.ok(!/\\/.test(r.stdout.replace(/\\n/g, '')), 'no backslash in the printed paths');
  assert.deepEqual(Object.keys(out.repos), ['be', 'fe']);
  assert.deepEqual(Object.keys(out.ticketPortBase), ['be', 'fe']);
});
