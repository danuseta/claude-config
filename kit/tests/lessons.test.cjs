'use strict';
// The lessons a DOCK turn must read (kit/lessons-gate.cjs in guard.cjs and sous-guard.cjs), the bridge plumbing that names the file,
// the lessons files DOCK writes next to skills and agents (kit/lessons.cjs), Judge's target and lesson fields, and the ElevenLabs
// key rotation of the demo-video scripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const gate = require('../lessons-gate.cjs');
const { commits } = require('../guard.cjs');
const { createSousGuard } = require('../sous-guard.cjs');
const { resolvePaths } = require('../paths.cjs');
const chat = require('../dock-chat.cjs');
const { createLessons } = require('../lessons.cjs');
const judge = require('../judge.cjs');
const { KIT, tmp, rmrf, runNode, startServer, sandboxEnv } = require('./helpers.cjs');

const turnEnv = (file) => ({ DOCK_CHAT_TURN: '1', ...(file ? { DOCK_LESSONS_FILE: file } : {}) });
const at = (ms) => new Date(ms).toISOString();
const userLine = (text, ts = Date.now() - 60000) => JSON.stringify({ type: 'user', timestamp: at(ts), message: { role: 'user', content: text } });
const useLine = (id, name, input, ts = Date.now()) => JSON.stringify({ type: 'assistant', timestamp: at(ts), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultLine = (id, isError) => JSON.stringify({ type: 'user', timestamp: at(Date.now()), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });

function setup() {
  const dir = tmp('lessons');
  const lessons = path.join(dir, 'evidence', 'lessons', 'QRD-1592.md');
  fs.mkdirSync(path.dirname(lessons), { recursive: true });
  fs.writeFileSync(lessons, '# Pelajaran QRD-1592\n\n- (2x) Walk the whole ElevenLabs rotation before using edge.\n');
  const old = Date.now() - 10 * 60000;
  fs.utimesSync(lessons, old / 1000, old / 1000);
  const transcript = path.join(dir, 'session.jsonl');
  return { dir, lessons, transcript, write: (...lines) => fs.writeFileSync(transcript, `${lines.join('\n')}\n`) };
}

const edit = (t, file = 'E:/qonflo/wt-1592-be/src/a.ts') => ({ tool_name: 'Edit', transcript_path: t.transcript, tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
const shell = (t, command) => ({ tool_name: 'Bash', transcript_path: t.transcript, tool_input: { command } });

test('commits() finds git commit through rtk, -C, nested shells and chains, and nothing else', () => {
  for (const c of ['git commit -m x', 'rtk git commit -m "fix(QRD-1): x"', 'git -C E:/qonflo/wt-1-be commit -m x', 'bash -c "git commit -m y"', 'git add a.ts && git commit -m z']) assert.equal(commits(c), true, c);
  for (const c of ['git status', 'echo commit', 'git log --grep commit', 'rtk git diff', 'gh pr create --title commit']) assert.equal(commits(c), false, c);
});

test('the gate refuses Edit, Write, MultiEdit, NotebookEdit and git commit until the lessons file is read, naming the path', () => {
  const t = setup();
  try {
    t.write(userLine('Pakai skill sous: kerjakan QRD-1592.'));
    const env = turnEnv(t.lessons);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const why = gate.check({ ...edit(t), tool_name: tool }, { env });
      assert.match(why, /lessons: read .*evidence\/lessons\/QRD-1592\.md first/, tool);
    }
    assert.match(gate.check(shell(t, 'rtk git commit -m "fix(QRD-1592): x"'), { env }), /QRD-1592\.md/);
    for (const payload of [{ tool_name: 'Read', transcript_path: t.transcript, tool_input: { file_path: 'E:/qonflo/a.ts' } }, { tool_name: 'Grep', transcript_path: t.transcript, tool_input: { pattern: 'x' } }, { tool_name: 'Glob', transcript_path: t.transcript, tool_input: { pattern: '*' } }, shell(t, 'rtk git status'), shell(t, 'rtk rg useQuery src'), shell(t, 'git log --oneline -3')]) {
      assert.equal(gate.check(payload, { env }), null, payload.tool_name);
    }
    t.write(userLine('Pakai skill sous: kerjakan QRD-1592.'), useLine('r1', 'Read', { file_path: t.lessons.replace(/\//g, '\\') }), resultLine('r1', false));
    assert.equal(gate.check(edit(t), { env }), null, 'read with the Read tool, backslashes or not');
    assert.equal(gate.check(shell(t, 'git commit -m x'), { env }), null);
  } finally { rmrf(t.dir); }
});

test('a read through rtk read or cat counts, a failed read does not, and a file DOCK rewrote after the read is read again', () => {
  const t = setup();
  try {
    const env = turnEnv(t.lessons);
    t.write(userLine('go'), useLine('r1', 'Read', { file_path: t.lessons }), resultLine('r1', true));
    assert.match(gate.check(edit(t), { env }), /first/, 'the Read failed');
    t.write(userLine('go'), useLine('b1', 'Bash', { command: `rtk read "${t.lessons}"` }), resultLine('b1', false));
    assert.equal(gate.check(edit(t), { env }), null, 'rtk read');
    t.write(userLine('go'), useLine('b2', 'Bash', { command: `cat ${t.lessons}` }));
    assert.equal(gate.check(edit(t), { env }), null, 'cat');
    t.write(userLine('go'), useLine('b3', 'Bash', { command: `rtk rg Walk ${t.lessons}` }));
    assert.match(gate.check(edit(t), { env }), /first/, 'a search is not a read');
    t.write(userLine('go'), useLine('r2', 'Read', { file_path: t.lessons }, Date.now() - 5 * 60000));
    assert.equal(gate.check(edit(t), { env }), null);
    fs.appendFileSync(t.lessons, '- (1x) A new lesson.\n');
    assert.match(gate.check(edit(t), { env }), /changed after you read it/, 'mtime after the read');
    t.write(userLine('go'), useLine('r2', 'Read', { file_path: t.lessons }, Date.now() - 5 * 60000), useLine('r3', 'Read', { file_path: t.lessons }, Date.now() + 1000));
    assert.equal(gate.check(edit(t), { env }), null, 'read again');
  } finally { rmrf(t.dir); }
});

test('a subagent transcript that replays the read in an api-request-blob line without a timestamp still counts the read', () => {
  const t = setup();
  try {
    const env = turnEnv(t.lessons);
    const blob = JSON.stringify({ type: 'api-request-blob', sessionId: 's', agentId: 'a', hash: 'h', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: t.lessons } }] } });
    t.write(userLine('go'), useLine('r1', 'Read', { file_path: t.lessons }), resultLine('r1', false), blob, blob);
    assert.equal(gate.check(edit(t), { env }), null);
    t.write(userLine('go'), blob);
    assert.match(gate.check(edit(t), { env }), /first/, 'a replay alone is not a read');
  } finally { rmrf(t.dir); }
});

test('outside a DOCK turn, in a Guild Master or Judge turn, or with no lessons file nothing changes', () => {
  const t = setup();
  try {
    t.write(userLine(`Pakai skill sous: kerjakan QRD-1592.\nPelajaran: ${t.lessons} — baca file ini sebelum mulai.`));
    assert.equal(gate.check(edit(t), { env: { DOCK_LESSONS_FILE: t.lessons } }), null, 'no DOCK_CHAT_TURN');
    assert.equal(gate.check(edit(t), { env: { ...turnEnv(t.lessons), DOCK_GM: '1' } }), null);
    assert.equal(gate.check(edit(t), { env: { ...turnEnv(t.lessons), DOCK_JUDGE: '1' } }), null);
    t.write(userLine('kerjakan QRD-1592'));
    assert.equal(gate.check(edit(t), { env: turnEnv() }), null, 'no env and no Pelajaran line');
    assert.equal(gate.check(edit(t), { env: turnEnv(path.join(t.dir, 'missing.md')) }), null, 'a file that does not exist');
  } finally { rmrf(t.dir); }
});

test('without the env the Pelajaran: line of the first prompt names the file', () => {
  const t = setup();
  try {
    t.write(userLine(`Pakai skill sous: kerjakan QRD-1592.\nPelajaran: ${t.lessons} — baca file ini sebelum mulai; guard menolak Edit, Write dan git commit sampai file ini dibaca.`), userLine('Pelajaran: E:/elsewhere/other.md'));
    assert.equal(gate.fileFromTranscript(gate.entries(fs.readFileSync(t.transcript, 'utf8'))), t.lessons);
    assert.match(gate.check(edit(t), { env: turnEnv() }), /QRD-1592\.md first/);
    fs.appendFileSync(t.transcript, `${useLine('r1', 'Read', { file_path: t.lessons })}\n`);
    assert.equal(gate.check(edit(t), { env: turnEnv() }), null);
  } finally { rmrf(t.dir); }
});

test('guard.cjs as the hook: denies Edit before the read and allows it after; Read always passes', async () => {
  const t = setup();
  try {
    const env = { ...sandboxEnv(t.dir), ...turnEnv(t.lessons) };
    t.write(userLine('Pakai skill sous: kerjakan QRD-1592.'));
    const run = (payload) => runNode([path.join(KIT, 'guard.cjs')], { env, input: JSON.stringify({ cwd: t.dir, ...payload }) });
    const denied = await run(edit(t, path.join(t.dir, 'a.ts')));
    const out = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /^guard: lessons: read .*QRD-1592\.md first/);
    assert.equal((await run({ tool_name: 'Read', transcript_path: t.transcript, tool_input: { file_path: t.lessons } })).stdout, '');
    fs.appendFileSync(t.transcript, `${useLine('r1', 'Read', { file_path: t.lessons })}\n`);
    assert.equal((await run(edit(t, path.join(t.dir, 'a.ts')))).stdout, '');
  } finally { rmrf(t.dir); }
});

test('sous-guard: a worker and a publisher read their own transcript; the lead reading the file does not count for them', () => {
  const t = setup();
  try {
    const paths = resolvePaths({ platform: 'win32', env: {}, kitDir: 'C:/Users/danus/.claude-kantor/kit', local: {} });
    const g = createSousGuard({ platform: 'win32', paths, cwd: 'E:/qonflo', env: turnEnv() });
    const session = 'sess-1';
    t.write(userLine('lead'), useLine('r0', 'Read', { file_path: t.lessons }));
    const own = path.join(t.dir, session, 'subagents', 'agent-w1.jsonl');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, `${userLine(`Pelajaran: ${t.lessons} — baca file ini sebelum mulai.\nT1 of QRD-1592`)}\n`);
    const worker = { tool_name: 'Write', transcript_path: t.transcript, session_id: session, agent_id: 'w1', agent_type: 'sous-ticket-worker', tool_input: { file_path: 'E:/qonflo/wt-1592-be/src/a.ts' } };
    assert.match(g.check('path', ['@wt'], worker), /QRD-1592\.md first/);
    const publisher = { ...worker, tool_name: 'Bash', tool_input: { command: 'git -C E:/qonflo/wt-1592-be commit -m "fix(QRD-1592): x"' } };
    assert.match(g.check('publish', [], publisher), /QRD-1592\.md first/);
    fs.appendFileSync(own, `${useLine('r1', 'Read', { file_path: t.lessons })}\n`);
    assert.equal(g.check('path', ['@wt'], worker), null);
    assert.doesNotMatch(String(g.check('publish', [], publisher)), /lessons/);
    assert.equal(createSousGuard({ platform: 'win32', paths, cwd: 'E:/qonflo', env: {} }).check('path', ['@wt'], { ...worker, agent_id: 'w2' }), null, 'outside a DOCK turn');
  } finally { rmrf(t.dir); }
});

test('sous-guard: the worker may read the lessons folder', () => {
  const paths = resolvePaths({ platform: 'linux', env: {}, kitDir: '/home/coder/.claude/kit', local: {} });
  const g = createSousGuard({ platform: 'linux', paths, cwd: '/home/coder/projects', env: {} });
  assert.equal(g.check('path', ['--read', '@wt', '@board', '@lessons', '@config'], { tool_name: 'Read', tool_input: { file_path: `${paths.evidence}/lessons/QRD-1592.md` } }), null);
  assert.match(g.check('path', ['--read', '@wt', '@board', '@config'], { tool_name: 'Read', tool_input: { file_path: `${paths.evidence}/lessons/QRD-1592.md` } }), /outside/);
  assert.equal(g.check('path', ['--read', '@lessons'], { tool_name: 'Read', tool_input: { file_path: `${paths.kitDir}/lessons/agents/sous-publisher.md` } }), null, 'the agents\' lessons files under the kit');
  assert.match(g.check('path', ['--read', '@lessons'], { tool_name: 'Read', tool_input: { file_path: `${paths.kitDir}/dock.json` } }), /outside/);
  for (const name of ['sous-jira', 'sous-publisher', 'sous-verifier']) assert.match(fs.readFileSync(path.join(KIT, '..', 'agents', `${name}.md`), 'utf8'), /path --read [^|]*@lessons/, name);
  const worker = fs.readFileSync(path.join(KIT, '..', 'agents', 'sous-ticket-worker.md'), 'utf8');
  assert.match(worker, /path --read @wt @board @lessons @config/);
});

test('childEnv: DOCK_LESSONS_FILE comes from the turn, never in a Guild Master turn, and only for an absolute .md path', () => {
  assert.equal(chat.childEnv({ configDir: null, lessonsFile: 'E:/qonflo/.evidence/lessons/QRD-1.md' }, {}).DOCK_LESSONS_FILE, 'E:/qonflo/.evidence/lessons/QRD-1.md');
  assert.equal(chat.childEnv({ configDir: null, lessonsFile: '/home/coder/projects/.evidence/lessons/QRD-1.md' }, {}).DOCK_LESSONS_FILE, '/home/coder/projects/.evidence/lessons/QRD-1.md');
  assert.equal(chat.childEnv({ configDir: null }, { DOCK_LESSONS_FILE: '/old.md' }).DOCK_LESSONS_FILE, undefined, 'an inherited value is dropped');
  assert.equal(chat.childEnv({ configDir: null, gm: 's1', lessonsFile: '/x/QRD-1.md' }, {}).DOCK_LESSONS_FILE, undefined);
  for (const bad of ['relative/QRD-1.md', '/x/QRD-1.txt', '/x/a.md\nrm -rf', 42, null]) assert.equal(chat.lessonsPath(bad), null, String(bad));
});

test('lessons-put writes skills/<name>/lessons.md and kit/lessons/agents/<name>.md (never into agents/), refusing unknown names and links', () => {
  const dir = tmp('lessons-put');
  try {
    const cfg = path.join(dir, 'cfg');
    fs.mkdirSync(path.join(cfg, 'skills', 'demo-video'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'agents', 'sous-review-runner.md'), '---\nname: sous-review-runner\n---\nbody\n');
    const text = '# Pelajaran demo-video\n\n- (2x, QRD-1639, QRD-1592) Walk the whole rotation.\n';
    assert.deepEqual(chat.libraryJob({ op: 'lessons-put', input: { kind: 'skill', name: 'demo-video', text } }, { configDir: cfg }), { ok: true, path: 'skills/demo-video/lessons.md', changed: true });
    assert.equal(fs.readFileSync(path.join(cfg, 'skills', 'demo-video', 'lessons.md'), 'utf8'), text);
    assert.equal(chat.libraryJob({ op: 'lessons-put', input: { kind: 'skill', name: 'demo-video', text } }, { configDir: cfg }).changed, false);
    assert.equal(createLessons({ configDir: cfg }).put({ kind: 'agent', name: 'sous-review-runner', text: 'x\n' }).path, 'kit/lessons/agents/sous-review-runner.md');
    assert.equal(fs.readFileSync(path.join(cfg, 'kit', 'lessons', 'agents', 'sous-review-runner.md'), 'utf8'), 'x\n');
    assert.deepEqual(fs.readdirSync(path.join(cfg, 'agents')), ['sous-review-runner.md'], 'nothing new where Claude Code loads agents');
    assert.equal(createLessons({ configDir: cfg }).get({ kind: 'agent', name: 'sous-review-runner' }).text, 'x\n');
    assert.match(createLessons({ configDir: cfg }).put({ kind: 'skill', name: 'nope', text: 'x' }).error, /No skill folder nope/);
    assert.match(createLessons({ configDir: cfg }).put({ kind: 'agent', name: 'nope', text: 'x' }).error, /No agent file/);
    assert.match(createLessons({ configDir: cfg }).put({ kind: 'skill', name: '../kit', text: 'x' }).error, /plain/);
    assert.match(createLessons({ configDir: cfg }).put({ kind: 'repo', name: 'x', text: 'x' }).error, /kind/);
    assert.match(createLessons({ configDir: cfg }).put({ kind: 'skill', name: 'demo-video', text: 'a\u0000b' }).error, /text/);
    assert.throws(() => chat.libraryJob({ op: 'lessons-delete', input: {} }, { configDir: cfg }), /Unknown lessons op/);
  } finally { rmrf(dir); }
});

test('judge.cjs carries target and lesson, drops them for environment, accepts lesson-ignored and an old result without them', () => {
  const base = { messageId: '1', text: 't', quote: 'q', shouldHave: 's', call: 'mistake' };
  const body = (findings) => judge.resultBody({ sessionId: 's', untilMessageId: '-', findings });
  const ok = body([{ ...base, cause: 'self-inflicted-rework', target: { kind: 'skill', name: 'demo-video' }, lesson: ' Walk the whole rotation. ' }]).body.findings[0];
  assert.deepEqual([ok.target, ok.lesson], [{ kind: 'skill', name: 'demo-video' }, 'Walk the whole rotation.']);
  assert.equal(body([{ ...base, cause: 'environment', target: { kind: 'skill', name: 'x' }, lesson: 'y' }]).body.findings[0].target, undefined);
  assert.equal(body([{ ...base, cause: 'skipped-step' }]).body.findings[0].lesson, undefined, 'an old result');
  assert.ok(body([{ ...base, cause: 'lesson-ignored', target: { kind: 'skill', name: 'demo-video' }, lesson: 'Walk the whole rotation.' }]).body);
  assert.match(body([{ ...base, cause: 'lesson-ignored' }]).error, /lesson-ignored/);
  assert.match(body([{ ...base, cause: 'skipped-step', target: { kind: 'team', name: 'x' }, lesson: 'y' }]).error, /target must be/);
  assert.match(body([{ ...base, cause: 'skipped-step', target: { kind: 'repo', name: 'ms-x' } }]).error, /lesson must be/);
  assert.match(body([{ ...base, cause: 'skipped-step', lesson: 'y' }]).error, /needs its target/);
});

test('judge.cjs forwards an optional Indonesian lessonId only with a lesson; an old result without it still parses', () => {
  const base = { messageId: '1', text: 't', quote: 'q', shouldHave: 's', call: 'mistake', cause: 'skipped-step', target: { kind: 'skill', name: 'demo-video' }, lesson: 'Walk the whole rotation.' };
  const body = (findings) => judge.resultBody({ sessionId: 's', untilMessageId: '-', findings });
  assert.equal(body([{ ...base, lessonId: ' Coba semua key dulu. ' }]).body.findings[0].lessonId, 'Coba semua key dulu.');
  assert.ok(!('lessonId' in body([base]).body.findings[0]), 'a result without lessonId');
  assert.ok(!('lessonId' in body([{ ...base, lessonId: '  ' }]).body.findings[0]), 'an empty lessonId is left out');
  assert.ok(!('lessonId' in body([{ ...base, cause: 'environment', lessonId: 'x' }]).body.findings[0]), 'environment drops it');
  assert.match(body([{ ...base, lessonId: 3 }]).error, /lessonId must be/);
  assert.match(body([{ messageId: '1', text: 't', quote: 'q', shouldHave: 's', call: 'mistake', cause: 'skipped-step', lessonId: 'x' }]).error, /needs its lesson/);
});

// ---- demo-video: ElevenLabs rotation inside tts.py and align.py ----

const hasPython = (py) => new Promise((r) => execFile(py, ['--version'], (e) => r(!e)));
const findPython = async () => ((await hasPython('python3')) ? 'python3' : (await hasPython('python')) ? 'python' : null);
const SCRIPTS = path.join(KIT, '..', 'skills', 'demo-video', 'scripts');
const runPython = (py, args, env) => new Promise((resolve) => {
  execFile(py, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env }, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
});

// A kit folder with an el-rotate.cjs that keeps its keys in a JSON file: get prints the first ready key, park parks it.
function fakeKit(dir, keys) {
  const kit = path.join(dir, 'kit');
  fs.mkdirSync(kit, { recursive: true });
  const state = path.join(dir, 'keys.json');
  fs.writeFileSync(state, JSON.stringify(keys.map(([name, key]) => ({ name, key, parked: false }))));
  fs.writeFileSync(path.join(kit, 'el-rotate.cjs'), `const fs = require('fs');
const file = ${JSON.stringify(state)};
const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
const ready = keys.find((k) => !k.parked);
const op = process.argv[2];
fs.appendFileSync(file + '.log', op + '\\n');
if (!ready) { console.error(op === 'get' ? 'no usable key' : 'no usable key to park'); process.exit(1); }
if (op === 'get') process.stdout.write(ready.key);
else if (op === 'park') { ready.parked = true; fs.writeFileSync(file, JSON.stringify(keys)); console.log('parked "' + ready.name + '"'); }
`);
  return { kit, state };
}

// ElevenLabs as the rotation sees it: one answer per key.
const elevenLabs = (answers) => startServer((req) => {
  const key = req.headers['xi-api-key'];
  const a = answers[key] || { status: 401, json: { detail: { status: 'invalid_api_key' } } };
  return a;
});

test('tts.py walks every key: a spent key is parked and the next one used until one works', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('no python');
  const dir = tmp('tts-rotate');
  const api = await elevenLabs({ 'k-art': { status: 200, json: { audio: 'mp3' } }, 'k-suryo': { status: 401, json: { detail: { status: 'quota_exceeded', message: 'quota' } } }, 'k-sem': { status: 429, json: { detail: { status: 'too_many_concurrent_requests' } } } });
  try {
    const { kit, state } = fakeKit(dir, [['suryo', 'k-suryo'], ['sem', 'k-sem'], ['art', 'k-art']]);
    const driver = path.join(dir, 'drive.py');
    fs.writeFileSync(driver, `import sys, json\nsys.path.insert(0, ${JSON.stringify(SCRIPTS)})\nimport el_keys\nkeys = el_keys.Keys()\nout = el_keys.post('/text-to-speech/v', b'{}', {'Content-Type': 'application/json'}, 10, keys)\nprint(json.dumps({'out': out.decode(), 'tried': keys.tried}))\n`);
    const r = await runPython(py, [driver], { DEMO_KIT_DIR: kit, ELEVENLABS_API_BASE: api.url, ELEVENLABS_API_KEY: '' });
    assert.equal(r.code, 0, r.stderr);
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(got.out, '{"audio":"mp3"}');
    assert.deepEqual(got.tried, [['suryo', 'quota_exceeded'], ['sem', 'too_many_concurrent_requests']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')).map((k) => k.parked), [true, true, false]);
    assert.deepEqual(api.requests.map((q) => q.headers['xi-api-key']), ['k-suryo', 'k-sem', 'k-art']);
  } finally { await api.close(); rmrf(dir); }
});

test('tts.py fails only when every key is parked, naming each key tried and its reason; a non-key error parks nothing', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('no python');
  const dir = tmp('tts-parked');
  const api = await elevenLabs({ 'k-a': { status: 402, json: { detail: { status: 'quota_exceeded' } } }, 'k-b': { status: 403, json: { detail: 'detected_unusual_activity' } }, 'k-bad': { status: 400, json: { detail: { status: 'invalid_voice' } } } });
  try {
    const { kit } = fakeKit(dir, [['a', 'k-a'], ['b', 'k-b']]);
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'scenario.json'), JSON.stringify({ voice: { provider: 'elevenlabs', voiceId: 'v' }, steps: [{ lines: ['Halo semua'] }] }));
    const env = { DEMO_KIT_DIR: kit, ELEVENLABS_API_BASE: api.url, DEMO_KAMUS_FILE: path.join(dir, 'none.md') };
    const r = await runPython(py, [path.join(SCRIPTS, 'tts.py'), path.join(work, 'scenario.json')], env);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /ELEVENLABS ALL KEYS PARKED/);
    assert.match(r.stderr, /^ {2}a: quota_exceeded$/m);
    assert.match(r.stderr, /^ {2}b: detected_unusual_activity$/m);
    assert.match(r.stderr, /edge/);

    const other = fakeKit(path.join(dir, 'second'), [['bad', 'k-bad'], ['spare', 'k-a']]);
    const bad = await runPython(py, [path.join(SCRIPTS, 'tts.py'), path.join(work, 'scenario.json')], { ...env, DEMO_KIT_DIR: other.kit });
    assert.notEqual(bad.code, 0);
    assert.doesNotMatch(bad.stderr, /ALL KEYS PARKED/);
    assert.deepEqual(JSON.parse(fs.readFileSync(other.state, 'utf8')).map((k) => k.parked), [false, false], 'a 400 is not a spent key');
  } finally { await api.close(); rmrf(dir); }
});

test('align.py rotates the same way and falls back to an estimate, listing the keys, when every key is parked', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('no python');
  const dir = tmp('align-parked');
  const api = await elevenLabs({ 'k-a': { status: 429, json: { detail: { status: 'quota_exceeded' } } } });
  try {
    const { kit } = fakeKit(dir, [['a', 'k-a']]);
    fs.writeFileSync(path.join(dir, 'a_00_0.mp3'), 'mp3');
    fs.writeFileSync(path.join(dir, 'audio.json'), JSON.stringify([{ lines: [{ file: 'a_00_0.mp3', show: 'Halo semua', say: 'Halo semua', dur: 1.2 }] }]));
    const r = await runPython(py, [path.join(SCRIPTS, 'align.py'), path.join(dir, 'audio.json'), dir, path.join(dir, 'words.json')], { DEMO_KIT_DIR: kit, ELEVENLABS_API_BASE: api.url });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ELEVENLABS ALL KEYS PARKED/);
    assert.match(r.stdout, /a: quota_exceeded/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'words.json'), 'utf8'))['a_00_0.mp3'].source, 'estimate');
  } finally { await api.close(); rmrf(dir); }
});
