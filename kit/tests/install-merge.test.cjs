'use strict';
// install/install.cjs: the scope-allow hook merges once and stays last; Linux drops the rm ask rule, Windows keeps it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, rmrf, runNode } = require('./helpers.cjs');

const INSTALL = path.join(__dirname, '..', '..', 'install', 'install.cjs');
const install = (os, dir, mode = '--apply') => runNode([INSTALL, '--os', os, '--config-dir', dir, '--secrets-file', path.join(dir, 'none.env'), mode], { cwd: dir });
const settings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
const commands = (s) => s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));

// Each run copies the whole kit and skills, so both systems run at the same time.
test('install: scope-allow is merged once and last, a second run changes nothing, only Linux drops rm from ask', async () => {
  await Promise.all(['linux', 'windows'].map(async (os) => {
    const dir = tmp(`install-${os}`);
    try {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(rm:*)', 'Bash(rtk rm:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
      assert.equal((await install(os, dir)).code, 0);
      const first = settings(dir);
      assert.equal((await install(os, dir)).code, 0);
      assert.equal((await install(os, dir, '--check')).code, 0, 'nothing pending after the second run');
      const second = settings(dir);
      assert.deepEqual(second, first);
      const cmds = commands(second);
      assert.equal(cmds.filter((c) => /scope-allow\.cjs/.test(c)).length, 1);
      const last = second.hooks.PreToolUse[second.hooks.PreToolUse.length - 1];
      assert.equal(last.matcher, '*');
      assert.match(last.hooks[0].command, /scope-allow\.cjs"?$/);
      assert.ok(cmds.includes('mine'), 'an entry of the owner is kept');
      assert.ok(cmds.some((c) => /guard\.cjs.*\|\| exit 2$/.test(c)));
      const { ask, deny } = second.permissions;
      if (os === 'linux') {
        assert.ok(!ask.includes('Bash(rm:*)') && !ask.includes('Bash(rtk rm:*)'), 'Linux drops rm from ask, also from an earlier install');
      } else {
        assert.ok(ask.includes('Bash(rm:*)'), 'Windows keeps rm in ask');
      }
      for (const rule of ['Bash(rtk gh pr merge:*)', 'Bash(rtk gh pr close:*)', 'Bash(gh pr merge:*)']) assert.ok(ask.includes(rule), rule);
      for (const rule of ['Bash(git push origin main:*)', 'Bash(rtk git push origin main:*)', 'Bash(rtk git add -A:*)']) assert.ok(deny.includes(rule), rule);
      assert.equal(second.permissionsRemove, undefined);
    } finally { rmrf(dir); }
  }));
});
