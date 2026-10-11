'use strict';
// Installs the repo configuration into a Claude config directory.
// Usage: node install/install.cjs [--dry-run | --apply | --check | --extract-secrets | --uninstall --yes]
//        [--os windows|linux] [--config-dir <dir>] [--secrets-file <file>] [--verbose]
// Never prints a secret value. Default mode is --dry-run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO, readJson, loadManifest, compile, matchesAny, walk, sha256 } = require('./common.cjs');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

const manifest = loadManifest();
const OS = opt('--os') || (process.platform === 'win32' ? 'windows' : 'linux');
const home = os.homedir().replace(/\\/g, '/');
const expand = (s, dir) => s.replace(/\{\{home\}\}/g, home).replace(/\{\{configDir\}\}/g, dir || '');
const configDir = (opt('--config-dir') || expand(manifest.configDir[OS])).replace(/\\/g, '/');
const secretsCfg = manifest.secrets[OS];
const secretsFile = (opt('--secrets-file') || expand(secretsCfg.file, configDir)).replace(/\\/g, '/');
const apply = flag('--apply');
const importSkip = compile(manifest.importSkip);
const neverTracked = compile(manifest.neverTracked);
const TEXT_EXT = /\.(md|json|cjs|js|mjs|sh|txt|yml|yaml|toml|py|ts|tsx|css|html|env|jsonl)$/i;

const log = (s = '') => console.log(s);
const exists = (p) => fs.existsSync(p);

function loadSecrets() {
  if (!exists(secretsFile)) return null;
  const raw = fs.readFileSync(secretsFile, 'utf8');
  if (secretsCfg.format === 'json') return JSON.parse(raw);
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
const isEventEntries = (a) => a.length > 0 && a.every((e) => isPlainObject(e) && Array.isArray(e.hooks));

// Hook entries are keyed by (matcher, command) so a second run changes nothing.
function mergeEventEntries(existing, tpl) {
  const out = existing.map((e) => ({ ...e, hooks: e.hooks.slice() }));
  for (const t of tpl) {
    const pending = [];
    for (const h of t.hooks) {
      let placed = false;
      for (const e of out) {
        if ((e.matcher || '') !== (t.matcher || '')) continue;
        const i = e.hooks.findIndex((x) => x.command === h.command);
        if (i >= 0) {
          e.hooks[i] = h;
          placed = true;
          break;
        }
      }
      if (!placed) pending.push(h);
    }
    if (pending.length) out.push({ ...t, hooks: pending });
  }
  return out;
}

function deepMerge(base, over) {
  if (Array.isArray(base) && Array.isArray(over)) {
    if (isEventEntries(over) && (isEventEntries(base) || base.length === 0)) return mergeEventEntries(base, over);
    const out = base.slice();
    for (const v of over) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(v))) out.push(v);
    return out;
  }
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  return over;
}

function renderString(s, secrets, fills, where) {
  const sec = /^\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(s);
  if (sec) {
    const name = sec[1];
    const have = secrets && typeof secrets[name] === 'string' && secrets[name] !== '';
    fills.push({ where, name, available: have });
    return have ? secrets[name] : undefined;
  }
  return s
    .replace(/\{\{kit:([^\s}]+)(?: ([^}]*))?\}\}/g, (_, file, a) => {
      const tail = a ? ' ' + a : '';
      return OS === 'windows'
        ? `node "${configDir}/kit/${file}"${tail}`
        : `"${configDir}/kit/bin/kit-node" ${file}${tail}`;
    })
    .replace(/\{\{configDir\}\}/g, configDir)
    .replace(/\{\{home\}\}/g, home);
}

function render(v, secrets, fills, where) {
  if (typeof v === 'string') return renderString(v, secrets, fills, where);
  if (Array.isArray(v)) return v.map((x, i) => render(x, secrets, fills, `${where}[${i}]`));
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v)) {
      const r = render(v[k], secrets, fills, where ? `${where}.${k}` : k);
      if (r !== undefined) o[k] = r;
    }
    return o;
  }
  return v;
}

function diffPaths(a, b, prefix, out) {
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in a)) out.push(`+ ${p}`);
      else if (!(k in b)) out.push(`- ${p}`);
      else diffPaths(a[k], b[k], p, out);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`~ ${prefix} (array: ${a.length} -> ${b.length} items)`);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`~ ${prefix}`);
}

function countHooks(s) {
  let n = 0;
  for (const ev of Object.values(s.hooks || {})) for (const e of ev) n += (e.hooks || []).length;
  return n;
}

function planSettings(secrets) {
  const cfg = manifest.settings;
  const baseFile = path.join(REPO, cfg.base);
  const overlayFile = path.join(REPO, cfg.overlay[OS]);
  const target = path.join(configDir, cfg.target);
  if (!exists(baseFile) || !exists(overlayFile)) return { error: `template missing (${cfg.base} or ${cfg.overlay[OS]})` };
  const fills = [];
  const tpl = render(deepMerge(readJson(baseFile), readJson(overlayFile)), secrets, fills, '');
  const current = exists(target) ? readJson(target) : {};
  const merged = deepMerge(current, tpl);
  const mask = (s) => {
    const c = JSON.parse(JSON.stringify(s));
    if (c.env) for (const k of Object.keys(c.env)) c.env[k] = '<value>';
    return c;
  };
  const changes = [];
  diffPaths(mask(current), mask(merged), '', changes);
  const valueChanged = JSON.stringify(current.env || {}) !== JSON.stringify(merged.env || {});
  return { target, current, merged, fills, changes, valueChanged };
}

function sameContent(a, b) {
  const text = TEXT_EXT.test(a);
  let ba = fs.readFileSync(a);
  let bb = fs.readFileSync(b);
  if (!text && ba.length !== bb.length) return false;
  if (text) {
    ba = Buffer.from(ba.toString('utf8').replace(/\r\n/g, '\n'));
    bb = Buffer.from(bb.toString('utf8').replace(/\r\n/g, '\n'));
  }
  return sha256(ba) === sha256(bb);
}

function copyPlan() {
  const items = [];
  const absent = [];
  const add = (src, dst, rel) => {
    const state = !exists(dst) ? 'new' : sameContent(src, dst) ? 'same' : 'changed';
    items.push({ src, dst, rel, state });
  };
  for (const f of manifest.files) {
    if (!f.os.includes(OS)) continue;
    const src = path.join(REPO, f.from);
    if (!exists(src)) absent.push(f.from);
    else add(src, path.join(configDir, f.to), f.to);
  }
  for (const d of manifest.dirs) {
    if (!d.os.includes(OS)) continue;
    const srcRoot = path.join(REPO, d.from);
    if (!exists(srcRoot)) {
      absent.push(d.from + '/');
      continue;
    }
    const topExcl = [...(d.exclude || []), ...((d.excludeOs && d.excludeOs[OS]) || [])];
    walk(srcRoot, (rel, abs) => {
      const full = d.from + '/' + rel;
      if (matchesAny(importSkip, full) || matchesAny(neverTracked, full)) return;
      if (topExcl.some((x) => rel === x || rel.startsWith(x + '/'))) return;
      add(abs, path.join(configDir, d.to, rel), `${d.to}/${rel}`);
    });
  }
  return { items, absent };
}

function planClaudeMd() {
  const cfg = manifest.claudeMd;
  const missing = cfg.parts[OS].filter((p) => !exists(path.join(REPO, p)));
  if (missing.length) return { missing };
  const content =
    cfg.parts[OS].map((p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\s+$/, '')).join('\n\n') + '\n';
  const target = path.join(configDir, cfg.target);
  const same =
    exists(target) &&
    sha256(Buffer.from(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'))) === sha256(Buffer.from(content));
  return { target, content, state: !exists(target) ? 'new' : same ? 'same' : 'changed' };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function extractSecrets() {
  const src = path.join(configDir, manifest.settings.target);
  if (!exists(src)) {
    log(`extract-secrets: ${src} not found`);
    return 1;
  }
  if (exists(secretsFile)) {
    log(`extract-secrets: ${secretsFile} already exists, not overwritten`);
    return 0;
  }
  const env = readJson(src).env || {};
  const names = Object.keys(env);
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  const body =
    secretsCfg.format === 'json'
      ? JSON.stringify(env, null, 2) + '\n'
      : names.map((k) => `${k}=${env[k]}`).join('\n') + '\n';
  fs.writeFileSync(secretsFile, body, { mode: 0o600 });
  log(`extract-secrets: wrote ${secretsFile} with ${names.length} keys: ${names.join(', ') || '(none)'}`);
  return 0;
}

function main() {
  if (flag('--extract-secrets')) return extractSecrets();

  const secrets = loadSecrets();
  const mode = flag('--uninstall') ? 'uninstall' : apply ? 'apply' : flag('--check') ? 'check' : 'dry-run';
  log(`install.cjs  mode=${mode}  os=${OS}`);
  log(`repo       ${REPO.replace(/\\/g, '/')}`);
  log(`configDir  ${configDir}`);
  log(`secrets    ${secretsFile} (${secrets ? 'found, ' + Object.keys(secrets).length + ' keys' : 'missing'})`);
  log();

  const st = planSettings(secrets);
  const cp = copyPlan();
  const md = planClaudeMd();
  let pending = 0;

  if (flag('--uninstall')) {
    const rm = cp.items.filter((i) => i.state === 'same');
    log(`uninstall: ${rm.length} installed files identical to the repo would be removed (settings.json and secrets are never touched)`);
    if (!flag('--yes')) {
      log('re-run with --uninstall --yes to remove them');
      return 0;
    }
    for (const i of rm) fs.rmSync(i.dst, { force: true });
    log('removed');
    return 0;
  }

  log('settings.json');
  if (st.error) {
    log(`  skipped: ${st.error}`);
  } else {
    const cur = st.current;
    const mrg = st.merged;
    log(`  current : ${Object.keys(cur).length} top-level keys, ${countHooks(cur)} hooks, ${Object.keys(cur.enabledPlugins || {}).length} plugins`);
    log(`  rendered: ${Object.keys(mrg).length} top-level keys, ${countHooks(mrg)} hooks, ${Object.keys(mrg.enabledPlugins || {}).length} plugins`);
    if (st.changes.length === 0) log('  settings.json: no structural change');
    else {
      pending++;
      log(`  settings.json: ${st.changes.length} structural changes (paths only)`);
      for (const c of st.changes) log(`    ${c}`);
    }
    if (st.valueChanged) {
      pending++;
      log('  env values: would differ (values not shown)');
    }
    for (const f of st.fills) {
      const where = f.available ? 'would fill from' : 'NOT available in';
      const hint = f.available ? '' : ' (existing value kept; run --extract-secrets)';
      log(`  placeholder {{secret:${f.name}}} at ${f.where}: ${where} ${secretsFile}${hint}`);
    }
    if (apply && (st.changes.length || st.valueChanged)) {
      if (exists(st.target)) fs.copyFileSync(st.target, `${st.target}.bak-${stamp()}`);
      fs.mkdirSync(path.dirname(st.target), { recursive: true });
      fs.writeFileSync(st.target, JSON.stringify(st.merged, null, 2) + '\n');
      log('  applied (backup written next to it)');
    }
  }
  log();

  log('CLAUDE.md');
  if (md.missing) log(`  skipped, sources not in the repo yet: ${md.missing.join(', ')}`);
  else {
    log(`  ${md.state}`);
    if (md.state !== 'same') pending++;
    if (apply && md.state !== 'same') fs.writeFileSync(md.target, md.content);
  }
  log();

  const by = { new: 0, changed: 0, same: 0 };
  for (const i of cp.items) by[i.state]++;
  log(`files: ${cp.items.length} considered, ${by.new} new, ${by.changed} changed, ${by.same} identical`);
  for (const i of cp.items.filter((x) => x.state !== 'same' && !x.rel.startsWith('skills/'))) {
    log(`  ${i.state.padEnd(7)} ${i.rel}`);
  }
  const skills = cp.items.filter((x) => x.state !== 'same' && x.rel.startsWith('skills/'));
  if (skills.length) log(`  skills: ${skills.length} files new or changed (listed with --verbose)`);
  if (flag('--verbose')) for (const i of skills) log(`  ${i.state.padEnd(7)} ${i.rel}`);
  if (cp.absent.length) log(`not in the repo yet (owned by other workers, skipped): ${cp.absent.join(', ')}`);
  const notYet = manifest.ownedByOtherWorkers.filter((d) => !exists(path.join(REPO, d)));
  if (notYet.length) log(`repo folders absent for now: ${notYet.join(', ')}`);
  pending += by.new + by.changed;
  if (apply) {
    for (const i of cp.items) {
      if (i.state === 'same') continue;
      fs.mkdirSync(path.dirname(i.dst), { recursive: true });
      fs.copyFileSync(i.src, i.dst);
    }
    log('applied. Nothing was deleted.');
  }
  log();
  if (!apply) log(pending ? `${pending} pending change group(s)` : 'nothing to change');
  return flag('--check') ? (pending ? 1 : 0) : 0;
}

process.exit(main());
