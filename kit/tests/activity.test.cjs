'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const act = require('../activity.cjs');
const { maskString } = require('../dock-push.cjs');
const { KIT, tmp, rmrf } = require('./helpers.cjs');

const FIX = path.join(KIT, 'tests', 'fixtures', 'stream');
const readStream = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const masker = (extra = []) => (s) => maskString(String(s), { masked: 0, blobs: 0 }, extra);

// A tracker on a fake clock (every read moves it 100 ms) and the shipped label rules.
function tracker(opts = {}) {
  let t = Date.parse('2026-10-11T03:00:00.000Z');
  return act.createTracker({ mask: masker(opts.extra), labels: opts.labels || act.loadLabels(KIT), now: () => (t += 100), ...opts.tracker });
}
function replay(name, opts) {
  const t = tracker(opts);
  for (const o of readStream(name)) t.feed(o);
  return t;
}
const byId = (t) => Object.fromEntries(t.snapshot().map((r) => [r.id, r]));
const dump = (events) => JSON.stringify(events);
const toolUse = (id, name, input, parent = null) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent });
const toolResult = (id, content, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }, parent_tool_use_id: null });

// ---------- the recorded streams ----------
test('recorded turn 1: one Bash row and a thinking note; hooks that succeed are only counted; init is never a row', () => {
  const t = replay('turn-1-bash.jsonl');
  const rows = t.snapshot();
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.status]), [['tool', 'Bash', 'ok'], ['note', 'thinking', 'ok']]);
  assert.equal(rows[0].parentId, null);
  assert.equal(rows[0].agent, 'main');
  assert.ok(Date.parse(rows[0].endedAt) > Date.parse(rows[0].startedAt), 'duration present');
  assert.match(rows[1].summary, /^thought for 351 ms$/);
  assert.equal(t.stats().hooksOk, 6);
  assert.equal(t.stats().hooksFailed, 0);
  assert.ok(!dump(t.snapshot()).includes('model-fixture'), 'nothing of system/init leaks into a row');
});

test('recorded turn 2: the subagent row, its own Bash call nested under it, the handback hidden, the report in the detail', () => {
  const t = replay('turn-2-subagent.jsonl');
  const rows = t.snapshot();
  assert.deepEqual(rows.map((r) => [r.kind, r.status]), [['agent', 'ok'], ['tool', 'ok'], ['note', 'ok']]);
  const [agent, child] = rows;
  assert.equal(agent.name, 'general-purpose');
  assert.equal(agent.label.startsWith('Agent general-purpose: '), true);
  assert.equal(child.parentId, agent.id);
  assert.equal(child.agent, 'general-purpose');
  assert.match(agent.detail, /--- report ---/);
  assert.ok(Date.parse(agent.endedAt) > Date.parse(agent.startedAt));
  assert.ok(Date.parse(child.endedAt) > Date.parse(child.startedAt));
  assert.ok(!rows.some((r) => r.name === 'SubagentHandback'));
});

test('recorded turn 3 (partial flow): the failed command is an error row with its first error line', () => {
  const t = replay('turn-3-error-partial-excerpt.jsonl');
  const [bash] = t.snapshot();
  assert.equal(bash.status, 'error');
  assert.ok(bash.summary.length > 0);
  assert.equal(t.stats().running, 0);
});

test('a failed command keeps its exit code in the summary', () => {
  const rows = byId(replay('synthetic-denial.jsonl'));
  assert.equal(rows.toolu_SYN_D3.status, 'error');
  assert.match(rows.toolu_SYN_D3.summary, /^Exit code 2: ls: cannot access/);
});

// ---------- synthetic streams ----------
test('synthetic denial: guard text and a refused permission decision are denied; exit codes and OS "Permission denied" stay errors', () => {
  const rows = byId(replay('synthetic-denial.jsonl'));
  assert.equal(rows.toolu_SYN_D1.status, 'denied');
  assert.match(rows.toolu_SYN_D1.summary, /^Blocked: Blocked by guard/);
  assert.equal(rows.toolu_SYN_D2.status, 'denied');
  assert.equal(rows.toolu_SYN_D3.status, 'error');
  assert.equal(rows.toolu_SYN_D4.status, 'error');
  assert.equal(rows.toolu_SYN_D1.label, 'Git: push');
});

test('synthetic skill: a Skill row, an MCP row with key names only, a WebFetch row without its query string', () => {
  const rows = byId(replay('synthetic-skill.jsonl'));
  assert.deepEqual([rows.toolu_SYN_S1.kind, rows.toolu_SYN_S1.name, rows.toolu_SYN_S1.label, rows.toolu_SYN_S1.status], ['skill', 'brain-save', 'Skill: brain-save', 'ok']);
  assert.equal(rows.toolu_SYN_S1.summary, 'note about the DOCK activity test');
  assert.equal(rows.toolu_SYN_S2.label, 'MCP figma: get_metadata');
  assert.equal(rows.toolu_SYN_S2.summary, 'fileKey, nodeId');
  assert.ok(!dump(rows.toolu_SYN_S2).includes('abc123'), 'no input values for MCP tools');
  assert.equal(rows.toolu_SYN_S3.label, 'Fetch example.test');
  assert.equal(rows.toolu_SYN_S3.summary, 'example.test/docs/page');
  assert.ok(!dump(rows).includes('LONG MCP PAYLOAD') && !dump(rows).includes('Page body') && !dump(rows).includes('hunter2'));
});

test('synthetic Read, Edit, Write and Grep: path and counts, never the file content', () => {
  const rows = byId(replay('synthetic-read-edit.jsonl'));
  assert.equal(rows.toolu_SYN_R1.label, 'Read README.md');
  assert.match(rows.toolu_SYN_R1.summary, /README\.md \(lines 10-30\)/);
  assert.match(rows.toolu_SYN_R1.detail, /20 lines$/);
  assert.ok(!rows.toolu_SYN_R1.detail.includes('readme line'));
  assert.equal(rows.toolu_SYN_R2.detail, '/home/fixture/work/.env\n1 lines'.replace('1 lines', '2 lines'));
  assert.ok(!dump(rows.toolu_SYN_R2).includes('abc123'));
  assert.equal(rows.toolu_SYN_E1.label, 'Edit a.ts');
  assert.equal(rows.toolu_SYN_E1.detail, '/home/fixture/work/src/a.ts\nold: const a = 1;\nconst b = 2;\nnew: const a = 10;\nconst b = 20;');
  assert.equal(rows.toolu_SYN_E2.detail, '/home/fixture/work/.env.local', 'a sensitive path sends the path only');
  assert.match(rows.toolu_SYN_W1.detail, /\n15 lines\n/);
  assert.ok(rows.toolu_SYN_W1.detail.includes('note line 10') && !rows.toolu_SYN_W1.detail.includes('note line 11'));
  assert.equal(rows.toolu_SYN_G1.label, 'Search "useQuery"');
  assert.ok(rows.toolu_SYN_G1.detail.includes('useQuery line 10') && !rows.toolu_SYN_G1.detail.includes('useQuery line 11') && rows.toolu_SYN_G1.detail.endsWith('14 lines'));
  assert.ok(!dump(rows.toolu_SYN_G2).includes('abc123'), 'results from a sensitive path are not sent');
  assert.ok(!dump(rows.toolu_SYN_E2).includes('abc123'));
});

test('synthetic nested agents: the tree is capped at three levels, the plugin prefix is dropped from the agent name', () => {
  const rows = byId(replay('synthetic-nested-agents.jsonl'));
  assert.equal(rows.toolu_SYN_A1.parentId, null);
  assert.equal(rows.toolu_SYN_A2.parentId, 'toolu_SYN_A1');
  assert.equal(rows.toolu_SYN_A2.agent, 'explore');
  assert.equal(rows.toolu_SYN_A3.parentId, 'toolu_SYN_A2');
  assert.equal(rows.toolu_SYN_A4.parentId, 'toolu_SYN_A2', 'a fourth level is attached to level three');
  assert.equal(rows.toolu_SYN_A5.parentId, 'toolu_SYN_A2', 'and anything below it too');
  assert.equal(rows.toolu_SYN_A2.summary, 'Working on level two.', 'subagent text becomes the agent summary, not a chat bubble');
  assert.ok(Object.values(rows).every((r) => r.status === 'ok'));
  assert.match(rows.toolu_SYN_A1.detail, /Top level report\./);
});

test('synthetic hook with a non-zero exit: only failing hooks become rows, linked by matcher, never with stdout', () => {
  const t = replay('synthetic-hook-nonzero.jsonl');
  const hooks = t.snapshot().filter((r) => r.kind === 'hook');
  assert.equal(hooks.length, 2);
  assert.deepEqual(hooks.map((r) => [r.name, r.status, r.summary]), [['PreToolUse:Bash', 'denied', 'exit 2, blocking'], ['PostToolUse:Bash', 'error', 'exit 1, error']]);
  assert.ok(hooks.every((r) => r.parentId === null && r.detail === null));
  assert.equal(t.stats().hooksOk, 3);
  assert.ok(!dump(t.snapshot()).includes('stdout reason') && !dump(t.snapshot()).includes('hook crashed'));
  const off = replay('synthetic-hook-nonzero.jsonl', { tracker: { hooks: false } });
  assert.equal(off.snapshot().filter((r) => r.kind === 'hook').length, 0);
});

test('a hook inside a subagent is placed beside the tool it belongs to; when two tools match it goes to the turn', () => {
  const t = tracker();
  t.feed(toolUse('a1', 'Agent', { subagent_type: 'explore', description: 'x', prompt: 'p' }));
  t.feed(toolUse('b1', 'Bash', { command: 'ls' }, 'a1'));
  t.feed({ type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', exit_code: 1, outcome: 'error' });
  t.feed(toolUse('b2', 'Bash', { command: 'pwd' }, 'a1'));
  t.feed({ type: 'system', subtype: 'hook_response', hook_id: 'h2', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', exit_code: 1, outcome: 'error' });
  const rows = byId(t);
  assert.equal(rows['hook-1'].parentId, 'a1');
  assert.equal(rows['hook-2'].parentId, null, 'ambiguous: attached to the turn');
});

test('a stream cut off mid-turn: closeAll turns every running row into stopped, finished rows stay', () => {
  const t = replay('synthetic-cutoff.jsonl');
  assert.equal(t.stats().running, 3);
  t.closeAll('stopped');
  const rows = byId(t);
  assert.equal(rows.toolu_SYN_C1.status, 'ok');
  for (const id of ['toolu_SYN_C2', 'toolu_SYN_C3', 'toolu_SYN_C4']) { assert.equal(rows[id].status, 'stopped'); assert.ok(rows[id].endedAt); }
  assert.equal(rows.toolu_SYN_C4.parentId, 'toolu_SYN_C3');
  assert.equal(t.stats().running, 0);
});

test('the result event closes what is still running as stopped', () => {
  const t = tracker();
  t.feed(toolUse('x1', 'Bash', { command: 'sleep 5' }));
  t.feed({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(byId(t).x1.status, 'stopped');
});

test('consecutive thinking blocks are one row', () => {
  const t = tracker();
  const think = (ms) => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] }, thinking_duration_ms: ms });
  t.feed(think(400)); t.feed(think(700));
  t.feed(toolUse('x1', 'Bash', { command: 'ls' }));
  t.feed(think(100));
  const notes = t.snapshot().filter((r) => r.kind === 'note');
  assert.deepEqual(notes.map((r) => r.summary), ['thought for 1.1 s', 'thought for 100 ms']);
});

// ---------- caps and drop order ----------
test('2,000 tool calls: at most 400 rows; agents, skills, errors, denied and running rows are never dropped; the dropped counts add up', () => {
  const t = tracker();
  let most = 0;
  for (const o of readStream('synthetic-flood-2000.jsonl')) { t.feed(o); most = Math.max(most, t.stats().rows); }
  assert.ok(most <= 400, `most rows at once: ${most}`);
  const rows = t.snapshot();
  const kinds = (k) => rows.filter((r) => r.kind === k);
  assert.equal(kinds('agent').length, 6);
  assert.equal(kinds('skill').length, 3);
  assert.equal(rows.filter((r) => r.status === 'error').length, 12);
  assert.equal(rows.filter((r) => r.status === 'denied').length, 4);
  assert.equal(rows.filter((r) => r.status === 'stopped').length, 1, 'the call that never returned is closed by the result event, not dropped');
  const okTools = rows.filter((r) => r.kind === 'tool' && r.status === 'ok');
  const dropped = rows.filter((r) => r.name === 'dropped');
  const sum = dropped.reduce((n, r) => n + Number(r.summary), 0);
  assert.equal(okTools.length + sum, 2000 - 6 - 3 - 12 - 4 - 1, 'every ok tool call is either shown or counted');
  assert.ok(dropped.every((r) => r.label === `${r.summary} steps not shown` && r.kind === 'note'));
  assert.equal(rows.filter((r) => r.parentId === 'toolu_FLD_0050' && r.kind === 'tool').length, 0, 'nested ok calls go before top-level ones');
  assert.equal(byId(t)['dropped-toolu_FLD_0050'].summary, '60');
  assert.equal(byId(t)['dropped-toolu_FLD_0050'].parentId, 'toolu_FLD_0050');
  assert.equal(byId(t).dropped.parentId, null);
  for (const r of rows) assert.ok(Buffer.byteLength(JSON.stringify(r)) < 4096);
});

test('a flood of calls that have not returned yet is bounded in memory and the running ones are all kept up to the hard limit', () => {
  const t = tracker();
  for (let i = 0; i < 3000; i++) t.feed(toolUse(`r${i}`, 'Bash', { command: `sleep ${i}` }));
  assert.ok(t.stats().rows <= 1601);
  assert.equal(t.stats().running, 1600);
});

test('drop order: ok hooks, then notes, then nested detail, then nested ok tools (oldest first), then top-level ok tools', () => {
  const labels = act.builtinLabels();
  labels.hookRules = [{ re: /Stop/, label: 'Stop hook', kind: 'hook', show: true }];
  const t = tracker({ labels, tracker: { limits: { rows: 8 } } });
  const ids = () => t.snapshot().map((r) => r.id);
  const call = (id, parent) => { t.feed(toolUse(id, 'Bash', { command: `echo ${id}` }, parent)); t.feed(toolResult(id, id)); };
  t.feed({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'Stop', hook_event: 'Stop', exit_code: 0, outcome: 'success' });
  t.feed({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] }, thinking_duration_ms: 10 });
  t.feed(toolUse('A', 'Agent', { subagent_type: 'explore', description: 'a', prompt: 'p' }));
  call('N1', 'A'); call('N2', 'A'); call('N3', 'A'); call('T1'); call('T2');
  assert.deepEqual(ids(), ['hook-1', 'note-1', 'A', 'N1', 'N2', 'N3', 'T1', 'T2']);
  call('T3');
  assert.deepEqual(ids(), ['note-1', 'A', 'N1', 'N2', 'N3', 'T1', 'T2', 'T3'], '1: the ok hook goes first');
  call('T4');
  assert.deepEqual(ids(), ['A', 'N1', 'N2', 'N3', 'T1', 'T2', 'T3', 'T4'], '2: then the note');
  assert.ok(byId(t).N3.detail !== null);
  call('T5');
  assert.deepEqual(ids(), ['A', 'N3', 'T1', 'T2', 'T3', 'T4', 'T5', 'dropped-A'], '4: the oldest nested calls go before any top-level one');
  assert.equal(byId(t).N3.detail, null, '3: the detail of a surviving nested row was cut first');
  assert.equal(byId(t)['dropped-A'].summary, '2');
  call('T6');
  assert.deepEqual(ids(), ['A', 'T1', 'T2', 'T3', 'T4', 'T5', 'dropped-A', 'T6']);
  assert.equal(byId(t)['dropped-A'].summary, '3');
  call('T7');
  assert.deepEqual(ids(), ['A', 'T3', 'T4', 'T5', 'dropped-A', 'T6', 'T7', 'dropped'], '5: then the oldest top-level calls');
  assert.equal(byId(t).dropped.summary, '2');
  assert.equal(byId(t).dropped.label, '2 steps not shown');
});

test('a row the server has only seen as running is not dropped until its final state was sent', () => {
  const t = tracker({ tracker: { limits: { rows: 3 } } });
  t.feed(toolUse('T1', 'Bash', { command: 'echo 1' }));
  const sent = t.drain();
  assert.equal(sent[0].status, 'running');
  t.feed(toolResult('T1', '1'));
  t.feed(toolUse('T2', 'Bash', { command: 'echo 2' })); t.feed(toolResult('T2', '2'));
  t.feed(toolUse('T3', 'Bash', { command: 'echo 3' })); t.feed(toolResult('T3', '3'));
  t.feed(toolUse('T4', 'Bash', { command: 'echo 4' }));
  assert.ok(byId(t).T1, 'T1 is ok here but the server still thinks it runs');
  assert.equal(byId(t).T2, undefined);
  t.drain();
  t.feed(toolUse('T5', 'Bash', { command: 'echo 5' }));
  assert.equal(byId(t).T1, undefined, 'after its ok was sent it can go');
});

// ---------- drain, requeue, idempotence ----------
test('drain hands out each changed row once, in order, within the event and byte limits; requeue sends the same state again', () => {
  const t = replay('synthetic-denial.jsonl');
  const first = t.drain(3, 100 * 1024);
  assert.equal(first.length, 3);
  const rest = t.drain(50, 100 * 1024);
  assert.equal(first.length + rest.length, t.snapshot().length);
  assert.deepEqual(t.drain(), []);
  t.requeue(first);
  assert.deepEqual(t.drain(), first, 're-posting the same state gives the same events');
  const tight = replay('synthetic-read-edit.jsonl').drain(50, 1200);
  assert.ok(tight.length >= 1 && tight.length < 8, 'the byte budget limits a batch');
  assert.ok(Buffer.byteLength(JSON.stringify({ events: tight })) < 1200 + 512);
});

test('feeding the same lines twice changes nothing; a repeated tool_result does not reopen or rewrite a row', () => {
  const t = replay('synthetic-denial.jsonl');
  const before = t.snapshot();
  t.drain(500);
  for (const o of readStream('synthetic-denial.jsonl')) t.feed(o);
  assert.deepEqual(t.drain(), [], 'nothing to send again');
  assert.deepEqual(t.snapshot().map((r) => [r.id, r.status, r.summary]), before.map((r) => [r.id, r.status, r.summary]));
});

test('a status change is one more event for the same id', () => {
  const t = tracker();
  t.feed(toolUse('x1', 'Bash', { command: 'ls' }));
  const [running] = t.drain();
  t.feed(toolResult('x1', 'file'));
  const [ok] = t.drain();
  assert.equal(running.id, ok.id);
  assert.deepEqual([running.status, ok.status, running.endedAt], ['running', 'ok', null]);
  assert.ok(ok.endedAt);
  assert.deepEqual(Object.keys(ok), ['id', 'parentId', 'kind', 'agent', 'name', 'label', 'summary', 'detail', 'status', 'startedAt', 'endedAt']);
});

test('shapes that are not recognised are skipped, never thrown', () => {
  const t = tracker();
  const junk = [null, 5, 'x', [], {}, { type: 'assistant' }, { type: 'assistant', message: { content: 'text' } }, { type: 'assistant', message: { content: [null, 1, { type: 'tool_use' }, { type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Bash', id: 'a b!', input: 'oops' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }, { type: 'tool_result', tool_use_id: 'nope', content: { weird: true } }] } }, { type: 'user' }, { type: 'system', subtype: 'who_knows' }, { type: 'system', subtype: 'hook_response' },
    { type: 'system', subtype: 'task_notification' }, { type: 'stream_event', event: {} }, { type: 'rate_limit_event' }, { type: 'result' }];
  for (const o of junk) assert.doesNotThrow(() => t.feed(o));
  assert.equal(t.stats().errors, 0);
  const odd = t.snapshot().find((r) => r.id === 'a_b_');
  assert.ok(odd, 'an id with odd characters is made safe');
  assert.match(odd.id, /^[A-Za-z0-9_-]{1,80}$/);
});

test('an unknown tool result shape degrades to a generic row', () => {
  const t = tracker();
  t.feed(toolUse('q1', 'SomeNewTool', { alpha: 'secretvalue123', beta: 2 }));
  t.feed(toolResult('q1', [{ type: 'weird', data: 'secretvalue123' }], { is_error: true }));
  const row = byId(t).q1;
  assert.deepEqual([row.label, row.summary, row.status], ['SomeNewTool', 'Tool failed', 'error']);
  assert.equal(row.detail, 'alpha, beta');
  assert.ok(!dump(row).includes('secretvalue123'));
});

// ---------- masking ----------
// Built from pieces so that this file itself holds no secret-looking literal.
const J = (...parts) => parts.join('');
const CANARIES = [
  ['sk-', J('sk', '-CNRYaaaaaaaaaaaaaaaaaaaa')],
  ['sk_', J('sk', '_CNRYaaaaaaaaaaaaaaaaaaaaaaaa')],
  ['gh token', J('gh', 'p_CNRYaaaaaaaaaaaaaaaaaaaa')],
  ['github_pat_', J('github', '_pat_CNRYaaaaaaaaaaaaaaaaaaaa')],
  ['slack', J('xo', 'xb-CNRY-aaaaaaaaaaaa')],
  ['apikey_', J('api', 'key_CNRYaaaaaaaaaaaaaaaaaaaa')],
  ['dock_ing_', J('dock', '_ing_CNRYaaaaaaaaaaaaaaaaaaaaaaaa')],
  ['AIza', J('AI', 'zaCNRYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')],
  ['jwt', J('ey', 'JCNRYaaaaaa.eyJCNRYbbbbbb.CNRYcccccccc')],
  ['bearer', J('Bear', 'er CNRYaaaaaaaaaaaaaaaaaaaaaaaa')],
  ['private key', J('-----BEGIN RSA PRIV', 'ATE KEY-----\nCNRYkeybodykeybodykeybody\n-----END RSA PRIV', 'ATE KEY-----')],
  ['database url', J('post', 'gres://admin:CNRYpassword@db.internal/app')],
  ['password=', J('pass', 'word=CNRYhunter2hunter2')],
];
const leakOf = (canary) => (/^password=/.test(canary) ? 'CNRYhu' : /^postgres/.test(canary) ? 'CNRYpa' : canary.replace(/^Bearer /, '').replace(/^-----BEGIN RSA PRIV.*\n/, '').slice(0, 7));

for (const [name, canary] of CANARIES) {
  test(`canary ${name}: masked in a command, in output, across the output cut points, in a subagent report and in a hook's stdout`, () => {
    const leak = leakOf(canary);
    const t = tracker();
    t.feed(toolUse('c1', 'Bash', { command: `curl https://example.test/x?k=1 --data '${canary}'`, description: `uses ${canary}` }));
    t.feed(toolResult('c1', `before\n${canary}\nafter`));
    t.feed(toolUse('c2', 'Bash', { command: 'make' }));
    t.feed(toolResult('c2', 'x'.repeat(589) + ' ' + canary + ' ' + 'y'.repeat(3000) + ' ' + 'z'.repeat(300) + ' ' + canary + ' ' + 'w'.repeat(396)));
    t.feed(toolUse('c3', 'Bash', { command: 'make again' }));
    t.feed(toolResult('c3', 'x'.repeat(2999) + ' ' + canary + ' ' + 'y'.repeat(5600) + ' ' + canary + ' ' + 'z'.repeat(380)));
    t.feed(toolUse('c4', 'Agent', { subagent_type: `scout-${canary.slice(0, 5)}`, description: `look at ${canary}`, prompt: `use ${canary}` }));
    t.feed(toolUse('c5', 'Bash', { command: 'ls' }, 'c4'));
    t.feed({ type: 'assistant', message: { content: [{ type: 'text', text: `found ${canary}` }] }, parent_tool_use_id: 'c4' });
    t.feed(toolResult('c5', canary, { is_error: true }));
    t.feed(toolResult('c4', [{ type: 'text', text: `report start ${canary} ${'r'.repeat(579)} ${canary} ${'q'.repeat(1200)} ${canary} report end` }]));
    t.feed({ type: 'system', subtype: 'hook_started', hook_id: 'hk', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' });
    t.feed({ type: 'system', subtype: 'hook_response', hook_id: 'hk', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', exit_code: 2, outcome: 'blocking', stdout: canary, stderr: canary, output: canary });
    t.closeAll();
    const body = dump(t.drain(500));
    assert.ok(body.length > 500);
    assert.ok(!body.includes(leak), `${name}: ${leak} leaked`);
    assert.ok(!body.includes('CNRY'), `${name}: a piece of the canary leaked`);
  });
}

test('an extra mask word from the config is masked in every field', () => {
  const t = tracker({ extra: ['zorblax'] });
  t.feed(toolUse('z1', 'Agent', { subagent_type: 'zorblax-scout', description: 'zorblax job', prompt: 'zorblax' }));
  t.feed(toolUse('z2', 'mcp__zorblax__tool', { a: 1 }));
  t.feed(toolResult('z1', 'zorblax report'));
  assert.ok(!dump(t.drain()).includes('zorblax'));
});

test('header values are masked even when too short for a token pattern; command output still goes', () => {
  const t = tracker();
  t.feed(toolUse('h1', 'Bash', { command: `curl -H "Authorization: Bearer abc12" -H 'Cookie: sid=short; a=b' -H "X-Api-Key: k1" https://example.test` }));
  t.feed(toolResult('h1', 'HTTP/1.1 200 OK'));
  const ev = t.drain()[0];
  assert.ok(!/abc12|sid=short|k1"/.test(dump(ev)), dump(ev));
  assert.match(ev.detail, /Authorization: \*\*\*/);
  assert.match(ev.detail, /200 OK/);
});

test('five or more NAME=value lines make the whole event [hidden]', () => {
  const t = tracker();
  t.feed(toolUse('e1', 'Bash', { command: 'some-tool dump', description: 'dump' }));
  t.feed(toolResult('e1', 'ALPHA_ONE=1\nBETA_TWO=2\nGAMMA_THREE=3\nDELTA_FOUR=4\nEPSILON_FIVE=5\n'));
  t.feed(toolUse('e2', 'Bash', { command: 'some-tool dump', description: 'dump' }));
  t.feed(toolResult('e2', 'ALPHA_ONE=1\nBETA_TWO=2\nGAMMA_THREE=3\nDELTA_FOUR=4\n'));
  const rows = byId(t);
  assert.deepEqual([rows.e1.detail, rows.e1.summary, rows.e1.label], ['[hidden]', '[hidden]', 'Bash: dump']);
  assert.ok(rows.e2.detail.includes('DELTA_FOUR=4'));
});

test('an event larger than 4 KB is cut down (detail first)', () => {
  const t = tracker();
  t.feed(toolUse('big', 'Bash', { command: 'echo ' + 'a'.repeat(3000), description: 'd'.repeat(500) }));
  t.feed(toolResult('big', Array.from({ length: 200 }, (_, i) => `line ${i} ${'b'.repeat(60)}`).join('\n')));
  const [ev] = t.drain();
  assert.ok(Buffer.byteLength(JSON.stringify(ev)) <= 4096);
  assert.ok(ev.label.length <= 120 && ev.summary.length <= 200 && ev.detail.length <= 2000);
});

test('long command output is cut to 600 + 400 characters with a line count between', () => {
  const t = tracker();
  t.feed(toolUse('o1', 'Bash', { command: 'make' }));
  t.feed(toolResult('o1', Array.from({ length: 400 }, (_, i) => `row-${String(i).padStart(3, '0')}`).join('\n')));
  const detail = t.drain()[0].detail;
  assert.match(detail, /\$ make\nrow-000/);
  assert.match(detail, /\n… \[\d+ lines cut\] …\n/);
  assert.ok(detail.endsWith('row-399'));
  assert.ok(detail.length <= 1000 + 1000 + 40);
});

// ---------- the never-send list ----------
const SENSITIVE = [
  'env', 'printenv', 'printenv DOCK_INGEST_TOKEN', 'rtk env', 'rtk proxy printenv', 'sudo env', 'sudo -u bob printenv', 'env | sort', 'bash -lc "printenv | head -5"', "bash -lc 'cd /x && env'", 'echo hi && env', 'FOO=1 env', 'set', 'export -p', 'export', 'declare -x', 'Get-ChildItem Env:', 'gci env:', 'powershell -Command "Get-ChildItem Env:"', 'echo $env:DOCK_INGEST_TOKEN', 'echo $DOCK_INGEST_TOKEN', 'echo ${API_KEY}', 'echo %TOKEN%', '[Environment]::GetEnvironmentVariables()',
  'cat .env', 'cat .env.local', 'cat ./app/.env.production', 'less secrets.env', 'head -5 secrets.env', 'tail -f credentials.json', 'type credentials.json', 'Get-Content .\\dock.json', 'Get-Content -Path C:\\Users\\danus\\.claude-kantor\\secrets.local.json', 'rtk read .env', 'bat ~/.config/claude-config/secrets.env', "sed -n '1,5p' .env", 'grep TOKEN .env', 'rg KEY .env.local', 'rg x ~/.npmrc', 'cat ~/.netrc', 'cat id_rsa', 'head -c 100 ~/.ssh/id_ed25519', 'cat server.pem', 'cat private.key', 'cat ~/.claude/kit/dock.json', 'cat dock-chat.json', 'cat .credentials.json', 'cat elevenlabs-keys.json', 'cat mcp.json', 'cat ~/.claude.json', 'cat /proc/self/environ', 'cat ~/.aws/credentials', 'rtk proxy cat .env', "bash -lc 'cat .env | head'", 'cd /x && cat .env', 'sudo cat /etc/shadow', 'cat my-client-secret.json',
  'gh auth token', 'gh auth status -t', 'gh auth status --show-token', 'rtk gh auth token', 'aws configure list', 'aws sts get-caller-identity', 'coder tokens list', 'tailscale status', 'tailscale up', 'ccfg secret get X', 'npm token list', 'docker login', 'git credential fill', "bash -lc 'gh auth token'", 'echo x | gh auth token',
];
const NOT_SENSITIVE = ['git status', 'ls -la', 'npm test', 'node --test kit/tests', 'cat README.md', 'env FOO=1 node a.js', 'rtk git diff', 'python3 ~/brain/scripts/brain.py retrieve "review PR verdict"', 'rg useQuery src', 'git log --grep=secret', 'echo hello', 'gh pr view 12', 'npm run build', 'sed -n 1,5p src/a.ts', 'cat package.json'];

test('the never-send list: these commands send their label and no output', () => {
  for (const c of SENSITIVE) assert.equal(act.isSensitiveCommand(c), true, c);
});
test('ordinary commands are not hidden', () => {
  for (const c of NOT_SENSITIVE) assert.equal(act.isSensitiveCommand(c), false, c);
});
test('sensitive paths', () => {
  for (const p of ['/x/.env', '.env.local', 'C:\\work\\.env', '/home/u/secrets.env', '/home/u/.ssh/config', 'a/b/credentials.json', 'k.pem', '/x/id_rsa', 'mcp.json', '/x/dock.json', '/home/u/.config/claude-config/secrets.env']) assert.equal(act.isSensitivePath(p), true, p);
  for (const p of ['/x/src/a.ts', 'README.md', '/x/package.json', 'environment.ts', '']) assert.equal(act.isSensitivePath(p), false, p);
});

test('a sensitive command is shown by label and command only; its output never reaches a row', () => {
  const t = tracker();
  const run = (id, command, out) => { t.feed(toolUse(id, 'Bash', { command })); t.feed(toolResult(id, out)); };
  run('p1', 'printenv', 'DOCK_INGEST_TOKEN=OUTPUT_CANARY_1\nHOME=/x');
  run('p2', 'rtk proxy env', 'OUTPUT_CANARY_2');
  run('p3', "bash -lc 'cat ~/.claude/kit/dock.json'", 'OUTPUT_CANARY_3');
  run('p4', 'cd x && gh auth token', 'OUTPUT_CANARY_4');
  run('p5', 'cat .env | head', 'OUTPUT_CANARY_5');
  run('p6', 'git status', 'OUTPUT_CANARY_VISIBLE');
  const rows = byId(t);
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) assert.match(rows[id].detail, /\[output hidden: sensitive command\]$/, id);
  assert.ok(!dump(t.snapshot()).match(/OUTPUT_CANARY_[1-5]/));
  assert.ok(rows.p6.detail.endsWith('OUTPUT_CANARY_VISIBLE'));
});

test('Read, Edit and Write of a sensitive path send the path only, Grep sends no results', () => {
  const t = tracker();
  t.feed(toolUse('s1', 'Read', { file_path: '/w/secrets.env' })); t.feed(toolResult('s1', 'OUTPUT_CANARY=1'));
  t.feed(toolUse('s2', 'Write', { file_path: '/w/.env', content: 'A=CONTENT_CANARY\nB=2' })); t.feed(toolResult('s2', 'ok'));
  t.feed(toolUse('s3', 'Edit', { file_path: '/w/credentials.json', old_string: 'CONTENT_CANARY', new_string: 'CONTENT_CANARY2' })); t.feed(toolResult('s3', 'ok'));
  t.feed(toolUse('s4', 'Grep', { pattern: 'A', path: '/w/.env' })); t.feed(toolResult('s4', 'A=OUTPUT_CANARY'));
  const body = dump(t.snapshot());
  assert.ok(!/CANARY/.test(body), body);
  assert.equal(byId(t).s2.detail, '/w/.env');
});

// ---------- label rules ----------
const LABELS = [
  ["python3 ~/brain/scripts/brain.py retrieve 'review PR verdict'", "Brain: retrieve 'review PR verdict'"],
  ['python3 ~/brain/scripts/brain.py search "kit tests"', "Brain: search 'kit tests'"],
  ['python3 ~/brain/scripts/brain.py save --title x', 'Brain: save'],
  ['python3 ~/brain/scripts/brain.py status', 'Brain: status'],
  ["bash -lc \"python3 ~/brain/scripts/brain.py retrieve 'review PR verdict'\"", "Brain: retrieve 'review PR verdict'"],
  ["bash -lc 'python3 ~/brain/scripts/brain.py retrieve \"review PR verdict\"'", "Brain: retrieve 'review PR verdict'"],
  ['rtk python3 ~/brain/scripts/brain.py retrieve "review PR verdict"', "Brain: retrieve 'review PR verdict'"],
  ['cd /home/coder/projects && python3 ~/brain/scripts/brain.py search "x y"', "Brain: search 'x y'"],
  ['powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/brain-retrieve.ps1 "review PR verdict"', "Brain: retrieve 'review PR verdict'"],
  ['rtk powershell -NoProfile -File E:\\obsidian\\Brain\\scripts\\brain-retrieve.ps1 "review PR verdict"', "Brain: retrieve 'review PR verdict'"],
  ['rtk proxy powershell -File E:/obsidian/Brain/scripts/brain-search.ps1 "kit tests"', "Brain: search 'kit tests'"],
  ['powershell -Command "& \'E:/obsidian/Brain/scripts/brain-retrieve.ps1\' \'review PR verdict\'"', "Brain: retrieve 'review PR verdict'"],
  ['powershell -NoProfile -File E:/obsidian/Brain/scripts/save_and_ingest.ps1 -Title x', 'Brain: save raw note and ingest'],
  ['rtk git status', 'Git: status'],
  ['cd E:/qonflo && git diff --stat', 'Git: diff'],
  ['git -C C:/work log --oneline', 'Git: log'],
  ['gh pr view 12', 'PR: view'],
  ['rtk gh issue list', 'GitHub: issue list'],
  ['npm test', 'npm test'],
  ['pnpm run build:app', 'pnpm build:app'],
  ['rtk proxy npm run lint --workspace=frontend', 'npm lint'],
  ['npx vitest run src/a.test.ts', 'Run vitest'],
  ['rtk tsc --noEmit', 'Run tsc'],
  ['node --test kit/tests', 'Run node tests'],
  ['qonflo-dev start', 'Qonflo dev: start'],
  ['graphify query "who calls send"', "Graphify: query 'who calls send'"],
  ['playwright-cli open http://localhost:5173', 'Playwright: open http://localhost:5173'],
  ['rtk rg "useQuery" src', 'Search: useQuery'],
  ['rtk read src/a.ts', 'Read a.ts'],
  ['bd ready', 'Beads: ready'],
  ['sudo -u bob git push', 'Git: push'],
  ['node kit/status.cjs QRD-1 stage', 'Ledger: QRD-1 stage'],
];
test('label rules: brain commands on both systems, through rtk, bash -lc, cd && and sudo, plus git, gh, npm, qonflo-dev, graphify, playwright-cli', () => {
  const labels = act.loadLabels(KIT);
  for (const [cmd, want] of LABELS) assert.equal(act.commandInfo(cmd, labels).label, want, cmd);
  assert.equal(act.commandInfo('some-unknown-tool --flag', labels).label, null);
});
test('the built-in rules alone label the brain and git commands too (the fallback when the file is broken)', () => {
  const labels = act.builtinLabels();
  for (const [cmd, want] of LABELS.slice(0, 15)) assert.equal(act.commandInfo(cmd, labels).label, want, cmd);
});
test('a Bash row without a rule is labelled by its description, else plain Bash; a matching rule wins', () => {
  const t = tracker();
  t.feed(toolUse('l1', 'Bash', { command: 'make all', description: 'Build everything' }));
  t.feed(toolUse('l2', 'Bash', { command: 'make all' }));
  t.feed(toolUse('l3', 'Bash', { command: 'git status', description: 'Show status' }));
  const rows = byId(t);
  assert.deepEqual([rows.l1.label, rows.l2.label, rows.l3.label], ['Bash: Build everything', 'Bash', 'Git: status']);
});
test('a label filled from the command is masked after it is filled', () => {
  const labels = act.loadLabels(KIT);
  const t = tracker({ labels });
  t.feed(toolUse('m1', 'Bash', { command: `python3 ~/brain/scripts/brain.py retrieve "${J('dock', '_ing_CNRYaaaaaaaaaaaaaaaaaaaaaaaa')}"` }));
  assert.ok(!dump(t.drain()).includes('CNRY'));
});

test('labels: the owner can add a rule by editing the JSON; a local file wins; the file is re-read when its mtime changes', () => {
  const dir = tmp('labels');
  try {
    const problems = [];
    fs.writeFileSync(path.join(dir, 'activity-labels.json'), JSON.stringify({ rules: [{ match: 'deploy\\.sh (\\w+)', label: 'Deploy: $1' }, { match: 'brain', label: 'shared brain' }] }));
    const labels = act.loadLabels(dir, (m) => problems.push(m));
    assert.equal(act.commandInfo('./deploy.sh prod', labels).label, 'Deploy: prod');
    fs.writeFileSync(path.join(dir, 'activity-labels.local.json'), JSON.stringify({ rules: [{ match: 'brain', label: 'local brain' }] }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'activity-labels.local.json'), future, future);
    labels.refresh();
    assert.equal(act.commandInfo('run brain', labels).label, 'local brain');
    assert.equal(act.commandInfo('./deploy.sh prod', labels).label, 'Deploy: prod');
    assert.deepEqual(problems, []);
    assert.equal(act.commandInfo('hide-me', Object.assign(act.loadLabels(dir), {})).label, null);
    fs.writeFileSync(path.join(dir, 'activity-labels.json'), JSON.stringify({ rules: [{ match: 'hide-me', label: 'Hidden one', hideOutput: true }] }));
    fs.utimesSync(path.join(dir, 'activity-labels.json'), new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    labels.refresh();
    assert.deepEqual(act.commandInfo('hide-me', labels), { label: 'Hidden one', hide: true });
  } finally { rmrf(dir); }
});

test('labels: a broken JSON file falls back to the built-in rules and is reported once; a broken regex skips that rule only', () => {
  const dir = tmp('labels-broken');
  try {
    const problems = [];
    fs.writeFileSync(path.join(dir, 'activity-labels.json'), '{ "rules": [ oops');
    const labels = act.loadLabels(dir, (m) => problems.push(m));
    labels.refresh(); labels.refresh();
    assert.equal(act.commandInfo('git status', labels).label, 'Git: status', 'built-in rules');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /activity-labels\.json is not valid JSON/);
    fs.writeFileSync(path.join(dir, 'activity-labels.json'), JSON.stringify({ rules: [{ match: '([unclosed', label: 'bad' }, { match: 'good (\\w+)', label: 'Good: $1' }, { label: 'no match field' }] }));
    fs.utimesSync(path.join(dir, 'activity-labels.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    labels.refresh();
    assert.equal(act.commandInfo('good thing', labels).label, 'Good: thing');
    assert.equal(problems.length, 3, 'one report per skipped rule');
    const empty = tmp('labels-none');
    try {
      const p2 = [];
      const l2 = act.loadLabels(empty, (m) => p2.push(m));
      assert.equal(act.commandInfo('git log', l2).label, 'Git: log');
      assert.equal(p2.length, 1);
    } finally { rmrf(empty); }
  } finally { rmrf(dir); }
});

test('the shipped activity-labels.json loads without a single problem', () => {
  const problems = [];
  const labels = act.loadLabels(KIT, (m) => problems.push(m));
  assert.deepEqual(problems, []);
  assert.ok(labels.rules.length >= 20 && labels.hookRules.length === 2);
});

test('a hook rule with show:true makes a successful hook visible', () => {
  const labels = act.loadLabels(KIT);
  const t = tracker({ labels });
  t.feed({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'claude-hook-autosave', hook_event: 'Stop', exit_code: 0, outcome: 'success' });
  assert.deepEqual(t.snapshot().map((r) => [r.kind, r.label, r.status]), [['hook', 'Brain: autosave', 'ok']]);
});
