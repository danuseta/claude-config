'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'qa-predict.mjs');
const SPRINT26 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-predict-sprint26.json'), 'utf8'));
const CODES = { dependency: 'DEPENDENSI', access: 'PIHAK_KETIGA' };

const asInput = (cases) => ({ tickets: cases.map(({ key, summary, ac, waitsOn, endDay }) => ({ key, summary, ac, waitsOn, endDay })) });
const load = () => import(pathToFileURL(SCRIPT).href);
const cli = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });

test('Sprint 26: the CLI predicts what the QA bot really did, except the cases v2 no longer decides from AC text', () => {
  const r = cli(JSON.stringify(asInput(SPRINT26.cases)));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.results.length, SPRINT26.cases.length);
  for (const c of SPRINT26.cases) {
    const got = out.results.find((x) => x.key === c.key);
    if (c.predictable) {
      assert.equal(got.prediction, c.real.outcome, `${c.key}: ${got.reasons.join(' | ')}`);
    } else {
      assert.equal(got.prediction, 'LOLOS', `${c.key}: ${c.note}`);
      assert.notEqual(got.prediction, c.real.outcome);
    }
    if (c.causeMatches) assert.ok(got.reasons.some((s) => s.includes(`[${CODES[c.real.blockedReason]}]`)), `${c.key}: no [${CODES[c.real.blockedReason]}] reason in ${got.reasons.join(' | ')}`);
  }
});

test('Sprint 26: the AC lines each case escalates on, and the data and second-account lines only warn', async () => {
  const { predict } = await load();
  const byKey = Object.fromEntries(predict(asInput(SPRINT26.cases)).results.map((r) => [r.key, r]));
  const tags = (key, code) => byKey[key].reasons.filter((s) => s.includes(`[${code}]`)).map((s) => s.split(' ')[0]);
  assert.deepEqual(tags('QRD-1510', 'DEPENDENSI'), ['AC-3', 'AC-4']);
  assert.deepEqual(tags('QRD-1506', 'DEPENDENSI'), ['AC-1', 'AC-5', 'AC-9']);
  assert.deepEqual(tags('QRD-1289', 'DEPENDENSI'), ['AC-1']);
  assert.equal(byKey['QRD-1488'].fix, null);
  assert.match(byKey['QRD-1510'].fix, /move AC-3 to the ticket that builds it \(QRD-1312, QRD-1500\)/);
  assert.deepEqual(byKey['QRD-1498'].reasons.filter((s) => s.includes('[DATA_PRASYARAT warning]')).map((s) => s.split(' ')[0]), ['AC-8']);
  assert.equal(byKey['QRD-1498'].prediction, 'ESCALATED');
  assert.deepEqual(tags('QRD-1498', 'DEPENDENSI'), ['AC-16']);
  assert.ok(byKey['QRD-1286'].reasons.every((s) => s.includes('[AKUN_KEDUA warning]')));
  assert.equal(byKey['QRD-1286'].prediction, 'LOLOS');
});

test('every reason cites the v2 triage rule it comes from and starts its cause with a v2 code or warning', async () => {
  const { predict } = await load();
  for (const r of predict(asInput(SPRINT26.cases)).results) {
    for (const s of r.reasons) {
      assert.match(s, /(triage-rules|judge)\.md "/, `${r.key}: ${s}`);
      assert.match(s, /\[(DEPENDENSI|PIHAK_KETIGA|LAINNYA|(DATA_PRASYARAT|AKUN_KEDUA|BE_ONLY) warning)\]/, `${r.key}: ${s}`);
    }
  }
});

test('no AC or a placeholder AC is ESCALATED LAINNYA; an all-system ticket is not decided from AC text', async () => {
  const { predict } = await load();
  const one = (ticket) => predict({ tickets: [ticket] }).results[0];
  assert.equal(one({ key: 'T-1', ac: [] }).prediction, 'ESCALATED');
  assert.equal(one({ key: 'T-1' }).prediction, 'ESCALATED');
  const placeholder = one({ key: 'T-1', ac: ['FE', 'TBD'] });
  assert.match(placeholder.reasons[0], /^\[LAINNYA\] No AC.*Mencari AC/);
  const be = one({ key: 'T-1', ac: ['BE', 'The endpoint answers 403 without the rule', 'A migration backfills the field'] });
  assert.equal(be.prediction, 'LOLOS');
  assert.match(be.reasons[0], /^\[BE_ONLY warning\].*Tiket BE only/);
});

test('a dependency counts only when the other ticket lands after this one', async () => {
  const { predict } = await load();
  const one = (ticket, others = []) => predict({ tickets: [ticket, ...others] }).results[0];
  const ac = ['FE', 'The drawer (QRD-2) shows the switch'];
  assert.equal(one({ key: 'T-1', ac, endDay: 3, waitsOn: [{ key: 'QRD-2', endDay: 4 }] }).prediction, 'ESCALATED');
  assert.equal(one({ key: 'T-1', ac, endDay: 3, waitsOn: [{ key: 'QRD-2', endDay: 3 }] }).prediction, 'LOLOS');
  assert.equal(one({ key: 'T-1', ac, endDay: 3 }, [{ key: 'QRD-2', ac: ['FE', 'x shows'], endDay: 5 }]).prediction, 'ESCALATED');
  const deferred = ['FE', 'The header shows the count. The figure is built in QRD-2 and is not checked here'];
  assert.equal(one({ key: 'T-1', ac: deferred, endDay: 3, waitsOn: [{ key: 'QRD-2', endDay: 9 }] }).prediction, 'LOLOS');
  const w = one({ key: 'T-1', ac: ['FE', 'The list shows the rows'], endDay: 3, waitsOn: [{ key: 'QRD-9', endDay: 6 }] });
  assert.equal(w.prediction, 'ESCALATED');
  assert.match(w.reasons[0], /^\[DEPENDENSI\] Waits on QRD-9 \(day 6\)/);
  assert.equal(one({ key: 'T-1', ac: ['FE', 'The list shows the rows', 'BE', 'The endpoint (QRD-2) answers 403'], endDay: 3, waitsOn: [{ key: 'QRD-2', endDay: 4 }] }).prediction, 'LOLOS');
});

test('third party, payment and plan lines escalate with their code; data and second account only warn; vague and placeholder lines are ESCALATED LAINNYA', async () => {
  const { predict } = await load();
  const one = (ac) => predict({ tickets: [{ key: 'T-1', ac: ['FE', ...ac] }] }).results[0];
  const ig = one(['Connect Instagram through Facebook Login and see the account listed']);
  assert.equal(ig.prediction, 'ESCALATED');
  assert.match(ig.reasons[0], /\[PIHAK_KETIGA\].*Selalu eskalasi/);
  assert.match(one(['The user enters the OTP from the SMS']).reasons[0], /\[PIHAK_KETIGA\]/);
  const pay = one(['The invoice is charged to the card']);
  assert.equal(pay.prediction, 'ESCALATED');
  assert.match(pay.reasons[0], /\[LAINNYA\]/);
  const other = one(['Another user sees the edit without a reload']);
  assert.equal(other.prediction, 'LOLOS');
  assert.match(other.reasons[0], /\[AKUN_KEDUA warning\]/);
  const data = one(['A row saved on develop shows its name']);
  assert.equal(data.prediction, 'LOLOS');
  assert.match(data.reasons[0], /\[DATA_PRASYARAT warning\]/);
  assert.equal(data.fix, null);
  const vague = one(['Phone number display works correctly.', 'The button reads "Save"']);
  assert.equal(vague.prediction, 'ESCALATED');
  assert.match(vague.reasons[0], /^AC-1 \[LAINNYA\] not verifiable as written/);
  assert.match(vague.fix, /rewrite AC-1 as an observable result/);
  for (const phrase of ['works properly', 'as expected', 'user-friendly', 'sesuai', 'dengan baik', 'berjalan normal', 'optimal', 'seamless', 'intuitive']) {
    assert.equal(one([`The header is ${phrase}`]).prediction, 'ESCALATED', phrase);
  }
  assert.equal(one(['The list splits the rows correctly into two groups']).prediction, 'LOLOS', 'standalone correctly is not vague');
  assert.equal(one(['The form saves properly']).prediction, 'LOLOS', 'standalone properly is not vague');
  assert.equal(one(['The form work properly']).prediction, 'ESCALATED');
  const placeholder = one(['The button reads "Save"', 'TBD for group chats'.slice(0, 3), '-']);
  assert.equal(placeholder.prediction, 'ESCALATED');
  assert.deepEqual(placeholder.reasons.map((r) => r.split(' ')[0]), ['AC-2', 'AC-3']);
  assert.match(placeholder.reasons[0], /\[LAINNYA\] placeholder line "TBD"/);
  assert.match(placeholder.fix, /write AC-2 as an observable result, or remove it/);
  assert.equal(one(['The button reads "Save"', '']).prediction, 'ESCALATED');
  assert.deepEqual(one(['The button reads "Save" and saves the row']), { key: 'T-1', prediction: 'LOLOS', reasons: [], fix: null });
});

test('the CLI rejects bad input with exit 2 and the script imports nothing beyond node:fs and node:url', () => {
  for (const bad of ['{}', 'not json', JSON.stringify({ tickets: [{ key: 'A' }, { key: 'A' }] }), JSON.stringify({ tickets: [{ key: 'A', waitsOn: [{ key: 'B' }] }] })]) {
    const r = cli(bad);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /^predict: /);
  }
  const imports = fs.readFileSync(SCRIPT, 'utf8').match(/^import .* from "([^"]+)";$/gm);
  assert.deepEqual(imports.map((l) => l.match(/"([^"]+)"/)[1]).sort(), ['node:fs', 'node:url']);
});

test('REVISION-RISK is never produced', async () => {
  const { predict } = await load();
  const all = predict(asInput(SPRINT26.cases)).results.concat(predict({ tickets: [{ key: 'T-1', ac: ['FE', 'The page works correctly', 'TBD'] }] }).results);
  assert.ok(all.every((r) => ['LOLOS', 'ESCALATED'].includes(r.prediction)));
});
