'use strict';
// kit/sprint-draft.cjs: the Planning chat reads and writes DOCK's sprint draft through fixed ingest routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, run } = require('../sprint-draft.cjs');

const files = (map) => (f) => { if (!(f in map)) throw new Error('ENOENT'); return map[f]; };
const recorder = (answer = { status: 200, result: { ok: true } }) => {
  const seen = [];
  const send = async (route, body, timeoutMs) => { seen.push({ route, body, timeoutMs }); return typeof answer === 'function' ? answer(route, body) : answer; };
  return { seen, send };
};
const quiet = () => { const lines = { out: [], err: [] }; return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) }; };

test('each command goes to its route with the contract body', async () => {
  const { seen, send } = recorder();
  const io = quiet();
  const readFile = files({
    'ac.txt': '﻿User can create a folder\r\n\r\nUser can rename a folder (after QRD-1400)\n',
    'tc.json': JSON.stringify([{ id: 'TC-1', ac: 1, title: 'Folder: create, shown in list', steps: ['Given: user logged in', "Klik 'New folder'"], expected: 'Folder appears', extra: 'dropped' }]),
  });
  for (const argv of [
    ['get', '27'],
    ['update', '27', 'qrd-1501', '--dev', 'Danu', '--wave', '2', '--sp', '3', '--ac-file', 'ac.txt'],
    ['tc', '27', 'QRD-1501', 'tc.json'],
    ['question', '27', 'Frame F2.3 has no ticket', 'QRD-1501'],
    ['question', '27', 'Who owns export?'],
    ['storyboard', 'qrd-1400'],
  ]) assert.equal(await run(argv, { send, readFile, ...io }), 0, argv.join(' '));
  assert.deepEqual(seen.map((s) => [s.route, s.body]), [
    ['/sprint-draft/get', { sprint: '27' }],
    ['/sprint-draft/update', { sprint: '27', key: 'QRD-1501', dev: 'Danu', wave: 2, sp: 3, ac: ['User can create a folder', 'User can rename a folder (after QRD-1400)'] }],
    ['/sprint-draft/tc', { sprint: '27', key: 'QRD-1501', tcs: [{ id: 'TC-1', ac: 1, title: 'Folder: create, shown in list', steps: ['Given: user logged in', "Klik 'New folder'"], expected: 'Folder appears' }] }],
    ['/sprint-draft/question', { sprint: '27', text: 'Frame F2.3 has no ticket', key: 'QRD-1501' }],
    ['/sprint-draft/question', { sprint: '27', text: 'Who owns export?' }],
    ['/storyboard', { epic: 'QRD-1400' }],
  ]);
  assert.equal(JSON.parse(io.lines.out[0]).ok, true, 'the result is printed as JSON');
  assert.ok(seen[5].timeoutMs > seen[0].timeoutMs, 'the storyboard fetch gets longer');
});

test('summary posts the Intinya body to sprint-draft/summary', async () => {
  const { seen, send } = recorder();
  const io = quiet();
  const readFile = files({ 's.json': JSON.stringify({ acHash: 'h1', made: 'm', checked: 'c', notHere: 'n', waitsOn: ['qrd-1307'], before: 'b', after: 'a', line: 'l', testData: null, ui: true, acId: ['satu'], titleId: 'judul', extra: 'dropped' }) });
  assert.equal(await run(['summary', '27', 'qrd-1510', 's.json'], { send, readFile, ...io }), 0);
  assert.deepEqual(seen.map((s) => [s.route, s.body]), [
    ['/sprint-draft/summary', { sprint: '27', key: 'QRD-1510', acHash: 'h1', made: 'm', checked: 'c', notHere: 'n', waitsOn: ['QRD-1307'], before: 'b', after: 'a', line: 'l', testData: null, ui: true, acId: ['satu'], titleId: 'judul' }],
  ]);
  const bare = request(['summary', '27', 'QRD-1510', 'b.json'], files({ 'b.json': JSON.stringify({ acHash: 'h', made: 'm', checked: 'c', before: 'b', after: 'a', line: 'l' }) }));
  assert.deepEqual(bare.body, { sprint: '27', key: 'QRD-1510', acHash: 'h', made: 'm', checked: 'c', notHere: '', waitsOn: [], before: 'b', after: 'a', line: 'l', testData: null, ui: false, acId: [], titleId: null });
});

test('a summary that does not fit the contract is refused locally', () => {
  const base = { acHash: 'h', made: 'm', checked: 'c', before: 'b', after: 'a', line: 'l' };
  const cases = [
    [{ ...base, acHash: '' }, /acHash must be a non-empty string/],
    [{ ...base, waitsOn: ['soon'] }, /soon is not a ticket key/],
    [{ ...base, ui: 'yes' }, /ui must be true or false/],
    [{ ...base, acId: 'one' }, /acId must be an array of strings/],
    [{ ...base, testData: 3 }, /testData must be a string or null/],
    [{ ...base, key: 'QRD-9' }, /summary of QRD-9, not QRD-1/],
  ];
  for (const [s, want] of cases) assert.match(request(['summary', '27', 'QRD-1', 's.json'], files({ 's.json': JSON.stringify(s) })).error, want);
  assert.match(request(['summary', '27', 'QRD-1']).error, /needs the JSON file/);
});

test('an AC file can be a JSON array', () => {
  const r = request(['update', '27', 'QRD-1', '--ac-file', 'a.json'], files({ 'a.json': '["one", " two "]' }));
  assert.deepEqual(r.body.ac, ['one', 'two']);
});

test('bad input is refused locally with exit 1 and DOCK is not asked', async () => {
  const never = async () => { throw new Error('should not ask DOCK'); };
  const bad = files({ 'tc.json': JSON.stringify([{ id: 'T1', ac: 1, title: 't', steps: ['s'], expected: 'e' }]), 'dup.json': JSON.stringify({ tcs: [{ id: 'TC-1', ac: 1, title: 't', steps: ['s'], expected: 'e' }, { id: 'TC-1', ac: 2, title: 't', steps: ['s'], expected: 'e' }] }), 'empty.txt': '\n\n' });
  const cases = {
    'update 27 QRD-1': /at least one of/,
    'update 27 QRD-1 --wave two': /--wave must be a whole number/,
    'update 27 QRD-1 --ac-file empty.txt': /holds no AC line/,
    'update 27 nokey --sp 2': /needs a ticket key/,
    'tc 27 QRD-1 tc.json': /id must look like TC-1/,
    'tc 27 QRD-1 dup.json': /TC-1 appears twice/,
    'tc 27 QRD-1 missing.json': /cannot read missing\.json/,
    'question 27': /needs its text/,
    'storyboard epic': /needs the epic key/,
    'get': /needs the sprint/,
    'publish 27': /unknown command publish/,
  };
  for (const [line, want] of Object.entries(cases)) {
    const io = quiet();
    assert.equal(await run(line.split(' '), { send: never, readFile: bad, ...io }), 1, line);
    assert.match(io.lines.err.join('\n'), want, line);
  }
});

test('DOCK refusing is exit 3; DOCK down or not configured is exit 1', async () => {
  let io = quiet();
  assert.equal(await run(['get', '27'], { send: async () => ({ status: 404, error: 'no draft for sprint 27' }), ...io }), 3);
  assert.match(io.lines.err[0], /DOCK refused \(404\): no draft for sprint 27/);
  io = quiet();
  assert.equal(await run(['get', '27'], { send: async () => ({ status: 502, error: 'bad gateway' }), ...io }), 1);
  assert.match(io.lines.err[0], /DOCK answered 502 bad gateway/);
  io = quiet();
  assert.equal(await run(['get', '27'], { send: async () => ({ skipped: true }), ...io }), 1);
  assert.match(io.lines.err[0], /not configured/);
});

test('visual put and rm go to sprint-draft/visual with the contract body', async () => {
  const { seen, send } = recorder({ status: 200, result: { id: 'load-chart' } });
  const io = quiet();
  const readFile = files({ 'p.html': '<html><body>hi</body></html>' });
  assert.equal(await run(['visual', 'put', '27', '--title', 'Load per dev', '--file', 'p.html', '--id', 'load-chart'], { send, readFile, ...io }), 0);
  assert.equal(await run(['visual', 'put', '27', '--title', 'No id', '--file', 'p.html'], { send, readFile, ...io }), 0);
  assert.equal(await run(['visual', 'rm', '27', '--id', 'load-chart'], { send, readFile, ...io }), 0);
  assert.deepEqual(seen.map((s) => [s.route, s.body]), [
    ['/sprint-draft/visual', { sprint: '27', action: 'put', id: 'load-chart', title: 'Load per dev', html: '<html><body>hi</body></html>' }],
    ['/sprint-draft/visual', { sprint: '27', action: 'put', title: 'No id', html: '<html><body>hi</body></html>' }],
    ['/sprint-draft/visual', { sprint: '27', action: 'rm', id: 'load-chart' }],
  ]);
  assert.equal(io.lines.out[0].split(/\r?\n/)[0], 'load-chart', 'put prints the returned id first');
});

test('bad visual input is refused locally', () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const readFile = files({ 'p.html': '<p>ok</p>', 'p.txt': '<p>ok</p>', 'big.html': big });
  const cases = {
    'visual': /needs put or rm/,
    'visual drop 27': /unknown visual action drop/,
    'visual put': /needs the sprint/,
    'visual put 27 --file p.html': /--title must be 1-60/,
    'visual put 27 --title x': /needs --file/,
    'visual put 27 --title x --file p.txt': /must be an \.html file/,
    'visual put 27 --title x --file missing.html': /cannot read missing\.html/,
    'visual put 27 --title x --file big.html': /over 2 MB/,
    'visual put 27 --title x --file p.html --id Bad_Id': /--id must be/,
    'visual put 27 --title x --file p.html --id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': /--id must be/,
    'visual rm 27': /needs --id/,
    'visual rm 27 --id a --title t': /takes only --id/,
    'visual put 27 --bogus 1': /unknown option --bogus/,
  };
  for (const [line, want] of Object.entries(cases)) assert.match(request(line.split(' '), readFile).error, want, line);
  assert.match(request(['visual', 'put', '27', '--title', 'x'.repeat(61), '--file', 'p.html'], readFile).error, /--title must be 1-60/);
});

const { parseCsv, sheetCsvUrl } = require('../sprint-draft.cjs');
const goodTicket = { summary: '[BE][Workflow] Add export', type: 'Task', epic: 'qrd-1400', dev: 'Danu', sp: 3, priority: 'High', userStory: 'As a user I want x so that y', problem: 'p', ac: ['one', 'two'], reference: 'https://discord.com/x', source: 'sheet row 2', extra: 'dropped' };

test('new posts the ticket to sprint-draft/new and prints the id; rm removes it', async () => {
  const { seen, send } = recorder({ status: 200, result: { id: 'NEW-1', ticket: { summary: 's' } } });
  const io = quiet();
  const readFile = files({ 't.json': JSON.stringify(goodTicket) });
  assert.equal(await run(['new', '27', '--file', 't.json'], { send, readFile, ...io }), 0);
  assert.equal(await run(['new', '27', '--file', 't.json', '--id', 'new-1'], { send, readFile, ...io }), 0);
  assert.equal(await run(['new', 'rm', '27', '--id', 'NEW-1'], { send, readFile, ...io }), 0);
  const { extra, ...ticket } = { ...goodTicket, epic: 'QRD-1400' };
  assert.deepEqual(seen.map((s) => [s.route, s.body]), [
    ['/sprint-draft/new', { sprint: '27', ticket }],
    ['/sprint-draft/new', { sprint: '27', id: 'NEW-1', ticket }],
    ['/sprint-draft/new', { sprint: '27', id: 'NEW-1', remove: true }],
  ]);
  assert.equal(io.lines.out[0].split(/\r?\n/)[0], 'NEW-1');
  assert.equal(io.lines.out[2].startsWith('NEW-1'), false, 'rm prints plain JSON');
});

test('a new ticket that breaks a limit is refused locally', () => {
  const cases = [
    [{ ...goodTicket, summary: '' }, /summary must be 1-200/],
    [{ ...goodTicket, summary: 'x'.repeat(201) }, /summary must be 1-200/],
    [{ ...goodTicket, userStory: 'x'.repeat(4001) }, /userStory is over 4000/],
    [{ ...goodTicket, problem: 'x'.repeat(4001) }, /problem is over 4000/],
    [{ ...goodTicket, reference: 'x'.repeat(2001) }, /reference is over 2000/],
    [{ ...goodTicket, ac: Array(41).fill('a') }, /more than 40 lines/],
    [{ ...goodTicket, ac: ['x'.repeat(1001)] }, /over 1000 characters/],
    [{ ...goodTicket, ac: 'one' }, /ac must be an array/],
    [{ ...goodTicket, sp: 101 }, /sp must be a number from 0 to 100/],
    [{ ...goodTicket, sp: -1 }, /sp must be a number from 0 to 100/],
    [{ ...goodTicket, type: 'Epic' }, /type must be Task, Story or Bug/],
    [{ ...goodTicket, priority: 'Urgent' }, /priority must be/],
    [{ ...goodTicket, epic: 'folder' }, /epic must be an existing epic key/],
  ];
  for (const [t, want] of cases) assert.match(request(['new', '27', '--file', 't.json'], files({ 't.json': JSON.stringify(t) })).error, want);
  const edge = { ...goodTicket, summary: 'x'.repeat(200), userStory: 'x'.repeat(4000), reference: 'x'.repeat(2000), ac: Array(40).fill('x'.repeat(1000)), sp: 100 };
  assert.equal(request(['new', '27', '--file', 't.json'], files({ 't.json': JSON.stringify(edge) })).error, undefined);
  const usage = {
    'new': /needs the sprint/, 'new 27': /needs --file/, 'new 27 --file missing.json': /cannot read missing\.json/,
    'new 27 --file t.json --id 7': /--id must look like NEW-1/, 'new rm': /needs the sprint/, 'new rm 27': /needs --id/,
    'new rm 27 --id NEW-1 --file t.json': /takes only --id/, 'new 27 --bogus 1': /unknown option --bogus/,
  };
  for (const [line, want] of Object.entries(usage)) assert.match(request(line.split(' '), files({ 't.json': '{}' })).error, want, line);
});

test('parseCsv handles quotes, doubled quotes, newlines in quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",\r\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', '']]);
  assert.deepEqual(parseCsv('﻿a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']]);
});

test('sheetCsvUrl builds the export url and keeps the gid', () => {
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/AbC-1_2/edit?usp=sharing'), 'https://docs.google.com/spreadsheets/d/AbC-1_2/export?format=csv');
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/AbC-1_2/edit#gid=456'), 'https://docs.google.com/spreadsheets/d/AbC-1_2/export?format=csv&gid=456');
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/AbC-1_2/edit?gid=9#gid=9'), 'https://docs.google.com/spreadsheets/d/AbC-1_2/export?format=csv&gid=9');
  assert.equal(sheetCsvUrl('https://example.com/spreadsheets/d/x'), null);
  assert.equal(sheetCsvUrl('nope'), null);
});

const reply = (body, type = 'text/csv; charset=utf-8', status = 200) => async () => ({ ok: status < 400, status, headers: { get: () => type }, text: async () => body });

test('sheet prints rows without a Jira Ticket, row numbers counted from the header', async () => {
  const csv = 'Title,Jira Ticket,Notes\r\nFirst,,"multi\nline"\r\nDone,QRD-9,x\r\n,,\r\nSecond, ,"a ""q"""\r\n';
  const io = quiet();
  let asked;
  const fetch = async (url, opts) => { asked = [url, opts]; return reply(csv)(); };
  assert.equal(await run(['sheet', 'https://docs.google.com/spreadsheets/d/ID1/edit#gid=5'], { fetch, ...io }), 0);
  assert.deepEqual(asked, ['https://docs.google.com/spreadsheets/d/ID1/export?format=csv&gid=5', { redirect: 'follow' }]);
  assert.deepEqual(JSON.parse(io.lines.out[0]), [
    { row: 2, cells: { Title: 'First', 'Jira Ticket': '', Notes: 'multi\nline' } },
    { row: 5, cells: { Title: 'Second', 'Jira Ticket': ' ', Notes: 'a "q"' } },
  ]);
});

test('sheet matches the Jira Ticket header case-insensitively and keeps all rows when absent', async () => {
  let io = quiet();
  await run(['sheet', 'https://docs.google.com/spreadsheets/d/ID1/edit'], { fetch: reply('a,JIRA TICKET\nx,QRD-1\ny,\n'), ...io });
  assert.deepEqual(JSON.parse(io.lines.out[0]).map((r) => r.row), [3]);
  io = quiet();
  await run(['sheet', 'https://docs.google.com/spreadsheets/d/ID1/edit'], { fetch: reply('a\nx\ny\n'), ...io });
  assert.deepEqual(JSON.parse(io.lines.out[0]).map((r) => r.row), [2, 3]);
});

test('sheet errors clearly on a login page, a bad status, a bad link or a failed fetch', async () => {
  const url = 'https://docs.google.com/spreadsheets/d/ID1/edit';
  let io = quiet();
  assert.equal(await run(['sheet', url], { fetch: reply('<!DOCTYPE html><html>Sign in</html>', 'text/html; charset=utf-8'), ...io }), 1);
  assert.match(io.lines.err[0], /not CSV.*anyone with the link/);
  io = quiet();
  assert.equal(await run(['sheet', url], { fetch: reply('<html>', 'text/plain'), ...io }), 1);
  assert.match(io.lines.err[0], /not CSV/);
  io = quiet();
  assert.equal(await run(['sheet', url], { fetch: reply('gone', 'text/plain', 404), ...io }), 1);
  assert.match(io.lines.err[0], /answered 404/);
  io = quiet();
  assert.equal(await run(['sheet', 'https://example.com/x'], { fetch: reply(''), ...io }), 1);
  assert.match(io.lines.err[0], /needs a Google Sheets link/);
  io = quiet();
  assert.equal(await run(['sheet', url], { fetch: async () => { throw new Error('ENOTFOUND'); }, ...io }), 1);
  assert.match(io.lines.err[0], /cannot fetch the sheet: ENOTFOUND/);
});

const goodRevision = { summary: ' [BE] Fix export ', type: 'Bug', userStory: 'As a user', problem: 'p', ac: ['one', 'two'], reference: 'Split from QRD-1', openToConfirm: 'who owns it?', note: 'AC was thin', source: 'chat' };

test('revise posts the allowed fields to sprint-draft/revise and prints before/after per field; rm discards', async () => {
  const answer = { key: 'QRD-1602', revision: { summary: 'Fix export', note: 'AC was thin', fields: [
    { name: 'summary', label: 'Summary', before: ['Export'], after: ['Fix export'] },
    { name: 'ac', label: 'Acceptance Criteria', before: [], after: ['one', 'two'] },
  ] } };
  const { seen, send } = recorder({ status: 200, result: answer });
  const io = quiet();
  const readFile = files({ 'r.json': JSON.stringify(goodRevision) });
  assert.equal(await run(['revise', '27', '--key', 'qrd-1602', '--file', 'r.json'], { send, readFile, ...io }), 0);
  assert.equal(await run(['revise', 'rm', '27', '--key', 'QRD-1602'], { send: recorder({ status: 200, result: { discarded: 'QRD-1602' } }).send, ...io }), 0);
  const revision = { ...goodRevision, summary: '[BE] Fix export' };
  assert.deepEqual(seen.map((s) => [s.route, s.body]), [['/sprint-draft/revise', { sprint: '27', key: 'QRD-1602', revision }]]);
  assert.equal(request(['revise', 'rm', '27', '--key', 'qrd-1602']).route, '/sprint-draft/revise');
  assert.deepEqual(request(['revise', 'rm', '27', '--key', 'qrd-1602']).body, { sprint: '27', key: 'QRD-1602', remove: true });
  const blocks = io.lines.out[0].split('\n\n');
  assert.equal(blocks[0], 'QRD-1602 Fix export');
  assert.equal(blocks[1], 'note: AC was thin');
  assert.equal(blocks[2], '## Summary (summary)\nbefore:\n  Export\nafter:\n  Fix export');
  assert.equal(blocks[3], '## Acceptance Criteria (ac)\nbefore:\n  (empty)\nafter:\n  one\n  two');
  assert.equal(JSON.parse(io.lines.out[1]).discarded, 'QRD-1602');
});

test('a revision that breaks a limit or names a forbidden field is refused locally', () => {
  const cases = [
    [{ ...goodRevision, summary: '' }, /summary must be 1-200/],
    [{ ...goodRevision, summary: 'x'.repeat(201) }, /summary must be 1-200/],
    [{ ...goodRevision, type: 'Epic' }, /type must be Task, Story or Bug/],
    [{ ...goodRevision, userStory: 'x'.repeat(4001) }, /userStory is over 4000/],
    [{ ...goodRevision, problem: 'x'.repeat(4001) }, /problem is over 4000/],
    [{ ...goodRevision, openToConfirm: 'x'.repeat(4001) }, /openToConfirm is over 4000/],
    [{ ...goodRevision, reference: 'x'.repeat(2001) }, /reference is over 2000/],
    [{ ...goodRevision, ac: Array(41).fill('a') }, /more than 40 lines/],
    [{ ...goodRevision, ac: ['x'.repeat(1001)] }, /over 1000 characters/],
    [{ ...goodRevision, ac: 'one' }, /ac must be an array/],
    [{ ...goodRevision, assignee: 'Danu' }, /assignee is not a field a revision may change/],
    [{ ...goodRevision, sprint: '28' }, /sprint is not a field/],
    [{ ...goodRevision, status: 'Done' }, /status is not a field/],
    [{ note: 'only a note' }, /changes no field/],
    [[], /not an object/],
  ];
  for (const [r, want] of cases) assert.match(request(['revise', '27', '--key', 'QRD-1', '--file', 'r.json'], files({ 'r.json': JSON.stringify(r) })).error, want);
  const edge = { summary: 'x'.repeat(200), userStory: 'x'.repeat(4000), reference: 'x'.repeat(2000), ac: Array(40).fill('x'.repeat(1000)) };
  assert.equal(request(['revise', '27', '--key', 'QRD-1', '--file', 'r.json'], files({ 'r.json': JSON.stringify(edge) })).error, undefined);
  const usage = {
    'revise': /needs the sprint/, 'revise 27': /needs --key/, 'revise 27 --key QRD-1': /needs --file/,
    'revise 27 --key 1602 --file r.json': /--key must look like QRD-1602/, 'revise 27 --key folder --file r.json': /--key must look like/,
    'revise 27 --key QRD-1 --file missing.json': /cannot read missing.json/, 'revise 27 --key QRD-1 --file r.json --bogus 1': /unknown option --bogus/,
    'revise rm': /needs the sprint/, 'revise rm 27': /needs --key/, 'revise rm 27 --key nokey': /--key must look like/,
    'revise rm 27 --key QRD-1 --file r.json': /takes only --key/,
  };
  for (const [line, want] of Object.entries(usage)) assert.match(request(line.split(' '), files({ 'r.json': '{}' })).error, want, line);
});

const failing = {
  type: 'Task',
  summary: 'Implement phone number display in inbox header using contact.phone from getConversation resolver and update ChatHeader component',
  userStory: '',
  problem: 'Per D-3 (GUESS) the header lacks phone; see ChatHeader.tsx:42. Agents need it.',
  ac: ['Phone number display works correctly.', 'Uses the field from QRD-1603.', 'TBD for group chats'],
  sp: 5,
};
const lintAnswer = {
  ok: false,
  findings: [
    { rule: 'W2', field: 'ac', line: 1, level: 'block', text: 'Vague phrase "works correctly": a tester cannot tell pass from fail.', fix: 'Write what the tester sees.' },
    { rule: 'W5', field: 'summary', line: null, level: 'warn', text: 'No [area] prefix and over 100 characters.', fix: 'Start with [FE][Inbox] and say what changes.' },
  ],
};

test('lint --file posts the text fields to ticket/lint and prints the findings; exit 4 while a block finding is left', async () => {
  const { seen, send } = recorder({ status: 200, result: lintAnswer });
  const io = quiet();
  const readFile = files({ 't.json': JSON.stringify({ ...failing, extra: 'dropped' }) });
  assert.equal(await run(['lint', '--file', 't.json'], { send, readFile, ...io }), 4);
  assert.equal(seen[0].route, '/ticket/lint');
  assert.deepEqual(seen[0].body, failing);
  assert.equal(JSON.parse(io.lines.out[0]).ok, false);
  assert.equal(io.lines.out[1], [
    'lint: 1 block, 1 warn',
    'block W2 ac line 1: Vague phrase "works correctly": a tester cannot tell pass from fail. Fix: Write what the tester sees.',
    'warn W5 summary: No [area] prefix and over 100 characters. Fix: Start with [FE][Inbox] and say what changes.',
  ].join('\n'));
  const clean = quiet();
  assert.equal(await run(['lint', '--file', 't.json'], { send: async () => ({ status: 200, result: { ok: true, findings: [] } }), readFile, ...clean }), 0);
  assert.equal(clean.lines.out[1], 'lint: ok, no finding');
  const warnOnly = quiet();
  assert.equal(await run(['lint', '--file', 't.json'], { send: async () => ({ status: 200, result: { ok: true, findings: [lintAnswer.findings[1]] } }), readFile, ...warnOnly }), 0);
});

test('lint refuses bad input locally and reports a DOCK refusal', async () => {
  const bad = {
    'lint': /needs --file/, 'lint --file': /needs --file/, 'lint --file a.json b.json': /needs --file/,
    'lint --file missing.json': /cannot read missing.json/,
  };
  for (const [line, want] of Object.entries(bad)) assert.match(request(line.split(' '), files({})).error, want, line);
  for (const [json, want] of [['[]', /not an object/], [JSON.stringify({ ac: 'one' }), /ac must be an array/], [JSON.stringify({ sp: '5' }), /sp must be a number/], [JSON.stringify({ summary: 3 }), /summary must be a string/]]) {
    assert.match(request(['lint', '--file', 'x.json'], files({ 'x.json': json })).error, want);
  }
  const io = quiet();
  assert.equal(await run(['lint', '--file', 'x.json'], { send: async () => ({ status: 400, error: 'bad body' }), readFile: files({ 'x.json': '{}' }), ...io }), 3);
  assert.match(io.lines.err[0], /DOCK refused \(400\): bad body/);
});

test('new and revise print the lint DOCK returned after the result, and stay exit 0', async () => {
  const draft = { summary: '[FE][Inbox] Show the phone number', ac: ['One'] };
  const io = quiet();
  const send = async () => ({ status: 200, result: { id: 'NEW-4', lint: lintAnswer } });
  assert.equal(await run(['new', '27', '--file', 'd.json'], { send, readFile: files({ 'd.json': JSON.stringify(draft) }), ...io }), 0);
  assert.equal(io.lines.out[0].split('\n')[0], 'NEW-4');
  assert.match(io.lines.out[1], /^lint: 1 block, 1 warn\nblock W2 ac line 1:/);
  const rev = quiet();
  const sendRev = async () => ({ status: 200, result: { key: 'QRD-5', revision: { summary: 'S', fields: [] }, lint: { ok: true, findings: [] } } });
  assert.equal(await run(['revise', '27', '--key', 'QRD-5', '--file', 'r.json'], { send: sendRev, readFile: files({ 'r.json': JSON.stringify({ summary: 'S' }) }), ...rev }), 0);
  assert.equal(rev.lines.out[1], 'lint: ok, no finding');
  const none = quiet();
  assert.equal(await run(['new', '27', '--file', 'd.json'], { send: async () => ({ status: 200, result: { id: 'NEW-5' } }), readFile: files({ 'd.json': JSON.stringify(draft) }), ...none }), 0);
  assert.equal(none.lines.out.length, 1);
  const rm = quiet();
  assert.equal(await run(['new', 'rm', '27', '--id', 'NEW-4'], { send: async () => ({ status: 200, result: { removed: 'NEW-4', lint: lintAnswer } }), ...rm }), 0);
  assert.equal(rm.lines.out.length, 1);
});
