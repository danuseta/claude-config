'use strict';
// kit/runner-announce.cjs: the sous lead must write its "Runner jalan:" line before every runner dispatch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../runner-announce.cjs');

const owner = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const meta = (text) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: text } });
const result = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const say = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id, name, subagent_type) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { subagent_type } }] } });
const side = (text) => JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text }] } });

const dispatch = (lines, extra = {}) => decide(
  { tool_name: 'Agent', tool_input: { subagent_type: 'sous-ticket-runner' }, transcript_path: 't.jsonl', tool_use_id: 'now', ...extra },
  () => lines.join('\n'),
  () => {},
);

test('a line in the dispatching message that reaches the transcript after the hook starts still counts (QRD-1286)', () => {
  const full = [owner('lanjut'), say('Runner jalan: D-24 -> T1 -> FINAL -> video -> push.'), call('now', 'Agent', 'sous-ticket-runner')];
  let reads = 0;
  const flushLate = () => (reads++ < 3 ? full.slice(0, 1) : full).join('\n');
  assert.equal(decide({ tool_name: 'Agent', tool_input: { subagent_type: 'sous-ticket-runner' }, transcript_path: 't', tool_use_id: 'now' }, flushLate, () => {}), null);
  assert.equal(reads, 4);
});

test('the wait ends at once when the dispatch is written without the line, and gives up when it is never written', () => {
  let sleeps = 0;
  const count = () => { sleeps += 1; };
  const without = [owner('lanjut'), call('now', 'Agent', 'sous-ticket-runner')].join('\n');
  assert.match(decide({ tool_name: 'Agent', tool_input: { subagent_type: 'sous-ticket-runner' }, transcript_path: 't', tool_use_id: 'now' }, () => without, count), /runner-announce/);
  assert.equal(sleeps, 0);
  assert.match(decide({ tool_name: 'Agent', tool_input: { subagent_type: 'sous-ticket-runner' }, transcript_path: 't', tool_use_id: 'now' }, () => owner('lanjut'), count), /runner-announce/);
  assert.equal(sleeps, 20);
});

test('a runner dispatch without the line since the owner prompt is refused (QRD-1426)', () => {
  const lines = [owner('Pakai skill sous: kerjakan QRD-1426. Cron run: ...'), say('Skills: ticket, sous / using: sous'), meta('Base directory for this skill'), result(), call('now', 'Agent', 'sous-ticket-runner')];
  assert.match(dispatch(lines), /Runner jalan:/);
});

test('the line after the owner prompt lets the dispatch through, a subagent text does not count', () => {
  const ok = [owner('kerjakan QRD-1'), say('Runner jalan: intake -> planner -> T1 -> FINAL -> video -> PR draft.'), result(), call('now', 'Agent', 'sous-ticket-runner')];
  assert.equal(dispatch(ok), null);
  assert.equal(dispatch(ok.slice(0, 3)), null, 'the current call not yet in the transcript');
  assert.match(dispatch([owner('kerjakan QRD-1'), side('Runner jalan: x'), call('now', 'Agent', 'sous-ticket-runner')]), /runner-announce/);
});

test('a line before the owner last prompt or before the last runner dispatch does not cover a new one', () => {
  assert.match(dispatch([say('Runner jalan: x'), owner('lanjut'), call('now', 'Agent', 'sous-ticket-runner')]), /runner-announce/);
  assert.match(dispatch([owner('go'), say('Runner jalan: x'), call('a', 'Agent', 'sous-ticket-runner'), result(), call('now', 'Agent', 'sous-review-runner')], { tool_input: { subagent_type: 'sous-review-runner' } }), /runner-announce/);
  assert.equal(dispatch([owner('go'), call('a', 'Agent', 'sous-ticket-runner'), result(), say('Runner jalan: y'), call('now', 'Agent', 'sous-ticket-runner')]), null);
});

test('other agents, subagent calls, other tools and an unreadable transcript get no answer', () => {
  const silent = [owner('go')];
  assert.equal(dispatch(silent, { tool_input: { subagent_type: 'sous-explorer' } }), null);
  assert.equal(dispatch(silent, { agent_type: 'sous-ticket-runner' }), null);
  assert.equal(dispatch(silent, { tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  assert.equal(dispatch(silent, { transcript_path: '' }), null);
  assert.equal(decide({ tool_name: 'Task', tool_input: { subagent_type: 'sous-work-runner' }, transcript_path: 'x' }, () => { throw new Error('ENOENT'); }), null);
  assert.match(dispatch(silent, { tool_name: 'Task', tool_input: { subagent_type: 'sous-work-runner' } }), /runner-announce/);
});

test('a dispatch the hook refused does not use up the line written before it (QRD-1286)', () => {
  const refused = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'PreToolUse:Agent hook error: runner-announce: write one line ...' }] } });
  assert.equal(dispatch([owner('go'), say('Runner jalan: T1 -> FINAL -> push.'), call('a', 'Agent', 'sous-ticket-runner'), refused, call('now', 'Agent', 'sous-ticket-runner')]), null);
  const ran = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'runner done' }] } });
  assert.match(dispatch([owner('go'), say('Runner jalan: T1'), call('a', 'Agent', 'sous-ticket-runner'), ran, call('now', 'Agent', 'sous-ticket-runner')]), /runner-announce/);
});
