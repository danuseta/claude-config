'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadManifest(repo = REPO) {
  return readJson(path.join(repo, 'manifest.json'));
}

function compile(list) {
  return list.map((s) => new RegExp(s));
}

function matchesAny(regexes, rel) {
  return regexes.some((r) => r.test(rel));
}

function walk(root, onFile, skip) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (skip && skip(childRel, e)) continue;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) onFile(childRel, path.join(root, childRel));
    }
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

module.exports = { REPO, readJson, loadManifest, compile, matchesAny, walk, sha256, isBinary };
