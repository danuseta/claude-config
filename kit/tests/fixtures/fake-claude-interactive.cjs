'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const env = process.env;
const args = process.argv.slice(2);

if (args[0] === '--help') {
  process.stdout.write('Usage: claude [options]\n  --verbose  Override verbose mode\n  --include-hook-events  Include hooks\n  --forward-subagent-text  Forward text\n'
    + (env.FAKE_NO_INTERACTIVE ? '' : '  --input-format <format>  Input format (stream-json)\n  --permission-prompts <mode>  Where permission prompts go (host)\n')
    + (env.FAKE_NO_INTERACTIVE || env.FAKE_NO_REPLAY ? '' : '  --replay-user-messages  Re-emit user messages from stdin back on stdout\n'));
  process.exit(0);
}

const record = (o) => {
  if (!env.FAKE_LOG_DIR) return;
  try { fs.appendFileSync(path.join(env.FAKE_LOG_DIR, `${process.pid}.jsonl`), JSON.stringify(o) + '\n'); } catch {}
};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
record({ type: 'argv', args, pid: process.pid, env: { turn: env.DOCK_CHAT_TURN, cfg: env.CLAUDE_CONFIG_DIR } });

const sessionId = env.FAKE_SESSION || 'fake-sess-1';
const script = JSON.parse(env.FAKE_SCRIPT || '[]');
const asks = new Map();
const decisions = {};
const waiters = [];
const replay = args.includes('--replay-user-messages');
const steers = [];
let interrupted = false, started = false, finished = false;
const wake = () => waiters.splice(0).forEach((f) => f());
const until = async (pred) => { while (!pred() && !interrupted) await new Promise((r) => waiters.push(r)); };
const textOf = (m) => m.message.content.map((b) => b.text).join('');
const readSteers = () => {
  const read = steers.splice(0);
  if (replay) for (const m of read) emit({ type: 'user', isReplay: true, uuid: m.uuid, session_id: sessionId, message: m.message, parent_tool_use_id: null });
  return read;
};
// Like claude, a message written after the script ended is read as the next turn of the same process.
const nextTurn = () => {
  if (!finished || interrupted || !steers.length) return;
  const read = readSteers();
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `steered: ${read.map(textOf).join(' | ')}` }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, ...(env.FAKE_NEXT_COST ? { total_cost_usd: Number(env.FAKE_NEXT_COST) } : {}) });
};
const ok = (requestId, response) => emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

const settingsArg = argOf('--settings') || '';
const initialize = () => ({
  commands: [
    { name: 'context', description: 'Show context usage', argumentHint: '', builtin: true },
    { name: 'doctor', description: 'Diagnose', argumentHint: '', builtin: true },
    { name: 'model', description: 'Pick a model', argumentHint: '', builtin: true },
    { name: 'review', description: 'Review a PR with token sk-CNRYaaaaaaaaaaaaaaaaaaaa', argumentHint: '<pr>' },
  ],
  agents: [{ name: 'explore', description: 'x', model: 'haiku' }],
  models: [
    { value: 'sonnet', displayName: 'Sonnet', description: 'x', supportedEffortLevels: ['low', 'medium', 'high'], supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku', description: 'x', supportsFastMode: false },
  ],
  fast_mode_state: settingsArg.includes('fastMode') ? (env.FAKE_FAST_STATE || 'off') : 'off',
  fast_mode_disabled_reason: 'extra_usage_disabled',
  current_permission_mode: 'default',
  claude_code_version: '2.1.296',
  account: { email: 'canary-account@example.test' },
});
const initEvent = () => ({
  type: 'system', subtype: 'init', session_id: sessionId, model: argOf('--model') || 'default-model', permissionMode: argOf('--permission-mode') || 'default',
  capabilities: env.FAKE_NO_INTERRUPT_CAP ? [] : ['interrupt_receipt_v1'], terminal_slash_commands: ['doctor', 'color'], slash_commands: ['context', 'review'],
});

function control(o) {
  const id = o.request_id, sub = o.request && o.request.subtype;
  if (sub === 'initialize') return ok(id, initialize());
  if (sub === 'interrupt') {
    if (env.FAKE_IGNORE_INTERRUPT) return;
    for (const [aid, a] of asks) if (!a.resolved) emit({ type: 'control_cancel_request', request_id: aid });
    ok(id, { still_queued: [] });
    if (!env.FAKE_NO_RESULT_ON_INTERRUPT) emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', session_id: sessionId });
    interrupted = true;
    return wake();
  }
  if (sub === 'set_permission_mode' || sub === 'set_model') return ok(id, {});
  emit({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported control request subtype' } });
}

async function run() {
  for (const step of script) {
    if (interrupted) return;
    if (step.say != null) emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: step.say }] } });
    else if (step.tool) emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: step.tool.id, name: step.tool.name, input: step.tool.input || {} }] } });
    else if (step.ask) {
      const a = step.ask;
      asks.set(a.id, { resolved: false });
      emit({ type: 'control_request', request_id: a.id, request: { subtype: 'can_use_tool', tool_name: a.tool_name, display_name: a.tool_name, input: a.input || {}, description: a.description || '', permission_suggestions: a.suggestions || [], tool_use_id: `tu-${a.id}`, agent_id: a.agent_id || null, blocked_path: null, decision_reason: null } });
    } else if (step.awaitAsks) await until(() => [...asks.values()].every((a) => a.resolved));
    else if (step.awaitAsk) await until(() => asks.get(step.awaitAsk) && asks.get(step.awaitAsk).resolved);
    else if (step.cancelAsk) { emit({ type: 'control_cancel_request', request_id: step.cancelAsk }); asks.get(step.cancelAsk).resolved = true; }
    else if (step.sayDecisions) emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `DECISIONS ${JSON.stringify(decisions)}` }] } });
    else if (step.sleep) await Promise.race([new Promise((r) => setTimeout(r, step.sleep)), until(() => false)]);
    else if (step.init) emit(initEvent());
    else if (step.awaitSteer) await until(() => steers.length > 0);
    else if (step.readSteers) emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `read: ${readSteers().map(textOf).join(' | ')}` }] } });
    else if (step.result) emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, ...step.result });
    else if (step.hang) await until(() => false);
    else if (step.bigLine) await new Promise((r) => { process.stdout.write(Buffer.alloc(step.bigLine, 120), () => process.stdout.write('\n', r)); });
    else if (step.detach) {
      const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', step.detach === 'inherit' ? 'inherit' : 'ignore', 'ignore'], windowsHide: true });
      g.unref();
      record({ type: 'detached', pid: g.pid });
    } else if (step.spawnTree) {
      const code = 'const {spawn}=require("child_process");const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});process.stdout.write(g.pid+"\\n");setInterval(()=>{},1000)';
      const c = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      await new Promise((resolve) => c.stdout.once('data', (d) => { record({ type: 'tree', child: c.pid, grand: Number(String(d).trim()) }); resolve(); }));
    }
  }
}

if (!args.includes('--input-format')) {
  emit(initEvent());
  run().then(() => process.exit(Number(env.FAKE_EXIT || 0)));
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    record({ type: 'in', msg: o });
    if (o.type === 'control_request') control(o);
    else if (o.type === 'control_response' && o.response) {
      const a = asks.get(o.response.request_id);
      if (a) { a.resolved = true; decisions[o.response.request_id] = o.response.response; wake(); }
    } else if (o.type === 'user' && !started) {
      started = true;
      emit(initEvent());
      if (replay) emit({ type: 'user', isReplay: true, uuid: o.uuid || 'first-uuid', session_id: sessionId, message: o.message, parent_tool_use_id: null });
      run().then(() => { finished = true; nextTurn(); });
    } else if (o.type === 'user') {
      steers.push(o);
      wake();
      nextTurn();
    }
  });
  rl.on('close', () => { if (!env.FAKE_IGNORE_STDIN_CLOSE) process.exit(0); });
  if (env.FAKE_IGNORE_STDIN_CLOSE) setInterval(() => {}, 1000);
}
