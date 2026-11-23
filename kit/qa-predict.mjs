#!/usr/bin/env node
// qa-predict.mjs: before a sprint starts, predict how the QA v2 bot will judge each ticket from its AC text alone,
// with the same triage rules the bot uses (triage-rules.md, judge.md of the v2 skill). It never opens UAT, never writes
// to Jira, and makes no network call. The sprint planner (DOCK) calls it; tests import predict().
// Installed as ~/.claude/kit/qa-predict.mjs. Derived from predict.mjs of qonflo-qa-agent PR #3, rules re-checked against v2.
//
// Usage:  node qa-predict.mjs < tickets.json
//
// stdin:  {"tickets":[{"key":"QRD-1","summary":"...","ac":["line",...],"waitsOn":[{"key":"QRD-2","endDay":4}],"endDay":3,
//           "links":[{"key":"QRD-3","type":"is tested by","summary":"[FE] ..."}]}]}
//   ac       the Acceptance Criteria bullets in order. A line that is only "FE" or "BE" (also "**BE**", "*BE*") is a
//            group header, not an AC line; lines after a "BE" header are system lines (see below).
//   waitsOn  tickets this one depends on, with the sprint day each lands in UAT. endDay is this ticket's day.
//            Every ticket in the same input also counts, by its own endDay.
//   links    optional Jira links of the ticket: type is the link as read from this ticket ("tests", "is tested by",
//            "blocks", "is blocked by", "relates to"); summary is the other ticket's, else its summary in the same input.
// stdout: {"results":[{"key":"QRD-1","prediction":"LOLOS"|"ESCALATED"|"FOLLOWS_FE","reasons":["..."],"fix":null|"...","followsFe":"QRD-3"}]}
//
// Each reason names the AC line (AC-n, numbered top to bottom across groups, as triage-rules.md "Mencari AC" does),
// a v2 reason code (scripts/reason-codes.mjs: DEPENDENSI, PIHAK_KETIGA, LAINNYA) or a warning, and the rule it comes from.
// A warning reason ("[DATA_PRASYARAT warning]", "[AKUN_KEDUA warning]", "[BE_ONLY warning]") never changes the prediction:
// v2 does not decide those from AC text (prerequisite data is tried through the UI first, a second account is read from
// accounts-check.mjs, an all-system ticket is explored in the UI or follows its FE ticket).
//
// Prediction, strongest first:
//   ESCALATED      no AC
//   FOLLOWS_FE     a [BE] ticket with an FE pair: a Test link ("tests" / "is tested by"), else another link to an [FE]
//                  ticket; the bot takes the FE ticket's result instead of testing it (followsFe names the FE key)
//   ESCALATED      a placeholder line, a line too vague to verify (v2 marks it Blocked), or any line blocked by a
//                  dependency, a third party, or a role, plan or payment the test account lacks
//   LOLOS          otherwise
// REVISION-RISK is no longer produced: the only line it covered, a vague one, is Blocked in v2, so it is ESCALATED with LAINNYA.
//
// Exit 0 when computed, 2 when the input is rejected.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RULE = {
  noAc: "triage-rules.md \"Mencari AC\": AC tidak ditemukan atau placeholder -> ESKALASI",
  fePair: "triage-rules.md \"Pasangan FE dan BE beda tiket\": tiket BE dengan pasangan FE tidak diuji terpisah, ia mengikuti hasil tiket FE (FOLLOW, atau ESKALASI FE_LINKED selama FE belum punya hasil)",
  systemOnly: "triage-rules.md \"Tiket BE only\": tidak langsung eskalasi; cari pasangan FE (FOLLOW atau FE_LINKED), selain itu jelajah UI (UJI atau LEWATI)",
  dependency: "triage-rules.md \"Kode alasan\" DEPENDENSI (fitur atau tiket yang dibutuhkan belum ada di UAT) dan \"Setengah bisa diuji\"",
  thirdParty: "triage-rules.md \"Selalu eskalasi\", kode PIHAK_KETIGA",
  other: "triage-rules.md \"Selalu eskalasi\", kode LAINNYA",
  secondAccount: "triage-rules.md \"Syarat bisa diuji\" 3: accounts-check.mjs menentukan, bukan teks AC",
  data: "triage-rules.md \"Format alasan eskalasi\": DATA_PRASYARAT tidak diputuskan di triage; dicoba lewat UI di perencanaan (judge.md \"Siapkan prasyarat sendiri\")",
  vague: "triage-rules.md \"Mencari AC\": AC ambigu atau tidak bisa diverifikasi",
  placeholder: "triage-rules.md \"Mencari AC\": placeholder (TBD, -, N/A) sama dengan tidak ada AC",
};

const PLACEHOLDER = /^\s*(tbd|to be defined|tba|-+|n\/?a|none|kosong)?\s*\.?\s*$/i;
const HEADER = /^\s*\**\s*(FE|BE)\s*\**\s*:?\s*$/i;
const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const TAG_GROUP = /^\s*((?:\[[^\]]*\]\s*)+)/;
const TEST_LINK = /^(tests|is tested by)$/i;

// A sentence that hands its part to another ticket ("is built in QRD-1297", "not part of this ticket's test",
// "until QRD-1292 ships that section is hidden") is not this ticket's AC (SKILL.md rule 8), so its keys are not a dependency.
const DEFERRED = [
  /\bnot part of this ticket/i,
  /\bnot checked here\b/i,
  /\b(is|are) (built|checked|tested|verified) (in|there)\b/i,
  /\bbuilt and checked there\b/i,
  /\btested there\b/i,
  /\bverified in (those|that|its|their) tickets?\b/i,
  /\b(is|are) [A-Z][A-Z0-9]+-\d+('s)?\b/,
  /\buntil [A-Z][A-Z0-9]+-\d+ (ships|lands|is done)\b/i,
  /\buntil then\b/i,
  /\bonce (those|its own|that|the) [a-z ]*(exist|ships|lands)/i,
  /\bwhose AC covers\b/i,
];

// Lines with no UI surface are "Passed with Note" for the bot (judge.md, mapping table), so they block nothing.
const SYSTEM = /\b(endpoints?|API|responses?|answers? [1-5]\d\d|[1-5]\d\d\b|migrations?|queues?|BullMQ|jobs?|scheduler|logs?|unit tests?|typecheck|lint|schemas?|Redis|socket\.io|stored|stores|backfill|webhook)\b/i;

const THIRD_PARTY = [
  [/\bwhats ?app\b/i, "a real WhatsApp number or device", "PIHAK_KETIGA"],
  [/\b(real|actual|physical) (phone|device|number)\b|\bnomor (asli|hp)\b|\bHP\b/i, "a real phone or device", "PIHAK_KETIGA"],
  [/\b(OTP|SMS)\b|\b(read|open|receive)s? (an |the )?e-?mail\b|\binbox\b/i, "reading email, SMS or an OTP", "PIHAK_KETIGA"],
  [/\b(facebook|instagram|meta|google|tiktok|shopee|tokopedia)\b.*\b(log ?in|sign ?in|consent|connect|account|oauth)\b|\b(log ?in|consent|connect) (with|through|via) (facebook|instagram|meta|google)\b/i, "a third-party login or consent", "PIHAK_KETIGA"],
  [/\b(payment|billing|invoice|charge|top[- ]?up|pembayaran|tagihan)\b/i, "a real payment or bill", "LAINNYA"],
  [/\b(real|actual) customers?\b|\bpelanggan (nyata|asli)\b/i, "sending to real customers", "LAINNYA"],
  [/\bfeature flag\b|\b(paid |pro |enterprise )?(plan|package|paket) (that|the test account)\b/i, "a role, plan or feature flag the test account may not have", "LAINNYA"],
];
const SECOND_ACCOUNT = /\b(each |every |any )?other (person|people|user|member)s?\b|\banother (person|user|member|account)\b|\bsecond (account|user|member)\b|\btwo (different )?(accounts|users|people|members)\b|\bsomeone (who )?(else|opens|closes|has)\b|\ba member without\b/i;
const DATA = /\bsaved on (develop|production)\b|\blegacy\b|\b(customer|production) data\b|\bdata pelanggan\b|\bexisting customer/i;
// Mirrors DOCK backend/bff-graphql/src/integrations/ticket-lint.ts W2 (vague AC phrases); keep the two lists equal.
const VAGUE_PHRASES = /\b(works? correctly|works? properly|work properly|as expected|user[- ]friendly|sesuai|dengan baik|berjalan normal|optimal|seamless|intuitive)\b/i;

const sentences = (line) => line.split(/(?<=[.!?])\s+(?=["“A-Z(])/);
const excerpt = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function reject(msg) {
  const e = new Error(msg);
  e.code = "PREDICT_INPUT";
  throw e;
}

function validate(input) {
  if (!input || !Array.isArray(input.tickets)) reject("input must be {\"tickets\":[...]}");
  const seen = new Set();
  input.tickets.forEach((t, i) => {
    const where = `tickets[${i}]`;
    if (!t || typeof t.key !== "string" || !t.key) reject(`${where}: 'key' is required`);
    if (seen.has(t.key)) reject(`${where}: duplicate key '${t.key}'`);
    seen.add(t.key);
    if (t.ac !== undefined && (!Array.isArray(t.ac) || t.ac.some((l) => typeof l !== "string"))) reject(`${where}: 'ac' must be an array of strings`);
    if (t.endDay !== undefined && !Number.isFinite(t.endDay)) reject(`${where}: 'endDay' must be a number`);
    if (t.links !== undefined) {
      if (!Array.isArray(t.links)) reject(`${where}: 'links' must be an array`);
      t.links.forEach((l, j) => {
        if (!l || typeof l.key !== "string" || typeof l.type !== "string") reject(`${where}.links[${j}]: needs 'key' and 'type'`);
      });
    }
    if (t.waitsOn !== undefined) {
      if (!Array.isArray(t.waitsOn)) reject(`${where}: 'waitsOn' must be an array`);
      t.waitsOn.forEach((w, j) => {
        if (!w || typeof w.key !== "string" || !Number.isFinite(w.endDay)) reject(`${where}.waitsOn[${j}]: needs 'key' and a numeric 'endDay'`);
      });
    }
  });
}

function acLines(ac) {
  const lines = [];
  let system = false;
  const body = (ac || []).filter((raw) => !HEADER.test(raw));
  if (body.every((raw) => PLACEHOLDER.test(raw))) return lines;
  for (const raw of ac || []) {
    const h = raw.match(HEADER);
    if (h) {
      system = h[1].toUpperCase() === "BE";
      continue;
    }
    lines.push({ n: lines.length + 1, text: raw.trim(), placeholder: PLACEHOLDER.test(raw), system: !PLACEHOLDER.test(raw) && (system || SYSTEM.test(raw)) });
  }
  return lines;
}

/** True when the summary starts with a group of bracket tags holding [tag], as "[BE][Playbook] ..." does. */
function tagged(summary, tag) {
  const group = String(summary || "").match(TAG_GROUP);
  return !!group && (group[1].match(/\[[^\]]*\]/g) || []).some((t) => t.slice(1, -1).trim().toUpperCase() === tag);
}

/** The FE tickets a [BE] ticket follows: its Test links (the sure marker), else other links to an [FE] ticket. */
function fePair(t, summaryOf) {
  if (!tagged(t.summary, "BE")) return [];
  const links = t.links || [];
  const tests = links.filter((l) => TEST_LINK.test(l.type.trim())).map((l) => l.key);
  if (tests.length) return [...new Set(tests)];
  return [...new Set(links.filter((l) => tagged(l.summary ?? summaryOf(l.key), "FE")).map((l) => l.key))];
}

function predictOne(t, dayOf, summaryOf) {
  const reasons = [];
  const fixes = [];
  const causes = new Set();
  const lines = acLines(t.ac);
  const own = Number.isFinite(t.endDay) ? t.endDay : null;

  if (lines.length === 0) {
    return {
      key: t.key,
      prediction: "ESCALATED",
      reasons: [`[LAINNYA] No AC: the Acceptance Criteria field is empty or a placeholder (${RULE.noAc})`],
      fix: "Write the Acceptance Criteria before the sprint starts",
    };
  }
  const pair = fePair(t, summaryOf);
  if (pair.length) {
    return {
      key: t.key,
      prediction: "FOLLOWS_FE",
      reasons: [`[FE_LINKED] Follows FE ${pair.join(", ")}: the BE ticket takes its FE pair's QA result and is not tested on its own (${RULE.fePair})`],
      fix: null,
      followsFe: pair[0],
    };
  }
  if (lines.every((l) => l.system)) {
    return {
      key: t.key,
      prediction: "LOLOS",
      reasons: [`[BE_ONLY warning] All ${lines.length} AC lines are system-side with no UI surface; v2 triage does not escalate this from AC text (${RULE.systemOnly})`],
      fix: null,
    };
  }

  const later = (k) => k !== t.key && own !== null && dayOf(t, k) !== null && dayOf(t, k) > own;
  const depLines = [];
  for (const l of lines) {
    if (l.system) continue;
    const tag = `AC-${l.n}`;
    if (l.placeholder) {
      reasons.push(`${tag} [LAINNYA] placeholder line "${excerpt(l.text) || "(empty)"}": the bot cannot test it (${RULE.placeholder})`);
      causes.add("escalate");
      fixes.push(`write ${tag} as an observable result, or remove it`);
      continue;
    }
    const needs = new Set();
    for (const s of sentences(l.text)) {
      if (DEFERRED.some((re) => re.test(s))) continue;
      for (const k of s.match(KEY) || []) if (later(k)) needs.add(k);
    }
    if (needs.size) {
      const list = [...needs].map((k) => `${k} (day ${dayOf(t, k)})`).join(", ");
      reasons.push(`${tag} [DEPENDENSI] needs ${list}, after this ticket's day ${own}: "${excerpt(l.text)}" (${RULE.dependency})`);
      causes.add("dependency");
      depLines.push(`move ${tag} to the ticket that builds it (${[...needs].join(", ")}) or end this ticket on day ${Math.max(...[...needs].map((k) => dayOf(t, k)))} or later`);
    }
    for (const [re, what, code] of THIRD_PARTY) {
      if (re.test(l.text)) {
        reasons.push(`${tag} [${code}] needs ${what}: "${excerpt(l.text)}" (${code === "PIHAK_KETIGA" ? RULE.thirdParty : RULE.other})`);
        causes.add("escalate");
        fixes.push(`plan manual QA for ${tag} (${what})`);
        break;
      }
    }
    if (SECOND_ACCOUNT.test(l.text)) {
      reasons.push(`${tag} [AKUN_KEDUA warning] may need a second account in the same workspace: "${excerpt(l.text)}" (${RULE.secondAccount})`);
    }
    if (DATA.test(l.text)) {
      reasons.push(`${tag} [DATA_PRASYARAT warning] may need data the UI cannot create: "${excerpt(l.text)}" (${RULE.data})`);
    }
    if (VAGUE_PHRASES.test(l.text)) {
      reasons.push(`${tag} [LAINNYA] not verifiable as written: "${excerpt(l.text)}" (${RULE.vague}; the bot marks it Blocked, so the ticket is ESCALATED with LAINNYA)`);
      causes.add("escalate");
      fixes.push(`rewrite ${tag} as an observable result`);
    }
  }
  fixes.unshift(...depLines);

  const named = new Set(lines.flatMap((l) => l.text.match(KEY) || []));
  const waitedOnOnly = (t.waitsOn || []).filter((w) => later(w.key) && !named.has(w.key));
  if (waitedOnOnly.length && !causes.has("dependency")) {
    const list = waitedOnOnly.map((w) => `${w.key} (day ${w.endDay})`).join(", ");
    reasons.push(`[DEPENDENSI] Waits on ${list}, after this ticket's day ${own}, though no AC line names it (${RULE.dependency})`);
    causes.add("dependency");
    fixes.unshift(`end this ticket after ${waitedOnOnly.map((w) => w.key).join(", ")}, or drop the dependency`);
  }

  const escalated = ["dependency", "escalate"].some((c) => causes.has(c));
  const prediction = escalated ? "ESCALATED" : "LOLOS";
  return { key: t.key, prediction, reasons, fix: fixes.length ? [...new Set(fixes)].join("; ") : null };
}

export function predict(input) {
  validate(input);
  const days = new Map(input.tickets.filter((t) => Number.isFinite(t.endDay)).map((t) => [t.key, t.endDay]));
  const dayOf = (t, k) => {
    const w = (t.waitsOn || []).find((x) => x.key === k);
    if (w) return w.endDay;
    return days.has(k) ? days.get(k) : null;
  };
  const summaries = new Map(input.tickets.map((t) => [t.key, t.summary]));
  return { results: input.tickets.map((t) => predictOne(t, dayOf, (k) => summaries.get(k))) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(predict(input)) + "\n");
  } catch (e) {
    console.error(`predict: ${e.message}`);
    process.exit(2);
  }
}
