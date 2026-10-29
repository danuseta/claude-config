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
);

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
