'use strict';
// Secret scan. Prints only path:line and a pattern or key name, never a value.
// Usage: node install/secret-scan.cjs [--root <dir>] [--no-literal] [--no-gitleaks]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, readJson, loadManifest, compile, matchesAny, walk, sha256, isBinary } = require('./common.cjs');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

const root = path.resolve(opt('--root') || REPO);
const manifest = loadManifest();
const neverTracked = compile(manifest.neverTracked);
const MAX_BYTES = 5 * 1024 * 1024;
const LITERAL_MIN = 16;

const PATTERNS = [
  ['dock_ing_', /dock_ing_[A-Za-z0-9]{16,}/],
  ['tskey-', /tskey-[A-Za-z0-9-]{16,}/],
  ['sk-ant-', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['sk-', /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/],
  ['ghp_', /ghp_[A-Za-z0-9]{20,}/],
  ['gho_', /gho_[A-Za-z0-9]{20,}/],
  ['github_pat_', /github_pat_[A-Za-z0-9_]{20,}/],
  ['xox[abp]-', /xox[abp]-[A-Za-z0-9-]{10,}/],
  ['AIza', /AIza[0-9A-Za-z_-]{35}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/],
  ['credential-assignment', /(api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"'\s]{16,}/i],
];

const allowFile = path.join(__dirname, 'secret-scan.allow.json');
let allow = [];
if (fs.existsSync(allowFile)) {
  try {
    allow = readJson(allowFile).entries || [];
  } catch {
    allow = [];
  }
}
const isAllowed = (rel, pattern, lineHash) =>
  allow.some((a) => a.path === rel && a.pattern === pattern && (!a.lineHash || a.lineHash === lineHash));

const findings = [];
const report = (where, what) => findings.push(`${where} ${what}`);

function collectLiterals() {
  const home = path.join(os.homedir(), '.claude-kantor');
  const out = new Map();
  const add = (v, label) => {
    if (typeof v === 'string' && v.length >= LITERAL_MIN && !out.has(v)) out.set(v, label);
  };
  const leaves = (v, label, depth = 0) => {
    if (depth > 6) return;
    if (typeof v === 'string') add(v, label);
    else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${label}[${i}]`, depth + 1));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) leaves(v[k], `${label}.${k}`, depth + 1);
  };
  const load = (rel) => {
    try {
      return readJson(path.join(home, rel));
    } catch {
      return null;
    }
  };
  const settings = load('settings.json');
  if (settings && settings.env) leaves(settings.env, 'settings.json:env');
  const mcp = load('mcp.json');
  if (mcp && mcp.mcpServers) {
    for (const name of Object.keys(mcp.mcpServers)) {
      const s = mcp.mcpServers[name] || {};
      if (s.env) leaves(s.env, `mcp.json:${name}.env`);
      if (s.headers) leaves(s.headers, `mcp.json:${name}.headers`);
    }
  }
  for (const rel of ['kit/dock.json', 'kit/elevenlabs-keys.json', '.credentials.json']) {
    const j = load(rel);
    if (j) leaves(j, rel);
  }
  return out;
}

const literals = flag('--no-literal') ? new Map() : collectLiterals();
const literalBufs = [...literals].map(([v, label]) => [Buffer.from(v, 'utf8'), label]);

let scanned = 0;
walk(
  root,
  (rel, abs) => {
    scanned++;
    if (matchesAny(neverTracked, rel) && !isAllowed(rel, 'file-name')) report(rel, 'pattern=file-name');
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.size > MAX_BYTES) {
      if (!isAllowed(rel, 'oversize')) report(rel, 'pattern=oversize');
      return;
    }
    const buf = fs.readFileSync(abs);
    for (const [lit, label] of literalBufs) {
      const at = buf.indexOf(lit);
      if (at >= 0) {
        let line = 1;
        for (let i = 0; i < at; i++) if (buf[i] === 10) line++;
        report(`${rel}:${line}`, `literal=${label}`);
      }
    }
    if (isBinary(buf)) return;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 20000) continue;
      for (const [name, re] of PATTERNS) {
        if (re.test(line)) {
          const h = sha256(Buffer.from(line.trim()));
          if (!isAllowed(rel, name, h)) report(`${rel}:${i + 1}`, `pattern=${name} lineHash=${h.slice(0, 16)}`);
        }
      }
    }
  },
  (rel, e) => rel === '.git' || (e.isDirectory() && rel.endsWith('/.git'))
);

if (!flag('--no-gitleaks')) {
  const v = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (!v.error && v.status === 0) {
    const g = spawnSync('gitleaks', ['detect', '--no-git', '--source', root, '--no-banner', '--redact'], { encoding: 'utf8' });
    if (g.status !== 0) report('gitleaks', 'pattern=gitleaks (run gitleaks detect --no-git --redact for detail)');
  }
}

for (const f of findings) console.log(f);
console.log(`scanned ${scanned} files, layers: ${literals.size ? 'literal(' + literals.size + ' values) ' : ''}pattern file-name`);
console.log(`${findings.length} findings`);
process.exit(findings.length ? 1 : 0);
