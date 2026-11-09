'use strict';
// kit/deploy-gate.cjs: a Jira transition to UAT CHECK waits until DOCK says the ticket's merge is deployed (QRD-1292, 4 Nov).
const test = require('node:test');
const assert = require('node:assert/strict');
const { uatCheckGate, isToUatCheck } = require('../deploy-gate.cjs');

const owner = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (input, tool = 'mcp__claude_ai_Atlassian__transitionJiraIssue') => ({ tool_name: tool, tool_input: input, transcript_path: 't' });
const dockSays = (result, status = 200) => async () => ({ status, result });
const deps = (send, said = 'pindahin ke uat check') => ({ send, settings: {}, readTranscript: () => owner(said), timeoutMs: 10 });

test('a transition to UAT CHECK before the BE deploy finished is refused (QRD-1292)', async () => {
  const notReady = dockSays({ ready: false, summary: 'qonekid/ms-admin-worker-backend#1342 deploying (deploy.uat.yml is in_progress)', repos: [] });
  const reason = await uatCheckGate(call({ issueIdOrKey: 'QRD-1292', transition: { id: '3' } }), deps(notReady));
  assert.match(reason, /uat-gate: QRD-1292 is not deployed to UAT yet/);
  assert.match(reason, /#1342 deploying/);
});

test('ready, another transition, another tool, or the owner\'s quoted override lets it through', async () => {
  const ready = dockSays({ ready: true, summary: 'deployed', repos: [] });
  assert.equal(await uatCheckGate(call({ issueIdOrKey: 'QRD-1292', transition: { id: '3' } }), deps(ready)), null);
  const never = async () => { throw new Error('should not ask DOCK'); };
  assert.equal(await uatCheckGate(call({ issueIdOrKey: 'QRD-1292', transition: { id: '5' } }), deps(never)), null, 'UAT MERGED');
  assert.equal(await uatCheckGate(call({ issueIdOrKey: 'QRD-1292' }, 'mcp__atlassian__getJiraIssue'), deps(never)), null);
  const notReady = dockSays({ ready: false, summary: 'deploying', repos: [] });
  const override = call({ issueIdOrKey: 'QRD-1292', transition: { id: '3' }, comment: 'DEPLOY_GATE_OVERRIDE="pindahin ke uat check"' });
  assert.equal(await uatCheckGate(override, deps(notReady, 'udah deploy manual, pindahin ke uat check aja')), null);
  assert.match(await uatCheckGate(override, deps(notReady, 'go')), /not deployed/, 'words the owner never wrote');
});

test('DOCK not answering refuses the move instead of letting it through', async () => {
  const down = async () => ({ status: 502, error: 'bad gateway' });
  assert.match(await uatCheckGate(call({ issueIdOrKey: 'QRD-1', transition: { id: '3' } }), deps(down)), /did not answer \(DOCK answered 502 bad gateway\)/);
  assert.match(await uatCheckGate(call({ issueIdOrKey: 'QRD-1', transition: { id: '3' } }), deps(async () => ({ skipped: true }))), /not configured/);
});

test('UAT CHECK is found by transition id or name; ids come from uat-gate.json', () => {
  assert.equal(isToUatCheck({ transition: { id: '3' } }, {}), true);
  assert.equal(isToUatCheck({ transition: { name: 'UAT CHECK' } }, {}), true);
  assert.equal(isToUatCheck({ transition: { id: '41' } }, { uatCheckTransitionIds: ['41'] }), true);
  assert.equal(isToUatCheck({ transition: { id: '4' } }, {}), false);
});
