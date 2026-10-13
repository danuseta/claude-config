'use strict';
const crypto = require('crypto');
const { spawn: nodeSpawn } = require('child_process');
const { maskString } = require('./dock-push.cjs');

const MAX_COMMANDS = 2000;
const MAX_MODELS = 40;
const MAX_BYTES = 300 * 1024;
const POST_BYTES = 512 * 1024;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 100;
const HINT_MAX = 60;
const LABEL_MAX = 80;
const VALUE_MAX = 80;
const EFFORT_MAX = 40;
const EFFORTS_MAX = 10;
const PROBE_TIMEOUT_MS = 15000;
const PROBE_STDOUT_MAX = 4 * 1024 * 1024;
const OPTIONS_BAR_COMMANDS = new Set(['model', 'effort', 'fast']);

const clean = (value, max, extra) => {
  if (typeof value !== 'string') return '';
  const text = maskString(value, { masked: 0, blobs: 0 }, extra).replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
};

const serverKeeps = (value, max, extra) => {
  if (typeof value !== 'string' || !value) return false;
  const masked = maskString(value.slice(0, max * 2), { masked: 0, blobs: 0 }, extra).replace(/\s+/g, ' ').trim().slice(0, max);
  return masked === value;
};

function compactCatalog(initializeResponse, terminalCommands, { extra = [] } = {}) {
  const raw = initializeResponse && typeof initializeResponse === 'object' ? initializeResponse : {};
  const hidden = new Set([...OPTIONS_BAR_COMMANDS, ...(Array.isArray(terminalCommands) ? terminalCommands.map(String) : [])]);
  const seen = new Set();
  const commands = [];
  for (const c of Array.isArray(raw.commands) ? raw.commands : []) {
    if (!c || typeof c.name !== 'string') continue;
    const name = c.name.replace(/\s+/g, '').slice(0, NAME_MAX);
    if (!name || hidden.has(name) || hidden.has(c.name) || seen.has(name) || !serverKeeps(name, NAME_MAX, extra)) continue;
    seen.add(name);
    commands.push({ name, description: clean(c.description, DESCRIPTION_MAX, extra), argumentHint: clean(c.argumentHint, HINT_MAX, extra), kind: c.builtin === true ? 'builtin' : 'skill' });
  }
  commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const models = [];
  for (const m of Array.isArray(raw.models) ? raw.models : []) {
    if (!m || !serverKeeps(m.value, VALUE_MAX, extra)) continue;
    const efforts = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => serverKeeps(e, EFFORT_MAX, extra)).slice(0, EFFORTS_MAX) : [];
    models.push({ value: m.value, label: clean(typeof m.displayName === 'string' && m.displayName ? m.displayName : m.value, LABEL_MAX, extra), efforts, fast: m.supportsFastMode === true });
  }
  models.length = Math.min(models.length, MAX_MODELS);
  const fast = {
    available: typeof raw.fast_mode_state === 'string' && raw.fast_mode_state !== 'off',
    reason: typeof raw.fast_mode_disabled_reason === 'string' ? clean(raw.fast_mode_disabled_reason, LABEL_MAX, extra) || null : null,
  };
  commands.length = Math.min(commands.length, MAX_COMMANDS);
  const size = () => Buffer.byteLength(JSON.stringify({ commands, models, fast }));
  while (commands.length && size() > MAX_BYTES) commands.length = Math.floor(commands.length * 0.9);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ commands, models, fast })).digest('hex');
  return { hash, commands, models, fast };
}

function stop(child) {
  try {
    const { killTree } = require('./dock-chat.cjs');
    killTree(child);
  } catch {
    try { child.kill(); } catch {}
  }
}

function probeCatalog(claude, opts = {}, { spawn = nodeSpawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child, timer, done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child) {
        try { child.stdin.end(); } catch {}
        const late = setTimeout(() => stop(child), 2000);
        late.unref();
        child.once('exit', () => clearTimeout(late));
      }
      resolve(value);
    };
    try {
      const args = [...(claude.prefix || []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
      if (opts.fast === true) args.push('--settings', '{"fastMode":true}');
      child = spawn(claude.cmd, args, { cwd: opts.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    timer = setTimeout(() => { stop(child); finish(null); }, opts.timeoutMs || PROBE_TIMEOUT_MS);
    const requestId = `catalog-${crypto.randomBytes(6).toString('hex')}`;
    let buffer = '', seen = 0;
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      seen += chunk.length;
      if (seen > PROBE_STDOUT_MAX) { stop(child); return finish(null); }
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.type === 'control_response' && msg.response && msg.response.request_id === requestId) {
          return finish(msg.response.subtype === 'success' && msg.response.response && typeof msg.response.response === 'object' ? msg.response.response : null);
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: null } })}\n`);
    } catch {
      finish(null);
    }
  });
}

async function publishCatalog(catalog, call) {
  if (!catalog || typeof catalog.hash !== 'string') return false;
  const body = { hash: catalog.hash, commands: catalog.commands, models: catalog.models, fast: catalog.fast };
  if (Buffer.byteLength(JSON.stringify(body)) > POST_BYTES) return false;
  try {
    const r = await call('/chat/catalog', body, 15000);
    return Boolean(r) && !r.skipped && r.status === 200 && r.ok !== false;
  } catch {
    return false;
  }
}

module.exports = { compactCatalog, probeCatalog, publishCatalog };
