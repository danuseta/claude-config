'use strict';
// Turns the `claude -p --output-format stream-json` stream into activity rows for DOCK chat. Pure: no network, and no fs except loadLabels.
//   const t = createTracker({ mask, labels, now, hooks }); t.feed(streamObject); t.drain(50, 100 * 1024); t.requeue(events); t.closeAll("stopped"); t.stats();
// Every string field is masked inside the tracker, before a row can leave it. Shapes that are not recognised are skipped, never thrown.
const fs = require('fs');
const path = require('path');

const LIMITS = Object.freeze({ eventBytes: 4096, detail: 2000, input: 1000, outHead: 600, outTail: 400, reportHead: 600, reportTail: 600, promptHead: 300, rows: 400, hardRows: 1600, depth: 3, summary: 200, label: 120, name: 64, agent: 48, id: 80 });
const HIDDEN_NOTE = '[output hidden: sensitive command]';

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const stripPrefix = (t) => String(t || '').replace(/^.*:/, '');
const cleanId = (raw, fallback) => String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || fallback || '';
const baseName = (p) => String(p).replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(p);
const countLines = (s) => (s ? s.split('\n').length : 0);
const firstLines = (s, n) => String(s || '').split('\n').slice(0, n).join('\n');
const str = (v) => (typeof v === 'string' ? v : '');

// ---------- sensitive commands and paths (plan 8.3): the output of these is never sent ----------
const SEP = String.raw`(?:^|[\s/"'=:@(,<>|;&])`;
const END = String.raw`(?=$|[\s"'/;|&)<>,])`;
const FILE_NAMES = [
	String.raw`[\w.-]*\.env(?:\.[\w.-]+)?`,
	String.raw`\.envrc`,
	String.raw`[\w.-]*(?:secret|credential)s?[\w.-]*\.[a-z0-9]{1,8}`,
	String.raw`[\w.-]*\.(?:pem|key|p12|pfx|jks|keystore|ppk|gpg|kdbx)`,
	String.raw`id_(?:rsa|ed25519|ecdsa|dsa)[\w.-]*`,
	String.raw`\.(?:npmrc|netrc|pgpass|git-credentials|pypirc|htpasswd)`,
	String.raw`(?:dock|dock-chat|mcp|\.mcp|\.claude|settings\.local|elevenlabs-keys)\.json`,
];
const FILE_RE = new RegExp(SEP + '(?:' + FILE_NAMES.join('|') + ')' + END, 'i');
const DIR_RE = /(?:^|[\s/"'=:@(,])(?:\.ssh|\.aws|\.gnupg|\.kube)(?:\/|$|[\s"'])|\/proc\/[^\s/]+\/environ|\/etc\/shadow|\.config\/(?:gh\/hosts\.yml|claude-config\/)|\.docker\/config\.json|(?:^|\/)secrets?\//i;
const VAR_RE = /\$\{?(?:env:)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|AUTH)[A-Za-z0-9_]*\}?|%[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|CREDENTIAL|AUTH)[A-Za-z_]*%|\$env:\w|\[Environment\]::GetEnvironmentVariable/i;
const ENV_DUMP_RE = /^(?:env|printenv(?:\s.*)?|set|export(?:\s+-p)?|declare\s+-[a-z]*[xp][a-z]*|typeset\s+-[a-z]*[xp][a-z]*|compgen\s+-e|(?:get-childitem|gci|ls|dir|get-item)\s+(?:-path\s+)?env:.*|get-psdrive\s+env.*)$/i;
const CLI_RE = /^(?:gh\s+auth\s+(?:token|login|refresh|status\b.*(?:\s-t\b|--show-token))|aws\s+(?:configure|sts|secretsmanager|ssm|iam\s+create-access-key)\b|coder\s+(?:tokens|login)\b|tailscale\b|ccfg\s+secret\b|npm\s+(?:token|config\s+(?:get|list)|whoami)\b|docker\s+login\b|git\s+credential\b|gcloud\s+auth\s+(?:print|login|application-default)\b|az\s+account\s+get-access-token|vault\b|op\s+(?:read|item|inject|signin)\b|kubectl\s+(?:config\s+view|(?:get|describe)\s+secrets?)\b|security\s+find-|doppler\b|cmdkey\b)/i;

const toSlashes = (s) => String(s).replace(/\\(["'])/g, '$1').replace(/\\/g, '/');

function isSensitivePath(p) {
	if (typeof p !== 'string' || !p) return false;
	const t = toSlashes(p);
	return FILE_RE.test(t) || DIR_RE.test(t);
}

// Looks at the whole command text, so a wrapper (rtk, sudo, bash -lc, pipes, && chains, $( )) cannot hide it. When in doubt it says yes.
function isSensitiveCommand(command) {
	const raw = String(command == null ? '' : command);
	if (raw.length > 8000) return true;
	const text = toSlashes(raw);
	if (FILE_RE.test(text) || DIR_RE.test(text) || VAR_RE.test(raw)) return true;
	for (const seg of text.split(/[|;&\r\n`'"()]+/)) {
		const tokens = seg.trim().split(/\s+/).filter(Boolean);
		for (let i = 0; i < tokens.length; i++) {
			const tail = tokens.slice(i).join(' ');
			if (ENV_DUMP_RE.test(tail) || CLI_RE.test(tail)) return true;
		}
	}
	return false;
}

// ---------- label rules (plan 9) ----------
const BUILTIN_RULES = [
	{ match: 'brain-retrieve\\.ps1["\']?\\s+["\']?([^"\']+)', label: "Brain: retrieve '$1'" },
	{ match: 'brain-search\\.ps1["\']?\\s+["\']?([^"\']+)', label: "Brain: search '$1'" },
	{ match: 'save_and_ingest\\.ps1|save-and-ingest\\.cmd', label: 'Brain: save raw note and ingest' },
	{ match: 'brain\\.py["\']?\\s+(retrieve|search)\\s+["\']?([^"\']+)', label: "Brain: $1 '$2'" },
	{ match: 'brain\\.py["\']?\\s+(\\w+)', label: 'Brain: $1' },
	{ match: '^bd\\s+(\\S+)', label: 'Beads: $1' },
	{ match: '^git\\s+(?:(?:-C|-c)\\s+\\S+\\s+)*([a-z][\\w-]*)', label: 'Git: $1' },
	{ match: '^gh\\s+pr\\s+(\\S+)', label: 'PR: $1' },
];

const compileRule = (r, report, source) => {
	try {
		if (!r || typeof r.match !== 'string' || typeof r.label !== 'string') throw new Error('a rule needs "match" and "label" strings');
		return { re: new RegExp(r.match, 'i'), label: r.label, kind: r.kind === 'hook' ? 'hook' : 'tool', show: r.show === true, hideOutput: r.hideOutput === true };
	} catch (e) { report(`${source}: skipped rule ${JSON.stringify(r && r.match)}: ${e.message}`); return null; }
};
const split = (labels, rules) => { labels.rules = rules.filter((r) => r.kind !== 'hook'); labels.hookRules = rules.filter((r) => r.kind === 'hook'); return labels; };
const BUILTIN_COMPILED = BUILTIN_RULES.map((r) => compileRule(r, () => {}, 'built-in'));
const builtinLabels = () => split({ dir: null, refresh() { return this; } }, BUILTIN_COMPILED);

// Reads activity-labels.local.json (first) and activity-labels.json from `dir`. A missing or broken shared file falls back to the built-in rules,
// a broken local file or rule is skipped; each problem is reported once through onProblem. refresh() re-reads only when a file's mtime changed.
function loadLabels(dir, onProblem = () => {}) {
	const files = ['activity-labels.local.json', 'activity-labels.json'];
	const reported = new Set();
	const labels = { dir, rules: [], hookRules: [], stamp: null, refresh };
	const report = (m) => { const k = `${m}|${labels.stamp}`; if (!reported.has(k)) { reported.add(k); onProblem(m); } };
	const read = (name, required) => {
		const file = path.join(dir, name);
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
			if (e.code !== 'ENOENT') report(`${name}: ${e.message}`);
			else if (required) report(`${name} not found, using built-in rules`);
			return null;
		}
		let json;
		try { json = JSON.parse(text); } catch (e) { report(`${name} is not valid JSON (${e.message}), ${required ? 'using built-in rules' : 'ignored'}`); return null; }
		if (!json || !Array.isArray(json.rules)) { report(`${name} has no "rules" array, ${required ? 'using built-in rules' : 'ignored'}`); return null; }
		return json.rules.map((r) => compileRule(r, report, name)).filter(Boolean);
	};
	function refresh() {
		const stamp = files.map((f) => { try { return String(fs.statSync(path.join(dir, f)).mtimeMs); } catch { return '-'; } }).join('|');
		if (stamp === labels.stamp) return labels;
		labels.stamp = stamp;
		return split(labels, [...(read(files[0], false) || []), ...(read(files[1], true) || BUILTIN_COMPILED)]);
	}
	return refresh();
}

// Drops `cd x &&`, sudo/time/nohup, env assignments, `rtk [proxy]`, `bash -lc '...'`, `powershell -Command "..."`, `cmd /c`; turns \ into /.
function normalizeCommand(command) {
	let s = toSlashes(String(command == null ? '' : command)).replace(/\s+/g, ' ').trim();
	for (let n = 0; n < 8; n++) {
		const before = s;
		s = s.replace(/^cd (?:"[^"]*"|'[^']*'|\S+) ?(?:&&|;) ?/i, '');
		s = s.replace(/^(?:sudo|doas|nohup|time|exec|command|nice|stdbuf) (?:-[ugCh] \S+ |-\S+ )*/i, '');
		s = s.replace(/^rtk (?:proxy )?/i, '');
		s = s.replace(/^env (?:-\S+ |[A-Za-z_]\w*=\S* )*/i, '');
		s = s.replace(/^(?:[A-Za-z_]\w*=\S* )+/, '');
		let m = /^(?:\S*\/)?(?:bash|sh|zsh|dash)(?:\.exe)? (?:-\S+ )*-\w*c (["'])([\s\S]*)\1$/i.exec(s);
		if (m) s = m[2].trim();
		else if ((m = /^(?:\S*\/)?(?:powershell|pwsh)(?:\.exe)? (?:-\S+ )*?-(?:command|c) (["']?)([\s\S]*?)\1$/i.exec(s)) && !/ -file /i.test(s)) s = m[2].trim();
		else if ((m = /^cmd(?:\.exe)? \/c (.*)$/i.exec(s))) s = m[1].trim();
		if (s === before) break;
	}
	return s.slice(0, 2000);
}
function candidates(command) {
	const first = normalizeCommand(command);
	const out = [first];
	for (const part of first.split(/ ?(?:&&|\|\||;|\|) ?/)) { const n = normalizeCommand(part); if (n && !out.includes(n)) out.push(n); }
	return out;
}
// Text that is shown is masked before it is cut, so a cut can never leave half a secret behind. ctx = { safe(text), cut(text, n) }.
const IDENT = { safe: (s) => String(s), cut: (s, n) => String(s).slice(0, n) };
function fill(template, m, ctx = IDENT) { return oneLine(template.replace(/\$([1-9])/g, (_x, n) => ctx.cut(oneLine(m[Number(n)] || ''), 60))); }

// { label, hide }: label is null when no rule matched; hide is true for a rule with hideOutput or a sensitive command.
function commandInfo(command, labels, ctx = IDENT) {
	const rules = (labels || builtinLabels()).rules;
	const cands = candidates(ctx.safe(command == null ? '' : command));
	let label = null, hide = false;
	for (const rule of rules) {
		for (const c of cands) {
			const m = rule.re.exec(c);
			if (m) { label = fill(rule.label, m, ctx); hide = rule.hideOutput; break; }
		}
		if (label) break;
	}
	return { label, hide: hide || isSensitiveCommand(command) };
}

// ---------- what leaves, per tool (plan 8.2) ----------
const ERROR_TEXT_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'Agent', 'Task', 'Skill', 'WebFetch', 'WebSearch']);

function urlParts(u) {
	try { const p = new URL(u); return { host: p.host, shown: p.host + p.pathname }; } catch { const s = String(u).split(/[?#]/)[0]; return { host: s.replace(/^[a-z]+:\/\//i, '').split('/')[0], shown: s.replace(/^[a-z]+:\/\//i, '') }; }
}

// What the call itself shows. Returns raw (unmasked) text; the tracker masks and cuts it.
function describeUse(name, input, labels, ctx = IDENT) {
	const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
	const keys = Object.keys(i).join(', ');
	const head = (text, lines, chars) => firstLines(ctx.safe(text), lines).slice(0, chars);
	const range = i.offset != null || i.limit != null ? ` (lines ${Number(i.offset) || 0}-${(Number(i.offset) || 0) + (Number(i.limit) || 0)})` : '';
	switch (name) {
		case 'Bash': case 'PowerShell': {
			const cmd = str(i.command), info = commandInfo(cmd, labels, ctx), desc = oneLine(str(i.description));
			return { kind: 'tool', name, label: info.label || (desc ? `${name}: ${desc}` : name), summary: oneLine(cmd), input: cmd ? `$ ${cmd}` : '', out: 'bash', hide: info.hide };
		}
		case 'Read': {
			const p = str(i.file_path);
			return { kind: 'tool', name, label: `Read ${baseName(p)}`, summary: p + (range && i.limit ? range : ''), input: p + range, out: 'lines', hide: true };
		}
		case 'Edit': case 'Write': case 'NotebookEdit': {
			const p = str(i.file_path || i.notebook_path), sensitive = isSensitivePath(p);
			let input = p;
			if (!sensitive && name === 'Edit') input = `${p}\nold: ${head(str(i.old_string), 10, 400)}\nnew: ${head(str(i.new_string), 10, 400)}`;
			else if (!sensitive && name === 'Write') input = `${p}\n${countLines(str(i.content))} lines\n${head(str(i.content), 10, 400)}`;
			return { kind: 'tool', name, label: `${name === 'NotebookEdit' ? 'Edit' : name} ${baseName(p)}`, summary: p, input, out: 'none', hide: true };
		}
		case 'Grep': case 'Glob': {
			const pattern = str(i.pattern), where = str(i.path), glob = str(i.glob);
			const sensitive = isSensitivePath(where) || isSensitivePath(glob);
			return { kind: 'tool', name, label: `Search "${ctx.cut(pattern, 40)}"`, summary: pattern + (where ? ` in ${where}` : ''), input: `pattern: ${pattern}${where ? `\npath: ${where}` : ''}${glob ? `\nglob: ${glob}` : ''}`, out: 'grep', hide: sensitive };
		}
		case 'WebFetch': { const u = urlParts(str(i.url)); return { kind: 'tool', name, label: `Fetch ${u.host}`, summary: u.shown, input: u.shown, out: 'none', hide: true }; }
		case 'WebSearch': return { kind: 'tool', name, label: 'Search web', summary: ctx.cut(str(i.query), 120), input: ctx.cut(str(i.query), 120), out: 'none', hide: true };
		case 'Agent': case 'Task': {
			const type = str(i.subagent_type) || 'agent', desc = oneLine(str(i.description));
			return { kind: 'agent', name: type, label: `Agent ${stripPrefix(type)}: ${ctx.cut(desc, 80)}`.replace(/: $/, ''), summary: desc, input: ctx.cut(str(i.prompt), LIMITS.promptHead), out: 'report', hide: false };
		}
		case 'Skill': {
			const skill = str(i.skill) || 'skill';
			return { kind: 'skill', name: skill, label: `Skill: ${skill}`, summary: ctx.cut(oneLine(str(i.args)), 80), input: ctx.cut(str(i.args), 80), out: 'none', hide: true };
		}
		default:
			if (/^mcp__/.test(name)) {
				const parts = name.split('__');
				return { kind: 'tool', name, label: `MCP ${parts[1] || ''}: ${parts.slice(2).join('__')}`, summary: keys, input: keys, out: 'none', hide: true };
			}
			return { kind: 'tool', name, label: name, summary: keys, input: keys, out: 'none', hide: true };
	}
}
const labelFor = (name, input, labels) => describeUse(name, input, labels).label;
const summaryFor = (name, input, labels) => describeUse(name, input, labels).summary;
const detailFor = (name, input, labels) => describeUse(name, input, labels).input;

// What a successful hook handed to Claude: context it added, input it rewrote, a block, or a message. null when it only said "continue".
// Plain stdout reaches Claude only from SessionStart and UserPromptSubmit; elsewhere it is ignored, so it is not shown.
function hookEffect(o, event) {
	const raw = String(o.stdout || o.output || '').trim();
	if (!raw) return null;
	let j = null;
	if (raw.startsWith('{')) { try { j = JSON.parse(raw); } catch {} }
	if (!j || typeof j !== 'object') return /^(?:SessionStart|UserPromptSubmit)/.test(event) ? { what: 'context', text: raw } : null;
	const h = j.hookSpecificOutput && typeof j.hookSpecificOutput === 'object' ? j.hookSpecificOutput : {};
	if (h.updatedInput && typeof h.updatedInput === 'object') return { what: 'rewrite', text: str(h.updatedInput.command) || JSON.stringify(h.updatedInput) };
	if (j.decision === 'block' || h.permissionDecision === 'deny') return { what: 'block', text: str(j.reason) || str(h.permissionDecisionReason) };
	if (str(h.additionalContext).trim()) return { what: 'context', text: h.additionalContext };
	if (str(j.systemMessage).trim()) return { what: 'message', text: j.systemMessage };
	return null;
}
const HOOK_EFFECT_LABEL = { context: 'added context', rewrite: 'rewrote the input', block: 'blocked', message: 'message' };

function resultText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : b && b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}
function isBackgroundLaunch(input, content, isError) {
	if (isError === true) return false;
	if (input && input.run_in_background === true) return true;
	const first = Array.isArray(content) ? (content.find((b) => b && b.type === 'text') || {}).text : content;
	return typeof first === 'string' && /^\s*Async agent launched/.test(first);
}
function errorSummary(text) {
	const lines = String(text).split('\n').map(oneLine).filter(Boolean);
	if (!lines.length) return 'Failed';
	return /^Exit code \d+$/i.test(lines[0]) && lines[1] ? `${lines[0]}: ${lines[1]}` : lines[0];
}
const DENIAL_RE = /permission|denied|not allowed|blocked|refus|forbidden|disallow/i;

const HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n"']+)/gi;
function createSafe(mask = (s) => s) {
	const safe = (s) => {
		let t = String(s == null ? '' : s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\0/g, '');
		t = mask(t);
		t = t.replace(HEADER, (_m, k, sep) => k + sep + '***');
		return mask(t);
	};
	const fit = (s, n) => { const t = safe(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
	return { safe, fit };
}

// ---------- the tracker ----------
function createTracker({ mask = (s) => s, labels = null, now = Date.now, limits = {}, hooks = true } = {}) {
	const L = { ...LIMITS, ...limits };
	const lab = labels || builtinLabels();
	const rows = new Map();           // id -> row, insertion order = creation order
	const dirty = new Set();
	const hookOpen = new Map();       // hook_id -> { name, event, at }
	const stats = { hooksOk: 0, hooksFailed: 0, dropped: 0, skipped: 0, errors: 0, seen: 0, orphaned: 0 };
	let seq = 0, hookSeq = 0, noteSeq = 0, lastThinking = null;
	const iso = (ms) => new Date(ms == null ? now() : ms).toISOString();

	const { safe, fit } = createSafe(mask);
	const joinCut = (head, tail, lines) => `${head}\n… [${lines} lines cut] …\n${tail}`;
	// Masks first, then cuts, so a secret that straddles a cut point is gone before the cut; the pieces are masked once more.
	const clip = (text, head, tail) => {
		const t = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\s+$/, '');
		if (t.length <= head + tail) return safe(t);
		if (t.length <= 2000000) {
			const m = safe(t);
			if (m.length <= head + tail) return m;
			return joinCut(safe(m.slice(0, head)), safe(m.slice(-tail)), countLines(m.slice(head, m.length - tail)));
		}
		const h = safe(t.slice(0, 3000)).slice(0, head), e = safe(t.slice(-3000)).slice(-tail);
		return joinCut(h, e, countLines(t.slice(head, t.length - tail)));
	};
	const looksLikeEnvDump = (text) => (String(text).match(/^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}=\S/gm) || []).length >= 5;

	const depthOf = (id) => { const r = rows.get(id); return r ? r.depth : 1; };
	const agentTitle = (r) => (r.x.desc ? `${stripPrefix(r.name)}: ${r.x.desc}` : stripPrefix(r.name));
	const agentOf = (parentId) => { if (!parentId) return 'main'; const p = rows.get(parentId); if (!p) return 'agent'; return (p.x.desc ? fit(agentTitle(p), L.agent) : stripPrefix(p.name).slice(0, L.agent)) || 'agent'; };

	function set(row, field, value) {
		if (row[field] === value) return;
		row[field] = value;
		dirty.add(row.id);
	}
	function compose(row) {
		const x = row.x;
		let d = [x.in, x.out].filter(Boolean).join('\n');
		if (x.hidden) d = '[hidden]';
		set(row, 'detail', d ? d.slice(0, L.detail) : null);
	}
	function add(fields) {
		const row = { id: fields.id, parentId: fields.parentId || null, kind: fields.kind, agent: fields.agent || 'main', name: fit(fields.name, L.name), label: fit(fields.label, L.label), summary: fit(fields.summary || '', L.summary), detail: null, status: fields.status || 'running', startedAt: fields.startedAt || iso(), endedAt: fields.endedAt || null, seq: ++seq, depth: 1, x: { in: '', out: '', hidden: false, tool: fields.tool || '', out_kind: fields.out || 'none', hide: !!fields.hide, sentStatus: null, prevSent: null, reported: false } };
		if (row.parentId) { row.depth = depthOf(row.parentId) + 1; }
		row.x.in = fields.input ? fit(fields.input, L.input) : '';
		rows.set(row.id, row);
		if (fields.kind !== 'note' || fields.name !== 'thinking') lastThinking = null;
		compose(row);
		dirty.add(row.id);
		return row;
	}
	function attach(parentRaw) {
		let parentId = parentRaw ? cleanId(parentRaw) : null;
		if (parentId) {
			let p = rows.get(parentId);
			while (p && p.depth >= L.depth) { parentId = p.parentId; p = parentId ? rows.get(parentId) : null; }
		}
		return parentId;
	}

	// ----- dropping (plan 3.4) -----
	const isDone = (r) => r.status === 'ok' && (r.x.sentStatus === null || r.x.sentStatus === 'ok');
	function count(parentId, n) {
		const id = parentId ? `dropped-${parentId}`.slice(0, L.id) : 'dropped';
		let r = rows.get(id);
		const total = (r ? Number(r.summary) : 0) + n;
		if (!r) r = add({ id, parentId, kind: 'note', name: 'dropped', agent: agentOf(parentId), label: '', summary: '', status: 'ok', endedAt: iso() });
		set(r, 'summary', String(total));
		set(r, 'label', `${total} steps not shown`);
	}
	function remove(row, counted) {
		rows.delete(row.id); dirty.delete(row.id);
		if (counted) { stats.dropped++; count(row.parentId, 1); }
	}
	function makeRoom() {
		let trimmed = false;
		while (rows.size > L.rows) {
			const all = [...rows.values()];
			let v = all.find((r) => r.kind === 'hook' && isDone(r)) || all.find((r) => r.kind === 'note' && r.name !== 'dropped' && r.name !== 'subagent' && isDone(r));
			if (v) { remove(v, false); continue; }
			if (!trimmed) {
				trimmed = true;
				for (const r of all) if (r.parentId && r.kind !== 'agent' && r.status === 'ok' && r.detail) { r.x.in = ''; r.x.out = ''; set(r, 'detail', null); }
			}
			v = all.find((r) => r.kind === 'tool' && r.parentId && isDone(r)) || all.find((r) => r.kind === 'tool' && !r.parentId && isDone(r));
			if (!v) break;
			remove(v, true);
		}
	}

	// ----- opening and closing rows -----
	function openTool(block, parentRaw, at) {
		const name = str(block.name);
		const id = cleanId(block.id, `t-${seq + 1}`);
		if (!name || rows.has(id)) { if (name) stats.skipped++; return; }
		if (name === 'SubagentHandback') return;
		const u = describeUse(name, block.input, lab, { safe, cut: fit });
		if (u.kind === 'tool' && rows.size >= L.hardRows) { stats.dropped++; count(attach(parentRaw), 1); return; }
		const parentId = attach(parentRaw);
		const row = add({ id, parentId, kind: u.kind, agent: agentOf(parentId), name: u.name, label: u.label, summary: u.summary, input: u.input, out: u.out, hide: u.hide, tool: name, startedAt: at });
		if (u.kind === 'agent') { row.x.desc = u.summary; row.x.bg = !!block.input && block.input.run_in_background === true; }
		makeRoom();
	}
	function subNote(prefix, row, label, status) {
		const at = iso();
		add({ id: cleanId(`${prefix}-${row.id}`), kind: 'note', name: 'subagent', label, status, startedAt: at, endedAt: at });
		makeRoom();
	}
	function finish(row, block, meta, at) {
		const text = resultText(block.content);
		const x = row.x;
		if (row.status !== 'running') { if (row.kind === 'agent' && !x.reported) addReport(row, text); return; }
		const isErr = block.is_error === true;
		if (row.kind === 'agent' && !x.bgStarted && isBackgroundLaunch({ run_in_background: x.bg }, block.content, isErr)) {
			x.bg = x.bgStarted = true;
			set(row, 'summary', 'Running in background');
			subNote('sub-start', row, `Subagent started: ${agentTitle(row)}`, 'ok');
			return;
		}
		const decision = meta && meta.permission_decision && meta.permission_decision.decision;
		let denied = isErr && ((decision != null && !/^(accept|allow)/i.test(String(decision))) || (!/^Exit code \d+/i.test(text) && DENIAL_RE.test(text.slice(0, 300))));
		const status = denied ? 'denied' : isErr ? 'error' : 'ok';
		if (denied) set(row, 'summary', fit(`Blocked: ${fit(oneLine(text), 160)}`, L.summary));
		else if (isErr) set(row, 'summary', fit(ERROR_TEXT_TOOLS.has(x.tool) ? errorSummary(safe(text)) : 'Tool failed', L.summary));
		if (x.out_kind === 'bash') {
			if (x.hide) x.out = HIDDEN_NOTE;
			else { x.out = clip(text, L.outHead, L.outTail); if (looksLikeEnvDump(text)) { x.hidden = true; set(row, 'summary', '[hidden]'); } }
		} else if (x.out_kind === 'lines') x.out = (Array.isArray(block.content) && block.content.some((b) => b && b.type === 'image')) ? 'image' : `${countLines(text)} lines`;
		else if (x.out_kind === 'grep') x.out = x.hide ? '' : `${firstLines(safe(text), 10).slice(0, 600)}\n${countLines(text)} lines`.trim();
		else if (x.out_kind === 'report') addReport(row, text, true);
		compose(row);
		set(row, 'status', status);
		set(row, 'endedAt', at || iso());
		lastThinking = null;
		makeRoom();
	}
	function addReport(row, text, quiet) {
		row.x.reported = true;
		if (!text) return;
		row.x.out = `--- report ---\n${clip(text, L.reportHead, L.reportTail)}`;
		compose(row);
		if (!quiet) makeRoom();
	}

	function onAssistant(o) {
		const content = o.message && o.message.content;
		if (!Array.isArray(content)) return;
		const parentRaw = typeof o.parent_tool_use_id === 'string' && o.parent_tool_use_id ? o.parent_tool_use_id : null;
		const at = iso();
		for (const b of content) {
			if (!b || typeof b !== 'object') continue;
			if (b.type === 'tool_use') openTool(b, parentRaw, at);
			else if (b.type === 'text' && parentRaw) {
				const p = rows.get(cleanId(parentRaw));
				if (p && p.kind === 'agent' && p.status === 'running' && oneLine(b.text)) set(p, 'summary', fit(oneLine(b.text), L.summary));
			} else if (b.type === 'thinking') thinking(parentRaw, Number(o.thinking_duration_ms) || 0, at);
		}
		makeRoom();
	}
	function thinking(parentRaw, ms, at) {
		const parentId = attach(parentRaw);
		const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
		if (lastThinking && rows.has(lastThinking.id) && lastThinking.parentId === parentId) {
			const r = rows.get(lastThinking.id);
			lastThinking.ms += ms;
			set(r, 'summary', `thought for ${fmt(lastThinking.ms)}`);
			set(r, 'endedAt', at);
			return;
		}
		const r = add({ id: `note-${++noteSeq}`, parentId, kind: 'note', name: 'thinking', agent: agentOf(parentId), label: 'Thinking', summary: `thought for ${fmt(ms)}`, status: 'ok', startedAt: at, endedAt: at });
		lastThinking = { id: r.id, parentId, ms };
	}
	function onUser(o) {
		const content = o.message && o.message.content;
		if (!Array.isArray(content)) return;
		const metas = Array.isArray(o.tool_result_meta) ? o.tool_result_meta : [];
		const at = iso();
		for (const b of content) {
			if (!b || b.type !== 'tool_result') continue;
			const row = rows.get(cleanId(b.tool_use_id));
			if (!row) continue;
			finish(row, b, metas.find((m) => m && m.id === b.tool_use_id), at);
		}
	}
	function onHook(o) {
		if (!hooks) return;
		const key = String(o.hook_id || '');
		if (o.subtype === 'hook_started') { if (key) hookOpen.set(key, { name: str(o.hook_name), event: str(o.hook_event), at: iso() }); return; }
		const open = hookOpen.get(key) || { name: str(o.hook_name), event: str(o.hook_event), at: iso() };
		hookOpen.delete(key);
		const name = open.name || str(o.hook_name), event = open.event || str(o.hook_event);
		const code = Number.isFinite(o.exit_code) ? o.exit_code : 0;
		const failed = code !== 0 || (o.outcome != null && o.outcome !== 'success');
		const effect = failed ? null : hookEffect(o, event);
		const rule = lab.hookRules.find((r) => r.show && r.re.test(`${name} ${event}${effect ? ` ${oneLine(effect.text).slice(0, 300)}` : ''}`));
		if (!failed && !rule && !effect) { stats.hooksOk++; return; }
		if (failed) stats.hooksFailed++;
		const matcher = name.includes(':') ? name.slice(name.indexOf(':') + 1) : '';
		let parentId = null, same = [];
		if (matcher && /^(?:Pre|Post)ToolUse/.test(event)) {
			same = [...rows.values()].filter((r) => r.status === 'running' && r.kind !== 'note' && r.x.tool === matcher);
			if (same.length === 1) parentId = same[0].parentId;
		}
		// A rewrite (rtk) belongs to the call it changed: the row shows the command that really runs instead of a row of its own.
		if (effect && effect.what === 'rewrite' && same.length === 1) {
			const tool = same[0];
			tool.x.in = fit(`${tool.x.in}\n→ ${effect.text}`, L.input);
			set(tool, 'summary', fit(oneLine(effect.text), L.summary));
			compose(tool);
			stats.hooksOk++;
			return;
		}
		// SessionStart hooks run again on every resumed turn; what they added is one row, not one per hook.
		if (effect && !rule && event === 'SessionStart') {
			let g = rows.get('hook-session-start');
			if (!g) { g = add({ id: 'hook-session-start', kind: 'hook', name: 'SessionStart', label: 'Session start: added context', summary: '', startedAt: open.at }); g.x.count = 0; }
			g.x.count++;
			g.x.out = [g.x.out, clip(effect.text, 400, 150)].filter(Boolean).join('\n---\n');
			set(g, 'summary', g.x.count === 1 ? fit(oneLine(effect.text), L.summary) : `${g.x.count} hooks added context`);
			set(g, 'status', 'ok');
			set(g, 'endedAt', iso());
			compose(g);
			makeRoom();
			return;
		}
		const blocked = failed && code === 2 && event === 'PreToolUse';
		const label = rule && !failed ? fill(rule.label, [name]) : failed ? `Hook ${name} ${blocked ? 'blocked the call' : 'failed'}` : `Hook ${name}: ${HOOK_EFFECT_LABEL[effect.what]}`;
		const summary = failed ? `exit ${code}${o.outcome ? `, ${o.outcome}` : ''}` : effect ? oneLine(effect.text) : 'ok';
		const r = add({ id: `hook-${++hookSeq}`, parentId, kind: 'hook', name, agent: agentOf(parentId), label, summary, status: failed ? (blocked ? 'denied' : 'error') : 'ok', startedAt: open.at, endedAt: iso() });
		r.x.in = '';
		if (effect) { r.x.out = clip(effect.text, 1200, 600); compose(r); }
		makeRoom();
	}
	function onTaskDone(o) {
		const row = rows.get(cleanId(o.tool_use_id));
		if (!row || row.kind !== 'agent' || row.status !== 'running') return;
		const s = String(o.status || 'completed');
		const status = s === 'completed' ? 'ok' : /fail|error/i.test(s) ? 'error' : 'stopped';
		set(row, 'status', status);
		set(row, 'endedAt', iso());
		if (row.x.bgStarted) subNote('sub-end', row, `Subagent ${status === 'ok' ? 'finished' : status === 'error' ? 'failed' : 'stopped'}: ${agentTitle(row)}`, 'ok');
	}
	function orphanAgents() {
		for (const r of [...rows.values()]) if (r.kind === 'agent' && r.status === 'running') { if (r.x.bg && !r.parentId) stats.orphaned++; subNote('sub-kill', r, `Subagent killed (turn ended): ${agentTitle(r)}`, 'stopped'); }
	}
	function closeAll(status = 'stopped') {
		const at = iso();
		for (const r of rows.values()) if (r.status === 'running') { set(r, 'status', status); set(r, 'endedAt', at); }
	}

	function feed(o) {
		try {
			if (!o || typeof o !== 'object') return;
			stats.seen++;
			if (o.type === 'assistant') onAssistant(o);
			else if (o.type === 'user') onUser(o);
			else if (o.type === 'system') {
				if (o.subtype === 'hook_started' || o.subtype === 'hook_response') onHook(o);
				else if (o.subtype === 'task_notification') onTaskDone(o);
			} else if (o.type === 'result') { orphanAgents(); closeAll('stopped'); }
		} catch { stats.errors++; }
	}

	function wire(r) {
		const ev = { id: r.id, parentId: r.parentId, kind: r.kind, agent: fit(r.agent, L.agent), name: fit(r.name, L.name), label: fit(r.label, L.label), summary: fit(r.summary, L.summary), detail: r.detail == null ? null : safe(r.detail).slice(0, L.detail), status: r.status, startedAt: r.startedAt, endedAt: r.endedAt };
		const size = () => Buffer.byteLength(JSON.stringify(ev));
		while (size() > L.eventBytes && ev.detail) ev.detail = ev.detail.length > 200 ? ev.detail.slice(0, Math.floor(ev.detail.length * 0.7)) : null;
		if (size() > L.eventBytes) ev.summary = ev.summary.slice(0, 100);
		if (size() > L.eventBytes) ev.label = ev.label.slice(0, 60);
		return ev;
	}
	function drain(max = 50, maxBytes = 100 * 1024) {
		const out = [];
		let bytes = 0;
		for (const id of [...dirty]) {
			const row = rows.get(id);
			if (!row) { dirty.delete(id); continue; }
			const ev = wire(row), size = Buffer.byteLength(JSON.stringify(ev)) + 1;
			if (out.length >= max || (out.length && bytes + size > maxBytes - 512)) break;
			out.push(ev); bytes += size; dirty.delete(id);
			row.x.prevSent = row.x.sentStatus; row.x.sentStatus = row.status;
		}
		return out;
	}
	function requeue(events) {
		for (const ev of events || []) { const r = rows.get(ev && ev.id); if (r) { r.x.sentStatus = r.x.prevSent; dirty.add(r.id); } }
	}
	const snapshot = () => [...rows.values()].map((r) => ({ ...wire(r), eventId: r.id, seq: r.seq }));
	const summary = () => ({ rows: rows.size, pending: dirty.size, running: [...rows.values()].filter((r) => r.status === 'running').length, ...stats });

	return { feed, drain, requeue, closeAll, stats: summary, snapshot };
}

module.exports = { createTracker, isBackgroundLaunch, loadLabels, builtinLabels, commandInfo, normalizeCommand, labelFor, summaryFor, detailFor, resultFor: resultText, isSensitiveCommand, isSensitivePath, describeUse, createSafe, errorSummary, LIMITS, HIDDEN_NOTE, BUILTIN_RULES };
