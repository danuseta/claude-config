'use strict';
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dockPush = require('./dock-push.cjs');
const files = require('./dock-chat-files.cjs');
const interact = require('./dock-chat-interact.cjs');
const procLib = require('./dock-chat-proc.cjs');

const MAX_BACKOFF_MS = 30000;
const KEEP_AWAKE_EVERY_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (ms, ...promises) => new Promise((resolve) => {
	const t = setTimeout(resolve, ms);
	const done = () => { clearTimeout(t); resolve(); };
	for (const p of promises) p.then(done, done);
});

function buildContent(msg, att) {
	const blocks = att.files.filter((f) => f.image && f.base64).map((f) => ({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.base64 } }));
	const text = [msg.text, files.attachmentNote(att)].filter(Boolean).join('\n\n');
	blocks.push({ type: 'text', text: text || ' ' });
	return blocks;
}

async function runInteractiveTurn(msg, cfg, opts, d) {
	const { claude, act, core, log, flags } = d;
	const timing = opts.timing;
	const replyTo = msg.id, sessionId = msg.sessionId;
	let att = { dir: null, files: [], failed: [] };

	if (Array.isArray(msg.attachments) && msg.attachments.length) {
		try { att = await files.fetchAttachments(msg, { sendBinary: dockPush.sendBinary, stateDir: d.stateDir, log }); }
		catch (e) { log(`attachments failed: ${e.message}`); att = { dir: null, files: [], failed: msg.attachments.map((a) => String(a && a.name || 'file')) }; }
	}

	const args = [...claude.prefix, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
	if (act) {
		if (flags.hooks && opts.activity.hooks && !opts.extraArgs.includes('--include-hook-events')) args.push('--include-hook-events');
		if (flags.subagentText && opts.activity.subagentText && !opts.extraArgs.includes('--forward-subagent-text')) args.push('--forward-subagent-text');
	}
	const resumeId = interact.uuidOf(msg.claudeSessionId), forkId = interact.uuidOf(msg.forkFrom);
	if ((msg.claudeSessionId && !resumeId) || (msg.forkFrom && !forkId)) log('a session id from DOCK is not a UUID; it was dropped');
	if (resumeId) args.push('--resume', resumeId);
	else if (forkId) args.push('--resume', forkId, '--fork-session');
	const chosen = interact.optionArgs(msg.options, { catalog: d.catalog(), modes: d.caps().modes, log });
	const mode = chosen.mode || opts.permissionMode;
	if (mode) args.push('--permission-mode', mode);
	if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
	args.push(...chosen.args);
	if (att.files.length && att.dir) args.push('--add-dir', att.dir);
	if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
	args.push(...opts.extraArgs);

	const env = d.childEnv(opts);
	let stderrTail = '', timedOut = false, spawnError = null, closedByServer = false, stopped = false, afterResult = false, ended = false, stdinOpen = true, exited = false;
	const initId = `init-${interact.rand()}`;
	let initEvent = null, initResponse = null, resultEvent = null;
	const child = spawn(claude.cmd, args, { cwd: opts.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	core.setChild(child);
	const untrack = d.track(child);
	child.on('error', (e) => { spawnError = e; });
	child.stdin.on('error', () => {});
	child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-2000); });
	const closedP = new Promise((resolve) => {
		child.once('exit', (code) => { exited = true; resolve(code); });
		child.once('error', () => { if (child.pid === undefined && !exited) { exited = true; resolve(null); } });
	});
	let resolveResult;
	const resultP = new Promise((r) => { resolveResult = r; });
	let endSignal;
	const endP = new Promise((r) => { endSignal = r; });
	const pause = (ms) => waitFor(ms, endP);

	const send = (obj) => {
		if (!stdinOpen) return false;
		try { child.stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
	};
	const endInput = () => {
		if (!stdinOpen) return;
		stdinOpen = false;
		try { child.stdin.end(); } catch {}
	};
	const killLater = (ms) => { const k = setTimeout(() => d.killTree(child), ms); closedP.then(() => clearTimeout(k)); };

	let remaining = opts.turnTimeoutMs, startedAt = 0, killer = null;
	const runTimer = () => {
		if (killer || ended) return;
		startedAt = Date.now();
		killer = setTimeout(() => { timedOut = true; d.killTree(child); }, remaining);
	};
	const pauseTimer = () => {
		if (!killer) return;
		clearTimeout(killer);
		killer = null;
		remaining = Math.max(1, remaining - (Date.now() - startedAt));
	};

	const fit = d.fit;
	const labels = d.labels;
	const asker = interact.createAsker({
		sessionId, replyTo, fit, labels, timing, log, store: d.store,
		post: d.call,
		respond: (requestId, response) => { send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }); },
		sendControl: (request) => { send({ type: 'control_request', request_id: `dock-${interact.rand()}`, request }); },
		guardCheck: d.guardCheck,
		cwd: opts.cwd,
		protect: () => [d.kitDir, d.stateDir, opts.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')],
		guardRule: (tool, content) => interact.SHELL_TOOLS.has(tool) && (!content || Boolean(d.guardCheck(String(content).replace(/:\*$/, '')))),
		onWaiting: (waiting) => { if (waiting) pauseTimer(); else runTimer(); },
		onClosed: () => { void stopSequence('closed'); },
		onOld: () => d.markOld(),
		sendPlan: async (text) => { core.state.pending.push({ role: 'assistant', text: core.out(text), at: new Date().toISOString() }); await core.post({ done: false, error: null }); },
	});

	let stopping = false;
	async function stopSequence(why) {
		if (stopping) return;
		stopping = true;
		if (why === 'closed') closedByServer = true; else stopped = true;
		asker.denyAll(why === 'closed' ? interact.WORDS.closed : interact.WORDS.stopped);
		send({ type: 'control_request', request_id: `stop-${interact.rand()}`, request: { subtype: 'interrupt' } });
		await waitFor(timing.interruptGraceMs, resultP, closedP);
		if (!exited) {
			endInput();
			await waitFor(timing.closeGraceMs, closedP);
		}
		if (!exited) d.killTree(child);
	}

	const onResult = () => {
		afterResult = true;
		asker.closeAll();
		d.snapshot(child);
		resolveResult();
		endInput();
		killLater(timing.exitGraceMs);
	};

	let unsupportedLogged = false, oversizeLogged = false;
	const onLine = (line) => {
		let o; try { o = JSON.parse(line); } catch { return; }
		if (!o || typeof o !== 'object') return;
		if (o.type === 'control_request') {
			if (o.request && o.request.subtype === 'can_use_tool') asker.handle(o).catch((e) => { log(`ask handling failed: ${e.message}`); try { send({ type: 'control_response', response: { subtype: 'success', request_id: String(o.request_id), response: { behavior: 'deny', message: interact.WORDS.unreadable } } }); } catch {} });
			else {
				if (!unsupportedLogged) { unsupportedLogged = true; log('claude sent a control request this bridge does not handle; it was refused'); }
				send({ type: 'control_response', response: { subtype: 'error', request_id: String(o.request_id), error: 'Unsupported control request' } });
			}
			return;
		}
		if (o.type === 'control_response') {
			const r = o.response;
			if (r && r.request_id === initId && r.subtype === 'success' && r.response && typeof r.response === 'object') initResponse = r.response;
			return;
		}
		if (o.type === 'control_cancel_request') return asker.cancel(o.request_id);
		if (act) act.feed(o);
		if (o.type === 'system' && o.subtype === 'init') {
			initEvent = o;
			d.noteInit(o);
			log(`turn model: ${String(o.model || 'unknown').slice(0, 60)}`);
		}
		core.onEvent(o);
		if (o.type === 'result') { resultEvent = o; onResult(); }
	};
	const splitter = procLib.createLineSplitter(onLine, { onDrop: () => { if (!oversizeLogged) { oversizeLogged = true; log('claude wrote a line over 32 MB; it was skipped'); } } });
	const drained = new Promise((resolve) => {
		child.stdout.on('data', (c) => splitter.write(c));
		child.stdout.on('end', () => splitter.end());
		child.stdout.on('error', () => {});
		child.stdout.once('close', resolve);
	});

	const onSignal = (sig) => { d.killTree(child); (act ? act.settle(2000) : Promise.resolve()).then(() => process.exit(sig === 'SIGINT' ? 130 : 143)); };
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);
	void d.keepAwake('working', opts);
	const awake = setInterval(() => { void d.keepAwake('working', opts, { force: true }); }, KEEP_AWAKE_EVERY_MS);
	awake.unref();
	runTimer();

	send({ type: 'control_request', request_id: initId, request: { subtype: 'initialize', hooks: null } });
	send({ type: 'user', message: { role: 'user', content: buildContent(msg, att) }, parent_tool_use_id: null });

	const waitCtl = new AbortController();
	async function waitLoop() {
		let backoff = 0, skipCancelled = false, lastStart = d.lastWait(), askedBadCancel = false;
		while (!ended) {
			const gap = lastStart + timing.waitGapMs - Date.now();
			if (gap > 0) await pause(gap);
			if (ended) return;
			lastStart = Date.now();
			d.markWait(lastStart);
			const ack = asker.takeAck();
			const cancelled = skipCancelled ? [] : asker.takeCancelled();
			skipCancelled = false;
			const body = { sessionId, replyTo, wait: timing.waitSeconds, ack, caps: d.caps() };
			if (cancelled.length) body.cancelled = cancelled;
			let r = null;
			try { r = await d.call('/chat/wait', body, (timing.waitSeconds + 5) * 1000, waitCtl.signal); } catch (e) { if (!ended) log(`wait failed: ${e.message}`); }
			if (ended) return;
			const status = r && !r.skipped ? r.status : 0;
			if (status === 404) {
				if (r.error && /Unknown ticket/i.test(r.error)) { void stopSequence('closed'); return; }
				d.markOld();
				asker.failAll(interact.WORDS.noroute);
				return;
			}
			if (status === 400 && cancelled.length) {
				skipCancelled = true;
				if (!askedBadCancel) { askedBadCancel = true; log('DOCK refused the cancelled ids on /chat/wait; sent again without them'); }
				asker.requeue(ack, []);
				continue;
			}
			if (status < 200 || status >= 300) {
				asker.requeue(ack, cancelled);
				backoff = Math.min(backoff ? backoff * 2 : 1000, MAX_BACKOFF_MS);
				if (status) log(`wait answered ${status}`);
				await pause(Math.max(backoff, timing.waitGapMs));
				continue;
			}
			backoff = 0;
			const res = r.result && typeof r.result === 'object' ? r.result : {};
			const answers = Array.isArray(res.answers) ? res.answers : [];
			asker.deliver(answers);
			if (res.stop === true) { void stopSequence('stop'); return; }
			if (res.closed === true) { void stopSequence('closed'); return; }
		}
	}
	const loop = waitLoop().catch((e) => { log(`wait loop stopped: ${e.message}`); });

	const code = await closedP;
	ended = true;
	waitCtl.abort();
	endSignal();
	clearTimeout(killer);
	clearInterval(awake);
	void d.keepAwake('idle', opts);
	await waitFor(timing.drainMs, drained);
	try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
	splitter.end();
	d.reap(child);
	untrack();
	asker.closeAll();
	core.stopTimer();

	if (initResponse) d.adoptCatalog(initResponse, initEvent);

	let error = null;
	if (stopped) error = null;
	else if (closedByServer) error = 'The turn was closed by DOCK';
	else if (timedOut) error = `The turn ran longer than ${opts.turnTimeoutMs >= 60000 ? Math.round(opts.turnTimeoutMs / 60000) + ' minutes' : Math.round(opts.turnTimeoutMs / 1000) + ' seconds'} and was stopped`;
	else if (spawnError) error = `Could not start Claude Code: ${spawnError.message}`;
	else if (resultEvent && resultEvent.is_error) error = String(resultEvent.result || resultEvent.subtype || 'Claude Code reported an error');
	else if (code !== 0 && !afterResult) error = `Claude Code exited with code ${code}${stderrTail.trim() ? ': ' + stderrTail.trim().split('\n').at(-1) : ''}`;
	core.state.detail = null;
	const pace = sleep(Math.max(0, core.state.lastSent + 1000 - Date.now()));
	process.removeListener('SIGINT', onSignal);
	process.removeListener('SIGTERM', onSignal);
	if (act) await Promise.all([pace, act.settle()]);
	else await pace;
	if (error) await core.post({ done: false, error: core.mask(error).slice(0, 300) }, closedByServer ? 1 : undefined);
	else {
		const subagentsRunning = !stopped ? core.subagentsRunning() : 0;
		await core.post(stopped ? { done: true, error: null, stopped: true } : subagentsRunning > 0 ? { done: true, error: null, subagentsRunning } : { done: true, error: null });
	}
	await core.chain();
	await waitFor(2000, loop);
}

module.exports = { runInteractiveTurn, buildContent };
