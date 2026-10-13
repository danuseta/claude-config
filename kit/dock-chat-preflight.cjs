'use strict';
// What a DOCK chat turn must have before claude starts: rtk runnable, the rtk hook in settings.json, the caveman plugin enabled and installed.
//   node dock-chat-preflight.cjs    prints the problems of this machine's profile, exit 1 when there are any
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CAVEMAN = 'caveman@caveman';
const RTK_HOOK = 'rtk hook claude';
const CAVEMAN_HOOK = 'src/hooks/caveman-activate.js';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

function rtkRuns(env) {
  return spawnSync('rtk', ['--version'], { env, windowsHide: true, timeout: 10000 }).status === 0;
}

// The problems of the profile claude would run with under `env`; an empty list means the turn may run.
function problems(env, { runs = rtkRuns } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settings = readJson(path.join(dir, 'settings.json'));
  const installed = (readJson(path.join(dir, 'plugins', 'installed_plugins.json')).plugins || {})[CAVEMAN] || [];
  const hooks = ((settings.hooks || {}).PreToolUse || []).flatMap((entry) => entry.hooks || []);
  const found = [];
  if (!runs(env)) found.push('rtk is not runnable from the bridge PATH');
  if (!hooks.some((hook) => String(hook.command).includes(RTK_HOOK))) found.push(`the "${RTK_HOOK}" PreToolUse hook is missing in ${dir}/settings.json`);
  if ((settings.enabledPlugins || {})[CAVEMAN] !== true) found.push(`the ${CAVEMAN} plugin is not enabled in ${dir}/settings.json`);
  if (!installed.some((plugin) => fs.existsSync(path.join(String(plugin.installPath), CAVEMAN_HOOK)))) found.push(`the ${CAVEMAN} plugin is not installed`);
  return found;
}

module.exports = { problems };

if (require.main === module) {
  const found = problems(process.env);
  console.log(found.length ? found.join('\n') : 'ok');
  process.exit(found.length ? 1 : 0);
}
