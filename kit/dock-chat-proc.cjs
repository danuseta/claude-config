'use strict';
const { StringDecoder } = require('string_decoder');
const { spawnSync } = require('child_process');

const LINE_MAX_BYTES = 32 * 1024 * 1024;

function createLineSplitter(onLine, { max = LINE_MAX_BYTES, onDrop = () => {} } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let size = 0;
  let dropping = false;
  const emit = (line) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  const take = (text) => {
    let from = 0;
    for (;;) {
      const at = text.indexOf('\n', from);
      if (at < 0) break;
      if (dropping) dropping = false;
      else emit(buffer + text.slice(from, at));
      buffer = '';
      size = 0;
      from = at + 1;
    }
    if (dropping) return;
    const rest = text.slice(from);
    buffer += rest;
    size += Buffer.byteLength(rest);
    if (size > max) {
      buffer = '';
      size = 0;
      dropping = true;
      onDrop();
    }
  };
  return {
    write(chunk) { take(typeof chunk === 'string' ? chunk : decoder.write(chunk)); },
    end() {
      take(decoder.end());
      if (!dropping && buffer) emit(buffer);
      buffer = '';
      size = 0;
    },
  };
}

function descendants(pid, table) {
  const kids = new Map();
  for (const line of String(table).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) || []), Number(m[1])]);
  }
  const found = [], seen = new Set([pid]), queue = [pid];
  while (queue.length) for (const k of kids.get(queue.shift()) || []) if (!seen.has(k)) { seen.add(k); found.push(k); queue.push(k); }
  return found;
}

function processTable({ platform = process.platform, run = spawnSync } = {}) {
  try {
    if (platform === 'win32') {
      const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";
      return String(run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).stdout || '');
    }
    return String(run('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 8000 }).stdout || '');
  } catch {
    return '';
  }
}

module.exports = { createLineSplitter, descendants, processTable, LINE_MAX_BYTES };
