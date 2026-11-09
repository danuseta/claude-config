'use strict';
// kit/video-lock.cjs: a ticket whose video handoff is done gets no new video without the owner's own words.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAgent, checkCommand } = require('../video-lock.cjs');
const { decide } = require('../runner-announce.cjs');

const ledger = (handoffs) => () => JSON.stringify({ key: 'QRD-1511', handoffs });
const DONE = [{ who: 'video', status: 'done', where: 'https://x/QRD-1511.mp4' }];
const owner = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const deps = (handoffs, said = 'oke perbaiki!') => ({ readFile: ledger(handoffs), readTranscript: () => owner(said), root: '/ev' });
const video = (prompt) => ({ subagent_type: 'sous-video', prompt });

test('sous-video on a ticket whose video is done is refused, whatever the prompt says (QRD-1511, 9 Nov)', () => {
  assert.match(checkAgent(video('KEY=QRD-1511. Add the jump-into-closed-card scene and upload.'), 't', deps(DONE)), /video-lock: QRD-1511 already has its demo video/);
  assert.match(checkAgent(video('KEY=QRD-1511\nnew video: no'), 't', deps(DONE)), /video-lock/);
  assert.match(checkAgent(video('KEY=QRD-1511\nnew video: yes, owner: "bikin video ulang"'), 't', deps(DONE)), /video-lock/, 'the owner never wrote it');
});

test('the owner\'s own words, a first video, or a blocked first video let sous-video run', () => {
  assert.equal(checkAgent(video('KEY=QRD-1511\nnew video: yes, owner: "bikin video ulang"'), 't', deps(DONE, 'tolong bikin video ulang ya')), null);
  assert.equal(checkAgent(video('KEY=QRD-1511 first demo'), 't', deps([])), null);
  assert.equal(checkAgent(video('KEY=QRD-1511'), 't', deps([{ who: 'video', status: 'blocked' }])), null);
  assert.equal(checkAgent({ subagent_type: 'browser-verifier', prompt: 'KEY=QRD-1511' }, 't', deps(DONE)), null);
});

test('demo-upload on a ticket whose video is done is refused unless NEW_VIDEO_OWNER quotes the owner', () => {
  const cmd = 'node /home/coder/.claude/kit/demo-upload.cjs QRD-1511 /out/demo.mp4';
  assert.match(checkCommand(cmd, 't', deps(DONE)), /video-lock/);
  assert.match(checkCommand(`rtk proxy ${cmd}`, 't', deps(DONE)), /video-lock/);
  assert.equal(checkCommand(`NEW_VIDEO_OWNER="bikin video ulang" ${cmd}`, 't', deps(DONE, 'bikin video ulang dong')), null);
  assert.equal(checkCommand(cmd, 't', deps([])), null);
  assert.equal(checkCommand('node status.cjs show QRD-1511', 't', deps(DONE)), null);
});

test('runner-announce applies the lock to a runner\'s own sous-video dispatch', () => {
  const payload = { tool_name: 'Agent', agent_type: 'sous-ticket-runner', tool_input: video('KEY=QRD-1511 redo the scene'), transcript_path: 't' };
  assert.match(decide(payload, () => owner('oke perbaiki!'), () => {}, { readFile: ledger(DONE), root: '/ev' }), /video-lock/);
});
