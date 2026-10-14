'use strict';
const fs = require('fs');
const path = require('path');
const activityLib = require('./activity.cjs');

const CAPS = Object.freeze({ title: 120, tool: 64, label: 120, summary: 200, detail: 2000, agent: 48, always: 160, question: 300, header: 40, option: 80, optionText: 200, questions: 4, options: 4, bodyBytes: 8000, note: 500, pending: 4, perTurn: 100, ruleSessions: 200, rulesPerSession: 100, acks: 100, cancelled: 200 });
const ALLOW_KEEP_MS = 30 * 24 * 3600 * 1000;
const MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto']);
const WORDS = Object.freeze({
	timeout: 'No answer from the phone in time', stopped: 'Stopped by the user', closed: 'The turn was closed', denied: 'Denied from the phone', dismissed: 'The user dismissed the question',
	changes: 'The user wants changes to the plan', budget: 'The waiting budget of this turn is used up', crowded: 'Too many requests are waiting for the phone', unreadable: 'The request could not be read',
	mismatch: 'The answer did not match the request', incomplete: 'The answer was incomplete', unreachable: 'DOCK could not be reached', refused: 'DOCK refused the request',
	toolarge: 'The question is too large to show on the phone', noroute: 'This DOCK server cannot take requests for the phone',
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDIT_TOOLS = Object.freeze(new Set(['Edit', 'Write', 'NotebookEdit']));
const SHELL_TOOLS = Object.freeze(new Set(['Bash', 'PowerShell']));
const PROTECTED_PARTS = new Set(['.git', '.claude', '.husky']);
const PROTECTED_NAMES = new Set(['settings.json', 'settings.local.json', '.mcp.json', 'mcp.json', '.claude.json', 'dock.json', 'secrets.env', '.credentials.json', 'guard.json', 'hooks.json']);
const PROTECTED_LOWER_NAMES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.gitattributes', '.gitmodules', '.envrc', '.env', 'makefile', 'package.json', 'claude.md', 'agents.md']);
const WIN = process.platform === 'win32';
const protectedPath = (p) => {
	const segs = p.split(/[\\/]+/).map((x) => x.toLowerCase());
	const base = segs[segs.length - 1] ?? '';
	const at = segs.indexOf('.github');
	return PROTECTED_LOWER_NAMES.has(base) || /^\.env\..+/.test(base) || (at >= 0 && segs[at + 1] === 'workflows');
};

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strOf = (v) => (typeof v === 'string' ? v : '');
const rand = () => Math.random().toString(36).slice(2, 10);
const uuidOf = (v) => (typeof v === 'string' && UUID.test(v) ? v : null);
const isShell = (tool, input) => SHELL_TOOLS.has(tool) || (isObj(input) && typeof input.command === 'string');
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

const ruleKey = (r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName));

function suggestionsOf(list) {
	const out = { rules: [], pairs: [], acceptEdits: false, addsDirs: false };
	for (const s of Array.isArray(list) ? list : []) {
		if (!isObj(s)) continue;
		if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
			for (const r of s.rules) if (isObj(r) && typeof r.toolName === 'string' && r.toolName && (r.ruleContent == null || typeof r.ruleContent === 'string')) { out.rules.push(ruleKey(r)); out.pairs.push(r); }
		} else if (s.type === 'setMode' && s.mode === 'acceptEdits') out.acceptEdits = true;
		else if (s.type === 'addDirectories') out.addsDirs = true;
	}
	return out;
}

const norm = (p) => (WIN ? p.toLowerCase() : p);
const within = (root, p) => {
	const a = norm(root), b = norm(p);
	return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};
function realish(p) {
	const rest = [];
	let cur = p;
	for (;;) {
		try {
			const real = fs.realpathSync.native(cur);
			return rest.length ? path.join(real, ...rest.reverse()) : real;
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return p;
			rest.push(path.basename(cur));
			cur = parent;
		}
	}
}

function editTarget(tool, input, { cwd, protect = [] } = {}) {
	if (!EDIT_TOOLS.has(tool) || !isObj(input) || !cwd) return 'unreadable';
	const raw = tool === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : input.file_path;
	if (typeof raw !== 'string' || !raw || raw.includes('\0')) return 'unreadable';
	if (raw.split(/[\\/]+/).includes('..')) return 'outside';
	const base = path.resolve(cwd);
	const lexical = path.resolve(base, raw);
	const real = realish(lexical);
	const parts = [lexical, real].flatMap((p) => p.split(/[\\/]+/)).map(norm);
	if (parts.some((x) => PROTECTED_PARTS.has(x)) || PROTECTED_NAMES.has(norm(path.basename(real))) || PROTECTED_NAMES.has(norm(path.basename(lexical))) || protectedPath(lexical) || protectedPath(real)) return 'protected';
	for (const dir of protect) {
		if (!dir) continue;
		const abs = path.resolve(dir);
		if (within(abs, lexical) || within(realish(abs), real)) return 'protected';
	}
	if (!within(base, lexical) || !within(realish(base), real)) return 'outside';
	return 'inside';
}

function createAllowStore(file, { now = Date.now, log = () => {} } = {}) {
	let data = null;
	const read = () => {
		if (data) return data;
		try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); data = isObj(j) ? j : {}; } catch { data = {}; }
		return data;
	};
	const write = () => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { log(`could not save session allow rules: ${e.message}`); } };
	const entry = (id) => { const d = read(); return isObj(d[id]) ? d[id] : null; };
	return {
		prune() {
			const d = read();
			let changed = false;
			for (const [id, e] of Object.entries(d)) if (!isObj(e) || !(now() - Date.parse(e.usedAt) <= ALLOW_KEEP_MS)) { delete d[id]; changed = true; }
			const ids = Object.keys(d).sort((a, b) => Date.parse(d[a].usedAt) - Date.parse(d[b].usedAt));
			while (ids.length > CAPS.ruleSessions) { delete d[ids.shift()]; changed = true; }
			if (changed) write();
		},
		allows(id, tool, input, { cwd, protect = [], addsDirs = false } = {}) {
			const e = entry(id);
			if (!e || !isObj(input)) return false;
			let ok = false;
			if (SHELL_TOOLS.has(tool)) {
				const command = typeof input.command === 'string' ? input.command.trim() : '';
				ok = Boolean(command) && Array.isArray(e.rules) && e.rules.includes(`${tool}(${command})`);
			} else if (EDIT_TOOLS.has(tool)) ok = e.acceptEdits === true && !addsDirs && editTarget(tool, input, { cwd, protect }) === 'inside';
			if (!ok) return false;
			e.usedAt = new Date(now()).toISOString();
			write();
			return true;
		},
		add(id, rules, acceptEdits) {
			if (!rules.length && !acceptEdits) return;
			const d = read();
			const e = entry(id) || (d[id] = { rules: [], acceptEdits: false, usedAt: null });
			e.rules = Array.isArray(e.rules) ? e.rules : [];
			for (const r of rules) if (!e.rules.includes(r)) e.rules.push(r);
			while (e.rules.length > CAPS.rulesPerSession) e.rules.shift();
			if (acceptEdits) e.acceptEdits = true;
			e.usedAt = new Date(now()).toISOString();
			write();
		},
	};
}

function offer(tool, input, sug, { fit, cwd, protect, guardRule }) {
	const none = { rules: [], pairs: [], acceptEdits: false, addsDirs: sug.addsDirs, label: null };
	const command = SHELL_TOOLS.has(tool) && typeof input.command === 'string' ? input.command.trim() : '';
	const seen = new Set();
	const pairs = [];
	for (const r of command ? sug.pairs : []) {
		if (r.toolName !== tool || typeof r.ruleContent !== 'string' || r.ruleContent.trim() !== command || command.includes('*')) continue;
		if (guardRule(r.toolName, command) || seen.has(command)) continue;
		seen.add(command);
		pairs.push({ toolName: tool, ruleContent: command });
	}
	const rules = pairs.map(ruleKey);
	const acceptEdits = sug.acceptEdits && !sug.addsDirs && EDIT_TOOLS.has(tool) && editTarget(tool, input, { cwd, protect }) === 'inside';
	const parts = acceptEdits ? [...rules, 'all file edits'] : rules;
	if (!parts.length) return none;
	const label = parts.join(', ');
	if (label.length > CAPS.always || label !== label.replace(/\s+/g, ' ').trim() || fit(label, Infinity) !== label) return none;
	return { rules, pairs, acceptEdits, addsDirs: sug.addsDirs, label };
}

const sizeOf = (value) => {
	const text = strOf(value);
	const lines = text ? text.split('\n').length : 0;
	return `${lines} line${lines === 1 ? '' : 's'}, ${Buffer.byteLength(text)} bytes`;
};
function editDetail(tool, input, fit) {
	const p = fit(strOf(input.file_path || input.notebook_path), 300);
	if (tool === 'Write') return `${p}\n${sizeOf(input.content)}`;
	if (tool === 'Edit') return `${p}\nold: ${sizeOf(input.old_string)}\nnew: ${sizeOf(input.new_string)}`;
	return `${p}\n${sizeOf(input.new_source)}`;
}

const LEVELS = [{ q: CAPS.question, h: CAPS.header, o: CAPS.option, d: CAPS.optionText }, { q: 200, h: 30, o: 60, d: 100 }, { q: 120, h: 20, o: 40, d: 0 }, { q: 60, h: 12, o: 24, d: 0 }];
function uniqueLabels(list, max) {
	const used = new Set();
	return list.map((text, n) => {
		const base = text || `Option ${n + 1}`;
		let label = base;
		for (let k = 2; used.has(label); k++) {
			const tag = ` (${k})`;
			label = base.slice(0, Math.max(1, max - tag.length)) + tag;
		}
		used.add(label);
		return label;
	});
}
function questionBody(asked, fit) {
	for (const lvl of LEVELS) {
		const shown = asked.map((q) => {
			const options = (Array.isArray(q.options) ? q.options.filter(isObj) : []).slice(0, CAPS.options);
			const names = uniqueLabels(options.map((o) => fit(o.label, lvl.o)), lvl.o);
			return { options, view: { question: fit(q.question, lvl.q), header: fit(q.header, lvl.h), multiSelect: q.multiSelect === true, options: options.map((o, n) => ({ label: names[n], description: lvl.d ? fit(o.description, lvl.d) : '' })) } };
		});
		const body = { questions: shown.map((s) => s.view) };
		if (bytes(body) <= CAPS.bodyBytes) return { body, shown };
	}
	return null;
}

function buildAsk(request, { fit, labels, cwd, protect = [], guardRule = () => false }) {
	const tool = strOf(request.tool_name);
	const input = isObj(request.input) ? request.input : {};
	if (tool === 'AskUserQuestion') {
		const asked = (Array.isArray(input.questions) ? input.questions.filter(isObj) : []).slice(0, CAPS.questions);
		if (!asked.length) return null;
		const built = questionBody(asked, fit);
		if (!built) return { refuse: WORDS.toolarge };
		return { kind: 'question', title: fit(asked[0].header, CAPS.title) || 'Question', body: built.body, asked, shown: built.shown };
	}
	if (tool === 'ExitPlanMode') return { kind: 'plan', title: 'Plan ready', body: { planChars: strOf(input.plan).length }, plan: strOf(input.plan) };
	const u = activityLib.describeUse(tool, input, labels, { safe: (s) => fit(s, Infinity), cut: fit });
	const shown = offer(tool, input, suggestionsOf(request.permission_suggestions), { fit, cwd, protect, guardRule });
	const agent = strOf(request.agent_id) ? fit(request.agent_id, CAPS.agent) : null;
	const detail = EDIT_TOOLS.has(tool) ? editDetail(tool, input, fit) : u.input;
	const body = { tool: fit(tool, CAPS.tool), label: fit(u.label, CAPS.label), summary: fit(u.summary, CAPS.summary), detail: fit(detail, CAPS.detail), agent, alwaysLabel: shown.label };
	if (bytes(body) > CAPS.bodyBytes) body.detail = fit(body.detail, 500);
	return { kind: 'permission', title: fit(u.label, CAPS.title) || fit(tool, CAPS.title), body, sug: { rules: shown.rules, pairs: shown.pairs, acceptEdits: shown.acceptEdits, addsDirs: shown.addsDirs } };
}

const deny = (message) => ({ response: { behavior: 'deny', message }, remember: null, setMode: null });
const allow = (input, extra = {}) => ({ response: { behavior: 'allow', updatedInput: input }, remember: null, setMode: null, ...extra });
const note = (a) => (typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, CAPS.note) : null);

function decide(pending, answer, { guardRule = () => false } = {}) {
	if (!isObj(answer)) return deny(WORDS.mismatch);
	const input = pending.input;
	if (pending.kind === 'permission') {
		if (answer.decision === 'deny') return deny(note(answer) || WORDS.denied);
		if (answer.decision === 'allow') return allow(input);
		if (answer.decision === 'allow_session') {
			const sug = pending.sug;
			const rules = sug.pairs.filter((r) => !guardRule(r.toolName, r.ruleContent)).map(ruleKey);
			if (!rules.length && !sug.acceptEdits) return allow(input);
			return allow(input, { remember: { rules, acceptEdits: sug.acceptEdits }, setMode: sug.acceptEdits ? 'acceptEdits' : null });
		}
		return deny(WORDS.mismatch);
	}
	if (pending.kind === 'question') {
		if (answer.decision === 'deny') return deny(WORDS.dismissed);
		if (answer.decision !== 'answer' || !Array.isArray(answer.answers)) return deny(WORDS.mismatch);
		const out = {};
		for (const [i, q] of pending.asked.entries()) {
			const a = answer.answers.find((x) => isObj(x) && x.index === i);
			if (!a) return deny(WORDS.incomplete);
			const other = typeof a.other === 'string' ? a.other.trim() : '';
			let text;
			if (other) text = other.slice(0, CAPS.note);
			else {
				const labels = (Array.isArray(a.labels) ? a.labels : []).filter((l) => typeof l === 'string' && l);
				if (!labels.length) return deny(WORDS.incomplete);
				const seen = pending.shown[i].view.options.map((o) => o.label);
				const original = labels.map((l) => { const at = seen.indexOf(l); return at >= 0 ? strOf(pending.shown[i].options[at].label) : l.slice(0, CAPS.note); });
				text = (q.multiSelect === true ? original : original.slice(0, 1)).join(', ');
			}
			out[strOf(q.question)] = text;
		}
		return allow({ ...input, answers: out });
	}
	if (pending.kind === 'plan') {
		if (answer.decision === 'approve') return allow(input);
		if (answer.decision === 'approve_edits') return allow(input, { setMode: 'acceptEdits' });
		if (answer.decision === 'reject') return deny(note(answer) || WORDS.changes);
	}
	return deny(WORDS.mismatch);
}

function optionArgs(options, { catalog, modes = MODES, log = () => {} }) {
	const o = isObj(options) ? options : {};
	const out = { args: [], mode: null };
	const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
	const safeWord = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/.test(v);
	let chosen = null;
	if (o.model != null) {
		chosen = safeWord(o.model) ? models.find((m) => m.value === o.model) : null;
		if (chosen) out.args.push('--model', chosen.value);
		else log('option dropped: the model is not in this machine\'s catalogue');
	}
	if (o.effort != null) {
		const levels = chosen ? chosen.efforts : o.model != null ? [] : models.flatMap((m) => m.efforts);
		if (safeWord(o.effort) && levels.includes(o.effort)) out.args.push('--effort', o.effort);
		else log('option dropped: the effort level is not offered for this model');
	}
	if (o.permissionMode != null) {
		if (typeof o.permissionMode === 'string' && MODES.includes(o.permissionMode) && modes.includes(o.permissionMode)) out.mode = o.permissionMode;
		else log('option dropped: the permission mode is not offered');
	}
	if (o.fast === true) {
		if (catalog && catalog.fast && catalog.fast.available) out.args.push('--settings', '{"fastMode":true}');
		else log('option dropped: fast mode is not available on this machine');
	}
	return out;
}

function createAsker(d) {
	const now = d.now || Date.now;
	const pending = new Map();
	const acks = [];
	const cancelled = [];
	const st = { asked: 0, waited: 0, since: null, stopping: false, noPhone: null };
	const used = () => st.waited + (st.since == null ? 0 : now() - st.since);
	const setWaiting = () => {
		if (pending.size && st.since == null) { st.since = now(); d.onWaiting(true); }
		else if (!pending.size && st.since != null) { st.waited += now() - st.since; st.since = null; d.onWaiting(false); }
	};
	const finish = (requestId) => {
		const p = pending.get(requestId);
		if (!p) return null;
		clearTimeout(p.timer);
		pending.delete(requestId);
		setWaiting();
		return p;
	};
	const report = (id) => {
		if (!cancelled.includes(id)) cancelled.push(id);
		while (cancelled.length > CAPS.cancelled) cancelled.shift();
	};
	const ack = (id) => {
		if (!acks.includes(id)) acks.push(id);
		while (acks.length > CAPS.acks) acks.shift();
	};
	const refuse = (requestId, message) => d.respond(requestId, { behavior: 'deny', message });
	const settle = (p, r) => {
		d.respond(p.requestId, r.response);
		if (r.remember) d.store.add(d.sessionId, r.remember.rules, r.remember.acceptEdits);
		if (r.setMode) d.sendControl({ subtype: 'set_permission_mode', mode: r.setMode });
	};
	const protectedDirs = () => (typeof d.protect === 'function' ? d.protect() : []);

	async function post(p, ask, ttlMs) {
		const body = { sessionId: d.sessionId, replyTo: d.replyTo, requestId: p.requestId, kind: ask.kind, title: ask.title, body: ask.body, ttlSeconds: Math.min(1800, Math.max(30, Math.ceil(ttlMs / 1000))) };
		for (let attempt = 0; attempt < 2; attempt++) {
			let r;
			try { r = await d.post('/chat/ask', body, 10000); } catch (e) { d.log(`ask failed: ${e.message}`); continue; }
			if (!r || r.skipped) return { fail: WORDS.unreachable };
			if (r.status >= 200 && r.status < 300) return { closed: Boolean(r.result && r.result.closed) };
			if (r.status === 404) {
				if (r.error && /Unknown ticket/i.test(r.error)) return { closed: true };
				d.onOld();
				return { fail: WORDS.noroute };
			}
			if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) { d.log(`ask refused: ${r.status}${r.error ? ' ' + r.error : ''}`); return { fail: WORDS.refused }; }
			d.log(`ask answered ${r.status}`);
		}
		return { fail: WORDS.unreachable };
	}

	async function handle(req) {
		const requestId = String(req.request_id);
		const r = isObj(req.request) ? req.request : {};
		const tool = strOf(r.tool_name);
		const input = isObj(r.input) ? r.input : {};
		if (st.stopping) return refuse(requestId, WORDS.stopped);
		if (st.noPhone) return refuse(requestId, st.noPhone);
		if (isShell(tool, input)) {
			if (typeof input.command !== 'string') return refuse(requestId, WORDS.unreadable);
			const hit = d.guardCheck(input.command);
			if (hit) return refuse(requestId, `guard: ${hit.why}`);
		}
		const budget = d.timing.waitBudgetMs - used();
		if (budget <= 0) return refuse(requestId, WORDS.budget);
		if (pending.size >= CAPS.pending || st.asked >= CAPS.perTurn) return refuse(requestId, WORDS.crowded);
		const sug = suggestionsOf(r.permission_suggestions);
		if (tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode' && d.store.allows(d.sessionId, tool, input, { cwd: d.cwd, protect: protectedDirs(), addsDirs: sug.addsDirs })) return d.respond(requestId, { behavior: 'allow', updatedInput: input });
		const ask = buildAsk(r, { fit: d.fit, labels: d.labels, cwd: d.cwd, protect: protectedDirs(), guardRule: d.guardRule });
		if (!ask) return refuse(requestId, WORDS.unreadable);
		if (ask.refuse) return refuse(requestId, ask.refuse);
		const ttlMs = Math.min(d.timing.askTtlMs, budget);
		const p = { requestId, kind: ask.kind, input, sug: ask.sug, asked: ask.asked, shown: ask.shown, timer: null };
		pending.set(requestId, p);
		st.asked++;
		setWaiting();
		p.timer = setTimeout(() => { const gone = finish(requestId); if (gone) { report(requestId); refuse(requestId, WORDS.timeout); } }, ttlMs);
		if (ask.kind === 'plan') await d.sendPlan(ask.plan);
		if (!pending.has(requestId)) return;
		const res = await post(p, ask, ttlMs);
		if (!pending.has(requestId)) return;
		if (res.fail || res.closed) {
			finish(requestId);
			if (res.fail) report(requestId);
			refuse(requestId, res.closed ? WORDS.closed : res.fail);
			if (res.closed) d.onClosed();
		}
	}

	return {
		handle,
		cancel(requestId) { if (finish(String(requestId))) report(String(requestId)); },
		deliver(list) {
			for (const a of Array.isArray(list) ? list : []) {
				if (!isObj(a) || typeof a.requestId !== 'string') continue;
				ack(a.requestId);
				const p = finish(a.requestId);
				if (!p) continue;
				if (a.state === 'expired') { refuse(p.requestId, WORDS.timeout); continue; }
				if (a.state !== 'answered' || a.kind !== p.kind) { refuse(p.requestId, WORDS.mismatch); continue; }
				settle(p, decide(p, a.answer, { guardRule: d.guardRule }));
			}
		},
		denyAll(message) {
			st.stopping = true;
			for (const id of [...pending.keys()]) { finish(id); refuse(id, message); }
		},
		failAll(message) {
			st.noPhone = message;
			for (const id of [...pending.keys()]) { finish(id); refuse(id, message); }
		},
		closeAll() { for (const id of [...pending.keys()]) finish(id); },
		pendingCount: () => pending.size,
		takeAck() { return acks.splice(0, 20); },
		takeCancelled() { return cancelled.splice(0, 20); },
		requeue(ack, cancel) { for (const a of [...ack].reverse()) if (!acks.includes(a)) acks.unshift(a); for (const c of [...cancel].reverse()) if (!cancelled.includes(c)) cancelled.unshift(c); },
	};
}

module.exports = { CAPS, MODES, WORDS, EDIT_TOOLS, SHELL_TOOLS, suggestionsOf, ruleKey, createAllowStore, buildAsk, decide, optionArgs, createAsker, editTarget, uuidOf, isShell, rand };
