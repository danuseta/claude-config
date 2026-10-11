'use strict';
// Shared by the kit tests: temp folders, a recording local HTTP server, a child-process runner. No network beyond 127.0.0.1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const KIT = path.resolve(__dirname, '..');
const SOURCE_KIT = 'C:/Users/danus/.claude-kantor/kit';
const hasSource = fs.existsSync(path.join(SOURCE_KIT, 'dock-push.cjs'));

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `kit-test-${label}-`));
const rmrf = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// Records every request as { method, url, headers, body }; `respond(req, body)` returns { status, json } or nothing for 200 {ok:true}.
function startServer(respond = () => null) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = raw || null; }
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(rec);
      const out = respond(rec) || { status: 200, json: { ok: true, result: {} } };
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    server,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

// Runs node and resolves { code, stdout, stderr } whatever the exit code.
function runNode(args, { env = {}, cwd = KIT, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, { env: { ...process.env, ...env }, cwd, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

// A bare sandbox env for a child: temp dirs for tmp/home so nothing of the real machine is read or written.
const sandboxEnv = (dir) => ({ TEMP: dir, TMP: dir, TMPDIR: dir, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), DOCK_KIT_STATE_DIR: dir });

module.exports = { KIT, SOURCE_KIT, hasSource, tmp, rmrf, startServer, runNode, waitFor, sandboxEnv };

// A fake of DOCK's ledger routes (P.6) and of POST / (the owner's ledger push). Tokens dock_ing_<machine> name the caller.
function ledgerFake() {
  const runs = new Map();
  const machineOf = (req) => String(req.headers.authorization || '').replace('Bearer dock_ing_', '');
  const view = (r, me) => ({ key: r.key, machine: r.machine, ledgerUpdatedAt: r.ledgerUpdatedAt, handover: r.handover, ledger: r.ledger, mine: r.machine === me });
  const bad = (error) => ({ status: 400, json: { ok: false, error } });
  const respond = (req) => {
    const me = machineOf(req), b = req.body || {};
    const route = req.url.replace(/^\/ingest\/orchestrator/, '');
    if (route === '') {
      const r = runs.get(b.key);
      if (!r) runs.set(b.key, { key: b.key, title: b.title, stage: b.stage, machine: me, ledgerUpdatedAt: b.updatedAt, handover: null, ledger: b });
      else if (r.machine === me) Object.assign(r, { title: b.title, stage: b.stage, ledgerUpdatedAt: b.updatedAt, ledger: b });
      else return { json: { ok: true, result: { key: b.key, ignored: true, owner: r.machine } } };
      return { json: { ok: true, result: { key: b.key } } };
    }
    if (route === '/ledger/list') return { json: { ok: true, result: { runs: [...runs.values()].map((r) => ({ key: r.key, title: r.title, stage: r.stage, machine: r.machine, ledgerUpdatedAt: r.ledgerUpdatedAt, handoverTo: r.handover ? r.handover.to : null, mine: r.machine === me })) } } };
    const r = runs.get(b.key);
    if (route === '/ledger/get') return r ? { json: { ok: true, result: view(r, me) } } : { status: 404, json: { ok: false, error: 'Unknown ticket' } };
    if (route === '/ledger/handover') {
      if (!r) return { status: 404, json: { ok: false, error: 'Unknown ticket' } };
      if (r.machine !== me) return bad('Only the owning machine can hand a ticket over');
      if (b.to === me) return bad('to must differ from the owner');
      r.handover = { from: me, to: b.to, at: new Date().toISOString(), note: b.note || '', branches: b.branches || {} };
      return { json: { ok: true, result: { key: r.key, handover: r.handover } } };
    }
    if (route === '/ledger/accept') {
      if (!r) return { status: 404, json: { ok: false, error: 'Unknown ticket' } };
      if (!(r.handover && r.handover.to === me) && r.machine !== me) return bad('This ticket is not offered to this machine');
      r.machine = me; r.handover = null;
      return { json: { ok: true, result: view(r, me) } };
    }
    return null;
  };
  return { runs, respond };
}

module.exports.ledgerFake = ledgerFake;
