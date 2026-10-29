'use strict';
// status.cjs for the sous flow: D-n / I-n, rounds, the verify lock, render, the new set fields and CARD keys, on a scratch evidence folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KIT, tmp, rmrf, runNode, sandboxEnv } = require('./helpers.cjs');

function scratch(label) {
  const base = tmp(label);
  const evidence = path.join(base, 'evidence');
  fs.mkdirSync(path.join(base, 'sandbox'), { recursive: true });
  const status = (...args) => runNode([path.join(KIT, 'status.cjs'), ...args], { env: { ...sandboxEnv(path.join(base, 'sandbox')), QONFLO_EVIDENCE: evidence } });
  const ledger = (key) => JSON.parse(fs.readFileSync(path.join(evidence, key, 'status.json'), 'utf8'));
  return { base, evidence, status, ledger };
}

test('decide keeps the old form and adds status, by, issue, effect, other options and replaces', async () => {
  const { base, status, ledger } = scratch('sous-decide');
  try {
    await status('init', 'ZED-401', 'Invented', '-', '-', '-', '-');
    const legacy = ledger('ZED-401');
    legacy.decisions = [{ at: '2026-10-01T00:00:00.000Z', text: 'written by the old flow' }];
    fs.writeFileSync(path.join(base, 'evidence', 'ZED-401', 'status.json'), JSON.stringify(legacy));
    let r = await status('decide', 'ZED-401', 'plain', 'text');
    assert.match(r.stdout, /decision #2 \(D-2 DECIDED by owner\)/);
    r = await status('decide', 'ZED-401', 'take A', '--status', 'GUESS', '--by', 'arbiter');
    assert.match(r.stdout, /D-3 GUESS by arbiter/);
    r = await status('decide', 'ZED-401', 'x', '--status', 'MAYBE');
    assert.equal(r.code, 2);
    r = await status('decide', 'ZED-401', 'x', '--by', 'robot');
    assert.equal(r.code, 2);
    r = await status('decide', 'ZED-401', 'x', '--issue', '9');
    assert.match(r.stdout, /REFUSED: ZED-401 has no I-9/);
    r = await status('decide', 'ZED-401', 'disable Save on an empty form', '--status', 'GUESS', '--by', 'sous',
      '--effect', 'Save stays grey until a field is filled', '--alt', 'show an error on Save::the button stays active, an error appears', '--alt', 'save the empty form');
    assert.match(r.stdout, /D-4 GUESS by sous/);
    r = await status('decide', 'ZED-401', 'show an error on Save', '--replaces', '4');
    assert.match(r.stdout, /D-5 DECIDED by owner\); D-4 SUPERSEDED/);
    r = await status('decide', 'ZED-401', 'again', '--replaces', '4');
    assert.match(r.stdout, /REFUSED: D-4 is SUPERSEDED and cannot be replaced/);
    r = await status('decide', 'ZED-401', 'x', '--replaces', '9');
    assert.match(r.stdout, /REFUSED: ZED-401 has no D-9/);
    const d = ledger('ZED-401').decisions;
    assert.equal(d.length, 5);
    assert.deepEqual([d[0].text, d[0].status ?? 'DECIDED'], ['written by the old flow', 'DECIDED']);
    assert.deepEqual([d[1].n, d[1].status, d[1].by, d[1].text], [2, 'DECIDED', 'owner', 'plain text']);
    assert.deepEqual([d[2].n, d[2].status, d[2].by, d[2].effect, d[2].alts], [3, 'GUESS', 'arbiter', undefined, undefined]);
    assert.deepEqual([d[3].status, d[3].supersededBy, d[3].effect], ['SUPERSEDED', 5, 'Save stays grey until a field is filled']);
    assert.deepEqual(d[3].alts, [{ label: 'show an error on Save', effect: 'the button stays active, an error appears' }, { label: 'save the empty form', effect: '' }]);
    assert.deepEqual([d[4].status, d[4].by, d[4].replaces], ['DECIDED', 'owner', 4]);
    await status('render', 'ZED-401');
    const md = fs.readFileSync(path.join(base, 'evidence', 'blackboard', 'ZED-401', 'decisions.md'), 'utf8');
    assert.match(md, /- \*\*Effect:\*\* Save stays grey until a field is filled/);
    assert.match(md, /- \*\*Other option:\*\* show an error on Save \(effect: the button stays active, an error appears\)/);
    assert.match(md, /- \*\*Superseded by:\*\* D-5/);
    assert.match(md, /- \*\*Replaces:\*\* D-4/);
  } finally {
    rmrf(base);
  }
});

test('decide records the question and every rejected option, by the agent that decided', async () => {
  const { base, status, ledger } = scratch('sous-decide-why');
  try {
    await status('init', 'ZED-420', 'Invented', '-', '-', '-', '-');
    let r = await status('decide', 'ZED-420', 'keep the old endpoint', '--status', 'GUESS', '--by', 'sous-ticket-runner',
      '--question', 'the AC names no endpoint', '--rejected', 'a new endpoint: the FE would need a second call',
      '--rejected', 'a query flag: still has: a colon', '--rejected', 'do nothing', '--rejected', ' ');
    assert.match(r.stdout, /D-1 GUESS by sous-ticket-runner/);
    r = await status('decide', 'ZED-420', 'plain', '--by', 'sous');
    assert.match(r.stdout, /D-2 DECIDED by sous/);
    r = await status('decide', 'ZED-420', 'x', '--by', 'robot');
    assert.equal(r.code, 2);
    r = await status('decide', 'ZED-420', 'x', '--by', 'sous-');
    assert.equal(r.code, 2);
    const d = ledger('ZED-420').decisions;
    assert.equal(d[0].question, 'the AC names no endpoint');
    assert.deepEqual(d[0].rejected, [
      { option: 'a new endpoint', why: 'the FE would need a second call' },
      { option: 'a query flag', why: 'still has: a colon' },
      { option: 'do nothing', why: '' },
    ]);
    assert.ok(!('question' in d[1]) && !('rejected' in d[1]), 'no flags, no fields');
    r = await status('show', 'ZED-420');
    assert.match(r.stdout, /"question": "the AC names no endpoint"/);
    assert.match(r.stdout, /"option": "a new endpoint"/);
    await status('render', 'ZED-420');
    const md = fs.readFileSync(path.join(base, 'evidence', 'blackboard', 'ZED-420', 'decisions.md'), 'utf8');
    assert.match(md, /- \*\*Question:\*\* the AC names no endpoint\n- \*\*Decision:\*\* keep the old endpoint/);
    assert.match(md, /- \*\*Rejected:\*\* a new endpoint \(why not: the FE would need a second call\)/);
    assert.match(md, /- \*\*Rejected:\*\* a query flag \(why not: still has: a colon\)/);
    assert.match(md, /- \*\*Rejected:\*\* do nothing\n/);
    assert.match(md, /## D-2\n- \*\*Status:\*\* DECIDED · \*\*By:\*\* sous · \*\*At:\*\* [^\n]+\n- \*\*Decision:\*\* plain\n*$/);
  } finally {
    rmrf(base);
  }
});

test('an old ledger without question or rejected renders exactly as before', async () => {
  const { base, evidence, status } = scratch('sous-decide-old');
  try {
    fs.mkdirSync(path.join(evidence, 'ZED-421'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'ZED-421', 'status.json'), JSON.stringify({ key: 'ZED-421', title: 'Old', stage: 'code', ac: [], decisions: [
      { at: '2026-10-01T08:00:00.000Z', text: 'written by the old flow' },
      { n: 2, at: '2026-10-02T09:30:00.000Z', text: 'take B', status: 'GUESS', by: 'arbiter', effect: 'B shows', alts: [{ label: 'A', effect: '' }] },
    ] }));
    await status('render', 'ZED-421');
    const md = fs.readFileSync(path.join(evidence, 'blackboard', 'ZED-421', 'decisions.md'), 'utf8');
    assert.equal(md.split('\n').slice(1).join('\n'), [
      '# Decisions - ZED-421', '',
      'Precedence: owner DECIDED > GUESS > contract > Jira AC > USULAN. CANCELLED and SUPERSEDED entries do not apply.', '',
      '## D-1', '- **Status:** DECIDED · **By:** owner · **At:** 2026-10-01 08:00', '- **Decision:** written by the old flow', '',
      '## D-2', '- **Status:** GUESS · **By:** arbiter · **At:** 2026-10-02 09:30', '- **Decision:** take B', '- **Effect:** B shows', '- **Other option:** A', '',
    ].join('\n'));
  } finally {
    rmrf(base);
  }
});

test('an issue climbs arbiter, sous, owner and is resolved by a decision', async () => {
  const { base, status, ledger } = scratch('sous-issue');
  try {
    await status('init', 'ZED-402', 'Invented', '-', '-', '-', '-');
    let r = await status('issue', 'ZED-402', 'QUESTION', 'which', 'shape', '--options', 'A | B');
    assert.match(r.stdout, /I-1: QUESTION open at level arbiter/);
    r = await status('issue', 'ZED-402', 'WORRY', 'x');
    assert.equal(r.code, 2);
    r = await status('issue', 'ZED-402', '1', 'escalate', 'boss', 'x');
    assert.equal(r.code, 2);
    r = await status('issue', 'ZED-402', '1', 'escalate', 'sous');
    assert.match(r.stdout, /REFUSED: an escalation needs the reason/);
    await status('issue', 'ZED-402', '1', 'escalate', 'sous', 'arbiter cannot see the contract');
    assert.equal(ledger('ZED-402').waiting, '');
    await status('issue', 'ZED-402', '1', 'escalate', 'owner', 'two readings');
    let s = ledger('ZED-402');
    assert.equal(s.waiting, 'I-1: which shape [A|B]');
    assert.equal(s.draft, true);
    assert.deepEqual(s.issues[0].escalations.map((e) => e.to), ['sous', 'owner']);
    r = await status('issue', 'ZED-402', '1', 'resolve', '1');
    assert.match(r.stdout, /no D-1/);
    await status('decide', 'ZED-402', 'B', '--issue', '1');
    r = await status('issue', 'ZED-402', '1', 'resolve', '1');
    assert.match(r.stdout, /I-1: resolved by D-1/);
    s = ledger('ZED-402');
    assert.equal(s.waiting, '');
    assert.deepEqual([s.issues[0].status, s.issues[0].resolvedBy, s.decisions[0].issue], ['resolved', 1, 1]);
    r = await status('issue', 'ZED-402', '1', 'resolve', '1');
    assert.match(r.stdout, /already resolved/);
  } finally {
    rmrf(base);
  }
});

test('a SHOV decision from an older kit reads as GUESS, and --status SHOV is recorded as GUESS', async () => {
  const { base, evidence, status, ledger } = scratch('sous-legacy-guess');
  try {
    await status('init', 'ZED-406', 'Invented', '-', '-', '-', '-');
    const old = ledger('ZED-406');
    old.decisions = [{ n: 1, at: '2026-10-01T00:00:00.000Z', text: 'old guess', status: 'SHOV', by: 'sous' }];
    fs.writeFileSync(path.join(evidence, 'ZED-406', 'status.json'), JSON.stringify(old));
    let r = await status('decide', 'ZED-406', 'new', 'guess', '--status', 'SHOV', '--by', 'arbiter');
    assert.match(r.stdout, /D-2 GUESS by arbiter/);
    assert.equal(ledger('ZED-406').decisions[1].status, 'GUESS');
    r = await status('decide', 'ZED-406', 'replace', 'it', '--replaces', '1');
    assert.match(r.stdout, /D-1 SUPERSEDED/, 'a SHOV entry is in force like a GUESS');
    await status('render', 'ZED-406');
    const now = fs.readFileSync(path.join(evidence, 'blackboard', 'ZED-406', 'NOW.md'), 'utf8');
    assert.match(now, /- D-2 GUESS: new guess/);
    assert.doesNotMatch(now, /SHOV/);
  } finally {
    rmrf(base);
  }
});

test('issue options carry what choosing each one changes', async () => {
  const { base, status, ledger } = scratch('sous-issue-effects');
  try {
    await status('init', 'ZED-412', 'Invented', '-', '-', '-', '-');
    await status('issue', 'ZED-412', 'QUESTION', 'delete', 'or', 'hide', '--options', 'hard delete::the row is gone for good | soft delete::the list needs a filter');
    await status('issue', 'ZED-412', 'QUESTION', 'no', 'effects', '--options', 'A|B');
    const [withEffects, plain] = ledger('ZED-412').issues;
    assert.deepEqual([withEffects.options, withEffects.effects], [['hard delete', 'soft delete'], ['the row is gone for good', 'the list needs a filter']]);
    assert.deepEqual([plain.options, plain.effects], [['A', 'B'], undefined]);
    await status('issue', 'ZED-412', '1', 'escalate', 'owner', 'product call');
    assert.equal(ledger('ZED-412').waiting, 'I-1: delete or hide [hard delete|soft delete]');
    await status('render', 'ZED-412');
    const md = fs.readFileSync(path.join(base, 'evidence', 'blackboard', 'ZED-412', 'issues.md'), 'utf8');
    assert.match(md, /- \*\*Options:\*\* hard delete \(effect: the row is gone for good\) \| soft delete \(effect: the list needs a filter\)/);
    await status('decide', 'ZED-412', 'soft', '--status', 'GUESS', '--by', 'sous');
    await status('decide', 'ZED-412', 'hard', '--replaces', '1');
    assert.match((await status('issue', 'ZED-412', '1', 'resolve', '1')).stdout, /REFUSED: D-1 is superseded and cannot resolve an issue/);
  } finally {
    rmrf(base);
  }
});

test('rounds stop at max with an owner issue and a draft PR', async () => {
  const { base, status, ledger } = scratch('sous-round');
  try {
    await status('init', 'ZED-403', 'Invented', '-', '-', '-', '-');
    await status('set', 'ZED-403', 'rounds.max=2');
    assert.match((await status('round', 'ZED-403', 'missing', 'test')).stdout, /round 1\/2/);
    assert.match((await status('round', 'ZED-403')).stdout, /round 2\/2/);
    let r = await status('round', 'ZED-403', 'still', 'failing');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /rounds spent \(2\/2\); I-1 is with the owner/);
    r = await status('round', 'ZED-403');
    assert.match(r.stdout, /I-1 is already with the owner/);
    const s = ledger('ZED-403');
    assert.deepEqual([s.rounds.used, s.rounds.max, s.rounds.log.length], [2, 2, 2]);
    assert.equal(s.draft, true);
    assert.equal(s.issues.length, 1);
    assert.deepEqual([s.issues[0].level, s.issues[0].type, s.issues[0].status], ['owner', 'BLOCKER', 'open']);
    assert.match(s.waiting, /^I-1: review rounds spent \(2\/2\): still failing$/);
    assert.equal((await status('set', 'ZED-403', 'rounds.max=zero')).code, 2);
  } finally {
    rmrf(base);
  }
});

test('review rounds default to 2: the third round is refused with an owner issue', async () => {
  const { base, status, ledger } = scratch('sous-round-default');
  try {
    await status('init', 'ZED-404', 'Invented', '-', '-', '-', '-');
    assert.match((await status('round', 'ZED-404')).stdout, /round 1\/2/);
    assert.match((await status('round', 'ZED-404')).stdout, /round 2\/2/);
    const r = await status('round', 'ZED-404', 'third');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /rounds spent \(2\/2\); I-1 is with the owner and the PR opens as draft/);
    assert.deepEqual([ledger('ZED-404').rounds.max, ledger('ZED-404').draft], [2, true]);
  } finally {
    rmrf(base);
  }
});

test('the verify lock admits one holder, frees a dead or old one, and only its owner unlocks it', async () => {
  const { base, evidence, status } = scratch('sous-lock');
  try {
    let r = await status('lock', 'verify', 'ZED-1');
    assert.match(r.stdout, /acquired verify for ZED-1/);
    r = await status('lock', 'verify', 'ZED-1');
    assert.match(r.stdout, /already held by ZED-1/);
    r = await status('lock', 'verify', 'ZED-2');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /verify is held by ZED-1/);
    r = await status('unlock', 'verify', 'ZED-2');
    assert.equal(r.code, 2);
    assert.match((await status('unlock', 'verify', 'ZED-1')).stdout, /released verify for ZED-1/);
    assert.match((await status('unlock', 'verify', 'ZED-1')).stdout, /verify is not held/);

    const lock = path.join(evidence, '.locks', 'verify.lock');
    fs.writeFileSync(lock, JSON.stringify({ owner: 'ZED-3', pid: null, at: new Date(Date.now() - 31 * 60000).toISOString() }));
    r = await status('lock', 'verify', 'ZED-4');
    assert.match(r.stdout, /broke stale verify lock held by ZED-3/);
    assert.match(r.stdout, /acquired verify for ZED-4/);
    fs.writeFileSync(lock, JSON.stringify({ owner: 'ZED-5', pid: 999999, at: new Date().toISOString() }));
    r = await status('lock', 'verify', 'ZED-6');
    assert.match(r.stdout, /broke stale verify lock held by ZED-5/);
    fs.writeFileSync(lock, JSON.stringify({ owner: 'ZED-7', pid: process.pid, at: new Date().toISOString() }));
    r = await status('lock', 'verify', 'ZED-8', '--wait', '1');
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).owner, 'ZED-7');
    assert.ok(!fs.existsSync(path.join(evidence, '.locks', 'status.json')));
    assert.match((await status('lock', 'Verify!', 'ZED-1')).stdout, /usage/);
  } finally {
    rmrf(base);
  }
});

test('render writes the generated board and engine=sous keeps it current', async () => {
  const { base, evidence, status, ledger } = scratch('sous-render');
  try {
    await status('init', 'ZED-405', 'Invented', '-', '-', '-', '-');
    let r = await status('render', 'ZED-405');
    const board = path.join(evidence, 'blackboard', 'ZED-405');
    assert.match(r.stdout, /rendered .*blackboard\/ZED-405/);
    assert.equal(ledger('ZED-405').blackboard, board.replace(/\\/g, '/'));
    for (const f of ['status.md', 'decisions.md', 'issues.md', 'NOW.md']) assert.match(fs.readFileSync(path.join(board, f), 'utf8'), /^<!-- generated, do not edit/);
    await status('set', 'ZED-405', 'engine=sous', 'stage=code');
    await status('issue', 'ZED-405', 'RISK', 'shared', 'helper');
    await status('decide', 'ZED-405', 'keep', 'the', 'helper', '--status', 'GUESS', '--by', 'sous', '--issue', '1');
    await status('decide', 'ZED-405', 'old', 'idea', '--status', 'USULAN');
    await status('decide', 'ZED-405', 'new', 'idea', '--replaces', '2');
    const now = fs.readFileSync(path.join(board, 'NOW.md'), 'utf8');
    assert.match(now, /\| Stage \| code \|/);
    assert.match(now, /\| Engine \| sous \|/);
    assert.match(now, /- I-1 RISK \(level arbiter\): shared helper/);
    assert.match(now, /- D-1 GUESS: keep the helper/);
    assert.match(now, /- D-3 DECIDED: new idea/);
    assert.doesNotMatch(now, /D-2/);
    assert.match(fs.readFileSync(path.join(board, 'decisions.md'), 'utf8'), /## D-2\n- \*\*Status:\*\* SUPERSEDED[^\n]*\n- \*\*Decision:\*\* old idea\n- \*\*Superseded by:\*\* D-3/);
    assert.match(fs.readFileSync(path.join(board, 'issues.md'), 'utf8'), /### I-1 - RISK · level arbiter/);
    const log = fs.readFileSync(path.join(board, 'status.md'), 'utf8');
    for (const m of ['STAGE · gate -> code', 'ISSUE-OPEN · I-1 RISK', 'DECISION · D-1 GUESS by sous', 'DECISION · D-3 DECIDED by owner: new idea']) assert.ok(log.includes(m), m);
  } finally {
    rmrf(base);
  }
});

test('board=<EPIC> moves a ticket board under the epic, renders tickets/<KEY> and EPIC.md, and board= brings it back', async () => {
  const { base, evidence, status, ledger } = scratch('sous-epic');
  try {
    const bb = path.join(evidence, 'blackboard');
    const fwd = (p) => p.replace(/\\/g, '/');
    await status('init', 'ZED-410', 'First child', '-', '-', '-', '-');
    await status('set', 'ZED-410', 'engine=sous');
    let s = ledger('ZED-410');
    assert.equal(s.blackboard, fwd(path.join(bb, 'ZED-410')), 'default path unchanged');
    assert.equal(s.epicBoard, undefined);
    assert.equal(s.board, undefined);
    fs.writeFileSync(path.join(bb, 'ZED-410', 'ac.txt'), 'one\n');
    fs.mkdirSync(path.join(bb, 'ZED-410', 'materials'));
    fs.writeFileSync(path.join(bb, 'ZED-410', 'materials', 'jira.md'), 'x\n');

    assert.equal((await status('set', 'ZED-410', 'board=epic')).code, 2);
    let r = await status('set', 'ZED-410', 'board=ZED-400');
    assert.match(r.stdout, /moved .*ZED-410 to .*ZED-400\/tickets\/ZED-410/);
    const own = path.join(bb, 'ZED-400', 'tickets', 'ZED-410');
    s = ledger('ZED-410');
    assert.deepEqual([s.board, s.blackboard, s.epicBoard], ['ZED-400', fwd(own), fwd(path.join(bb, 'ZED-400'))]);
    assert.ok(!fs.existsSync(path.join(bb, 'ZED-410')));
    assert.equal(fs.readFileSync(path.join(own, 'ac.txt'), 'utf8'), 'one\n');
    assert.ok(fs.existsSync(path.join(own, 'materials', 'jira.md')));
    for (const f of ['status.md', 'decisions.md', 'issues.md', 'NOW.md']) assert.match(fs.readFileSync(path.join(own, f), 'utf8'), /^<!-- generated, do not edit/, f);
    for (const f of ['status.md', 'decisions.md', 'issues.md', 'NOW.md']) assert.ok(!fs.existsSync(path.join(bb, 'ZED-400', f)), `no ${f} at the epic root`);
    assert.match(fs.readFileSync(path.join(own, 'NOW.md'), 'utf8'), /ZED-400\/prompts\/S<n>\.md/);

    await status('init', 'ZED-411', 'Second child', '-', '-', '-', '-');
    await status('set', 'ZED-411', 'board=ZED-400', 'engine=sous', 'stage=plan');
    fs.mkdirSync(path.join(bb, 'ZED-400', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(bb, 'ZED-400', 'prompts', 'S1.md'), '# Prompt S1 - ZED-410 "First child"\n');
    fs.writeFileSync(path.join(bb, 'ZED-400', 'prompts', 'S2.md'), '# Prompt S2 - ZED-411 "Second child"\n');
    await status('render', 'ZED-411');
    const epic = fs.readFileSync(path.join(bb, 'ZED-400', 'EPIC.md'), 'utf8');
    assert.match(epic, /^<!-- generated, do not edit/);
    assert.match(epic, /\| ZED-410 \| First child \| S1 \| gate \|/);
    assert.match(epic, /\| ZED-411 \| Second child \| S2 \| plan \|/);
    assert.ok(fs.existsSync(path.join(bb, 'ZED-400', 'tickets', 'ZED-411', 'NOW.md')));

    r = await status('set', 'ZED-410', 'board=');
    assert.match(r.stdout, /moved .*tickets\/ZED-410 to .*blackboard\/ZED-410/);
    s = ledger('ZED-410');
    assert.deepEqual([s.board, s.epicBoard, s.blackboard], [undefined, undefined, fwd(path.join(bb, 'ZED-410'))]);
    assert.ok(fs.existsSync(path.join(bb, 'ZED-410', 'ac.txt')));

    fs.mkdirSync(path.join(bb, 'ZED-410', 'prompts'));
    fs.writeFileSync(path.join(bb, 'ZED-410', 'prompts', 'S1.md'), 'x\n');
    r = await status('set', 'ZED-410', 'board=ZED-400');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /already has prompts/);
    assert.equal(ledger('ZED-410').board, undefined);
  } finally {
    rmrf(base);
  }
});

test('set validates kind, engine, booleans; CARD keys are normalised; sync and verdict carry what DOCK needs', async () => {
  const { base, status, ledger } = scratch('sous-set');
  try {
    let r = await status('init', 'card-Fix-Login', 'A card', '-', '-', '-', '-');
    assert.match(r.stdout, /init CARD-fix-login/);
    assert.equal(ledger('CARD-fix-login').kind, 'card');
    assert.equal((await status('init', 'CARD-bad_slug', 'x', '-', '-', '-', '-')).code, 2);
    assert.equal((await status('init', `CARD-${'a'.repeat(65)}`, 'x', '-', '-', '-', '-')).code, 2);
    assert.match((await status('set', 'CARD-fix-login', 'kind=review')).stdout, /is a card/);
    await status('init', 'ZED-406', 'Invented', '-', '-', '-', '-');
    assert.match((await status('set', 'ZED-406', 'kind=card')).stdout, /needs a CARD-<slug> key/);
    assert.equal((await status('set', 'ZED-406', 'kind=epic')).code, 2);
    assert.equal((await status('set', 'ZED-406', 'engine=omc')).code, 2);
    assert.equal((await status('set', 'ZED-406', 'draft=yes')).code, 2);
    await status('set', 'ZED-406', 'kind=review', 'engine=sous', 'productionData=true');
    let s = ledger('ZED-406');
    assert.deepEqual([s.kind, s.engine, s.productionData, s.draft], ['review', 'sous', true, true]);
    await status('set', 'ZED-406', 'draft=false', 'engine=');
    s = ledger('ZED-406');
    assert.deepEqual([s.draft, s.engine], [false, undefined]);

    await status('set', 'ZED-406', 'pr.fe=https://github.com/o/fe/pull/7');
    await status('verdict', 'ZED-406', 'approve');
    assert.deepEqual(ledger('ZED-406').verdict.prs, ['https://github.com/o/fe/pull/7']);
    assert.equal(ledger('ZED-406').verdict.ticket, 'ZED-406');
    await status('verdict', 'ZED-406', 'request-change', '--ticket', 'ZED-500', '--pr', 'https://github.com/o/be/pull/1', '--pr', 'https://github.com/o/fe/pull/2');
    const v = ledger('ZED-406').verdict;
    assert.deepEqual([v.value, v.ticket, v.prs], ['request-change', 'ZED-500', ['https://github.com/o/be/pull/1', 'https://github.com/o/fe/pull/2']]);
  } finally {
    rmrf(base);
  }
});
