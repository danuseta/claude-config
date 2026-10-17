'use strict';
// dev-server.cjs starts the command detached with its output in <folder>-<port>.log and returns at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, runNode, waitFor, sandboxEnv } = require('./helpers.cjs');

test('the server output lands in the DOCK log for its worktree and port, and the call returns at once', async () => {
  const base = tmp('dev-server');
  const projects = path.join(base, 'projects');
  const worktree = path.join(projects, 'wt-qrd-1363', 'backend');
  const logs = path.join(base, 'logs');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const env = { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_PROJECTS_DIR: projects, DOCK_DEV_LOG_DIR: logs };
  try {
    const script = 'console.log("listening on " + process.env.PORT)';
    const started = Date.now();
    const r = await runNode([path.join(KIT, 'dev-server.cjs'), '3263', '--', process.execPath, '-e', script], { env, cwd: worktree });
    assert.ok(Date.now() - started < 5000, 'the call does not wait for the server');
    const log = path.join(logs, 'wt-qrd-1363-3263.log');
    assert.match(r.stdout, /started .* on port 3263 \(pid \d+\); log .*wt-qrd-1363-3263\.log/);
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('listening on 3263'));
    assert.doesNotMatch(r.stdout, /listening on 3263/, 'the server output does not come back to the caller');

    const bad = await runNode([path.join(KIT, 'dev-server.cjs'), 'abc', '--', 'npm'], { env, cwd: worktree });
    assert.match(bad.stderr, /usage/);
    assert.equal(bad.code, 1);
  } finally {
    // Windows keeps the folder while the server process is still closing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmrf(base);
  }
});
