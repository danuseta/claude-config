'use strict';
// Every machine-specific path and setting of the kit, resolved in one place.
//   node paths.cjs --print     JSON of the values below, forward slashes, for shell scripts
// Windows gives the values the kit has always used; Linux gives the Coder workspace values.
// kit.local.json next to this file (not in the repo) may override any key.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  win32: {
    root: 'E:/qonflo',
    protectedPorts: ['3000', '3001', '5173'],
    ticketPortBase: { be: 3100, fe: 5200 },
  },
  linux: {
    root: '/home/coder/projects',
    protectedPorts: ['3000', '5173', '5174', '5000', '3100', '13337', '13339', '8099', '27017', '6379', '1055'],
    ticketPortBase: { be: 3200, fe: 5300 },
  },
};

const fwd = (p) => String(p).replace(/\\/g, '/');
const slugOf = (root) => root.replace(/[^A-Za-z0-9]/g, '-');

function readLocal(kitDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(kitDir, 'kit.local.json'), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

// platform, env, kitDir and local are inputs so both operating systems can be resolved on either one.
function resolvePaths({ platform = process.platform, env = process.env, kitDir = __dirname, local } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const base = win ? DEFAULTS.win32 : DEFAULTS.linux;
  const over = local || readLocal(kitDir);
  const root = over.root || env.QONFLO_ROOT || base.root;
  const configDir = over.configDir || fwd(env.CLAUDE_CONFIG_DIR || P.dirname(kitDir));
  const out = {
    root,
    evidence: over.evidence || `${root}/.evidence`,
    repos: { be: `${root}/ms-admin-worker-backend`, fe: `${root}/ms-client-dashboard-frontend`, ...(over.repos || {}) },
    github: { ...(over.github || {}) },
    bases: over.bases || ['develop'],
    kitDir,
    configDir,
    sessionsDir: over.sessionsDir || P.join(configDir, 'projects', slugOf(root)),
    protectedPorts: over.protectedPorts || base.protectedPorts.slice(),
    ticketPortBase: { ...base.ticketPortBase, ...(over.ticketPortBase || {}) },
  };
  return out;
}

module.exports = { resolvePaths, slugOf };

if (require.main === module) {
  if (process.argv.includes('--print')) {
    const p = resolvePaths();
    const norm = (v) => (typeof v === 'string' ? fwd(v) : v);
    const printable = { ...p, kitDir: fwd(p.kitDir), configDir: fwd(p.configDir), sessionsDir: fwd(p.sessionsDir), root: norm(p.root), evidence: norm(p.evidence), repos: { be: fwd(p.repos.be), fe: fwd(p.repos.fe) } };
    process.stdout.write(JSON.stringify(printable, null, 2) + '\n');
  } else {
    console.log('usage: paths.cjs --print');
  }
}
