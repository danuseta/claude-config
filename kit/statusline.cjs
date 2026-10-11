'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PUSH_EVERY_MS = 30 * 1000;

// Catppuccin Frappe, the palette of the oh-my-posh theme in use; the theme file's own palette wins when it has these keys.
const COLORS = { blue: '#8CAAEE', lavender: '#BABBF1', os: '#ACB0BE', pink: '#F4B8E4', green: '#A6D189', yellow: '#E5C890', red: '#E78284' };
try {
  const theme = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.poshtheme.omp.json'), 'utf8'));
  for (const [name, value] of Object.entries(theme.palette || {})) {
    if (name in COLORS && /^#[0-9a-f]{6}$/i.test(value)) COLORS[name] = value;
  }
} catch (e) {}

function paint(name, text) {
  const hex = COLORS[name];
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
  return '\x1b[38;2;' + rgb + 'm' + text + '\x1b[0m';
}
const byLevel = (pct, text) => paint(pct < 40 ? 'green' : pct <= 70 ? 'yellow' : 'red', text);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function tokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm' : m + 'm';
}

function resetAt(epochSeconds, withDay) {
  const d = new Date(epochSeconds * 1000);
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return withDay ? ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][d.getDay()] + ' ' + time : time;
}

// The caveman plugin's badge, same rules as its caveman-statusline.ps1: flag file under the config dir, no links, 64 bytes at most, known modes only.
const CAVEMAN_MODES = ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra', 'commit', 'review', 'compress'];
function caveman() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const small = (file) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || stat.size > 64) throw new Error('refused');
    return fs.readFileSync(file, 'utf8');
  };
  const mode = small(path.join(dir, '.caveman-active')).split(/\r?\n/)[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!CAVEMAN_MODES.includes(mode)) return '';
  let badge = mode === 'full' ? '[CAVEMAN]' : '[CAVEMAN:' + mode.toUpperCase() + ']';
  if (process.env.CAVEMAN_STATUSLINE_SAVINGS !== '0') {
    try {
      const savings = small(path.join(dir, '.caveman-statusline-suffix')).replace(/[\x00-\x1f]/g, '').trimEnd();
      if (savings) badge += ' ' + savings;
    } catch (e) {}
  }
  return '\x1b[38;5;172m' + badge + '\x1b[0m';
}

let received = {};

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch (e) {
    return '';
  }
  received = input;
  const parts = [];

  try {
    const badge = caveman();
    if (badge) parts.push(badge);
  } catch (e) {}

  try {
    const model = (input.model && input.model.display_name) || '';
    if (model) parts.push(paint('blue', model));
    const effort = input.effort && input.effort.level;
    if (effort) parts.push(paint('lavender', 'effort ' + effort + (input.fast_mode ? ' fast' : '')));
  } catch (e) {}

  try {
    const cw = input.context_window || {};
    const pct = num(cw.used_percentage);
    if (pct !== null) {
      const used = num(cw.total_input_tokens);
      const size = num(cw.context_window_size);
      const detail = used !== null && size !== null ? ' ' + tokens(used) + '/' + tokens(size) : '';
      parts.push(byLevel(pct, 'ctx ' + Math.round(pct) + '%' + detail));
    }
  } catch (e) {}

  try {
    const rl = input.rate_limits || {};
    const five = rl.five_hour || {};
    const week = rl.seven_day || {};
    if (num(five.used_percentage) !== null) {
      const reset = num(five.resets_at) !== null ? paint('os', ' >' + resetAt(five.resets_at, false)) : '';
      parts.push(byLevel(five.used_percentage, '5j ' + Math.round(five.used_percentage) + '%') + reset);
    }
    if (num(week.used_percentage) !== null) {
      const reset = num(week.resets_at) !== null ? paint('os', ' >' + resetAt(week.resets_at, true)) : '';
      parts.push(byLevel(week.used_percentage, '7h ' + Math.round(week.used_percentage) + '%') + reset);
    }
  } catch (e) {}

  try {
    const cost = input.cost || {};
    if (num(cost.total_cost_usd) !== null) parts.push(paint('pink', '$' + cost.total_cost_usd.toFixed(2)));
    if (num(cost.total_duration_ms) !== null) parts.push(paint('os', duration(cost.total_duration_ms)));
    const added = num(cost.total_lines_added);
    const removed = num(cost.total_lines_removed);
    if (added || removed) parts.push(paint('green', '+' + (added || 0)) + paint('os', '/') + paint('red', '-' + (removed || 0)));
  } catch (e) {}

  try {
    const pc = input.prompt_cache || {};
    if (typeof pc.warm === 'boolean') {
      const ratio = num(pc.hit_ratio) !== null ? ' ' + Math.round(pc.hit_ratio * 100) + '%' : '';
      parts.push(pc.warm ? paint('os', 'cache hangat' + ratio) : paint('red', 'cache dingin' + ratio));
    }
  } catch (e) {}

  return parts.join(paint('os', ' | '));
}

// Hands the numbers to DOCK in a detached process, at most once per session every 30 s; the line above never waits for it.
function pushToDock(input) {
  const id = String(input.session_id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  if (!id) return;
  const stamp = path.join(os.tmpdir(), 'dock-statusline-' + id + '.stamp');
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < PUSH_EVERY_MS) return; } catch (e) {}
  const push = path.join(__dirname, 'dock-push.cjs');
  if (!require(push).config()) return;
  const pick = (value, type) => (typeof value === type ? value : undefined);
  const limit = (window) => (window && num(window.used_percentage) !== null ? { usedPercentage: window.used_percentage, resetsAt: num(window.resets_at) ?? undefined } : undefined);
  const cw = input.context_window || {};
  const rl = input.rate_limits || {};
  const pc = input.prompt_cache || {};
  const payload = {
    sessionId: id,
    model: pick(input.model && input.model.display_name, 'string'),
    effort: pick(input.effort && input.effort.level, 'string'),
    fastMode: pick(input.fast_mode, 'boolean'),
    contextPercentage: num(cw.used_percentage) ?? undefined,
    contextTokens: num(cw.total_input_tokens) ?? undefined,
    contextSize: num(cw.context_window_size) ?? undefined,
    costUsd: num(input.cost && input.cost.total_cost_usd) ?? undefined,
    cacheWarm: pick(pc.warm, 'boolean'),
    cacheHitRatio: num(pc.hit_ratio) ?? undefined,
    fiveHour: limit(rl.five_hour),
    sevenDay: limit(rl.seven_day),
  };
  fs.writeFileSync(stamp, '');
  const file = path.join(os.tmpdir(), 'dock-statusline-' + id + '.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  spawn(process.execPath, [push, 'statusline', file], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

let out = '';
try { out = main(); } catch (e) { out = ''; }
process.stdout.write(out + '\n');
try { pushToDock(received); } catch (e) {}
