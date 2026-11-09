'use strict';
// kit/sprint-draft.cjs: the Planning chat reads and writes DOCK's sprint draft through five fixed ingest routes.
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
