"use strict";
const fs = require("fs");
const path = require("path");

const STEPS = [
	["stack", "Stack"],
	["login", "Login"],
	["tests", "Tests"],
	["judge", "Verdict"],
];
const LINE_RE = /^\s*(✓|✘|×|-|ok|x)\s+\d+\s+\[[^\]]+\]\s+›.*$/;

function create(runDir, { key, runId, startedAt, tcs, external, smoke = false }) {
	const state = {
		schema: "qonflo-qa-local-progress/1",
		key,
		runId,
		...(smoke ? { smoke: true } : {}),
		pid: process.pid,
		startedAt,
		updatedAt: startedAt,
		finishedAt: null,
		state: "running",
		step: external ? "login" : "stack",
		steps: STEPS.map(([id, label]) => ({ id, label, state: external && id === "stack" ? "skipped" : "pending" })),
		tcs: tcs.map((t) => ({ id: String(t.id), title: t.title || "", ac: Array.isArray(t.ac) ? t.ac : [], state: "pending", seconds: null, video: null, note: null })),
		verdict: null,
		rule: null,
		counts: null,
		error: null,
	};
	const file = path.join(runDir, "progress.json");
	const save = () => {
		state.updatedAt = new Date().toISOString();
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
		fs.renameSync(tmp, file);
	};
	const step = (id, value) => {
		const s = state.steps.find((x) => x.id === id);
		if (s) s.state = value;
		if (value === "running") state.step = id;
		save();
	};
	const nextRunning = () => {
		const next = state.tcs.find((t) => t.state === "pending");
		if (next) next.state = "running";
	};
	const testsStarted = () => {
		step("tests", "running");
		nextRunning();
		save();
	};
	const line = (text) => {
		if (!LINE_RE.test(text)) return;
		const tc = state.tcs.find((t) => text.includes(t.id));
		if (!tc) return;
		const mark = text.trim().split(/\s+/)[0];
		tc.state = mark === "✓" || mark === "ok" ? "passed" : mark === "-" ? "skipped" : "failed";
		const secs = text.match(/\((\d+(?:\.\d+)?)(m?s)\)\s*$/);
		if (secs) tc.seconds = secs[2] === "ms" ? Number(secs[1]) / 1000 : Number(secs[1]);
		state.tcs.forEach((t) => {
			if (t.state === "running") t.state = "pending";
		});
		nextRunning();
		save();
	};
	const done = (results) => {
		const byId = new Map((results.tcs || []).map((t) => [String(t.id), t]));
		for (const t of state.tcs) {
			const r = byId.get(t.id);
			if (!r) {
				if (t.state === "running" || t.state === "pending") t.state = "blocked";
				continue;
			}
			t.state = r.qaStatus === "Passed" || r.qaStatus === "Passed with Note" ? "passed" : r.qaStatus === "Failed" ? "failed" : "blocked";
			t.video = r.video || null;
			t.seconds = Number.isFinite(r.durationMs) ? r.durationMs / 1000 : t.seconds;
			const note = r.notes || r.finding || r.error;
			t.note = note ? String(note).split("\n")[0].slice(0, 300) : null;
		}
		for (const s of state.steps) if (s.state === "running" || s.state === "pending") s.state = results.infraError ? "failed" : "done";
		state.step = "judge";
		state.verdict = results.verdict ? results.verdict.prediction : null;
		state.rule = results.verdict ? results.verdict.rule : null;
		state.counts = results.counts || null;
		if (results.followsFe) state.followsFe = results.followsFe;
		state.error = results.infraError || null;
		state.state = results.infraError ? "failed" : "done";
		state.finishedAt = new Date().toISOString();
		save();
	};
	save();
	return { step, testsStarted, line, done, state };
}

module.exports = { create };
