'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SRC = process.argv[2] || 'C:/Users/danus/.claude-kantor';
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const lines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).map(norm).filter(Boolean);

const map = {
  'CLAUDE.md': ['CLAUDE.common.md', 'CLAUDE.windows.md', 'CLAUDE.linux.md'],
  'AGENTS.md': ['AGENTS.md'],
  'RTK.md': ['RTK.md'],
  'DESIGN_THINKING.md': ['DESIGN_THINKING.md'],
  'karpathy-principles.md': ['karpathy-principles.md'],
};

let bad = 0;
for (const [srcName, outs] of Object.entries(map)) {
  const srcLines = lines(path.join(SRC, srcName));
  const outSets = outs.map((o) => ({ name: o, set: new Set(lines(path.join(REPO, 'claude', o))) }));
  const missing = [];
  const duplicated = [];
  for (const l of new Set(srcLines)) {
    const hit = outSets.filter((o) => o.set.has(l)).map((o) => o.name);
    if (hit.length === 0) missing.push(l);
    if (hit.length > 1) duplicated.push({ l, hit });
  }
  const placement = {};
  for (const l of new Set(srcLines)) {
    const hit = outSets.find((o) => o.set.has(l));
    if (hit) placement[hit.name] = (placement[hit.name] || 0) + 1;
  }
  const srcSet = new Set(srcLines);
  const foreign = outSets
    .filter((o) => o.name !== 'CLAUDE.linux.md')
    .flatMap((o) => [...o.set].filter((l) => !srcSet.has(l)).map((l) => `${o.name}: ${l}`));
  console.log(`${srcName}: ${srcLines.length} lines, missing ${missing.length}, duplicated ${duplicated.length}, foreign ${foreign.length}, placement ${JSON.stringify(placement)}`);
  for (const m of missing) console.log(`  MISSING ${m.slice(0, 100)}`);
  for (const d of duplicated) console.log(`  DUPLICATED [${d.hit.join(', ')}] ${d.l.slice(0, 100)}`);
  for (const f of foreign) console.log(`  FOREIGN ${f.slice(0, 100)}`);
  bad += missing.length + duplicated.length + foreign.length;
}
process.exit(bad ? 1 : 0);
