const fs = require("fs");
const path = require("path");
const { chromium } = require("E:/qonflo/ms-client-dashboard-frontend/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright");

const SCALE = 1.35;
const WINDOW = [1436, 893];
const LINE_GAP_MS = 350;

const workdir = path.dirname(path.resolve(process.argv[2] || path.join(__dirname, "scenario.json")));
const { token, api } = require(path.join(workdir, "session.cjs"));
const scenario = JSON.parse(fs.readFileSync(path.join(workdir, "scenario.json"), "utf8"));
const audio = JSON.parse(fs.readFileSync(path.join(workdir, "audio.json"), "utf8"));
const seed = JSON.parse(fs.readFileSync(path.join(workdir, "seed.json"), "utf8"));
const vars = { ...seed };

const fill = (value) => {
	if (typeof value === "string") {
		const whole = value.match(/^\{\{(\w+)\}\}$/);
		if (whole) return vars[whole[1]];
		return value.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key]));
	}
	if (Array.isArray(value)) return value.map(fill);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
	return value;
};

const shortPath = (p) => `/api/v2${p}`.replace(/[a-f0-9]{24}/g, (id) => `…${id.slice(-4)}`);

const rowsFor = (res, show, spec) => {
	const rows = [];
	const d = res.json && res.json.data;
	if (spec && spec.pick) {
		const row = (d && d.rows ? d.rows : []).find((r) => r.id === vars[spec.pick]);
		if (row) rows.push({ k: "node.status", v: String(row.status) });
		return rows;
	}
	if (res.status >= 400) {
		if (show.includes("error")) rows.push({ k: "error", v: String(res.json.error) });
		if (show.includes("findings") && d && d.findings)
			rows.push({ k: "findings", v: d.findings.map((f) => `${f.code} · ${f.severity}`).join(String.fromCharCode(10)) });
		if (show.includes("revision") && d && d.revision !== undefined) rows.push({ k: "data.revision", v: String(d.revision) });
		if (show.includes("sizeBytes") && d && d.sizeBytes !== undefined) rows.push({ k: "data.sizeBytes", v: d.sizeBytes.toLocaleString("en-US") });
		if (show.includes("limit") && d && d.limit !== undefined) rows.push({ k: "data.limit", v: `${d.limit.toLocaleString("en-US")} (1 MiB)` });
		return rows;
	}
	if (Array.isArray(d)) {
		rows.push({ k: "versions", v: `[${d.map((b) => b.version).join(", ")}]` });
		const keys = Object.keys(d[0] || {});
		rows.push({ k: "skillMd / cards", v: keys.includes("skillMd") || keys.includes("cards") ? "ada" : "tidak ikut (ringkasan)" });
		return rows;
	}
	for (const key of show) {
		if (!d) continue;
		if (key === "files") rows.push({ k: "files", v: ["SKILL.md", ...(d.cards || []).map((c) => c.path)].join(String.fromCharCode(10)) });
		else if (key === "stored") rows.push({ k: "stored", v: "skillBundles (Mongo)" });
		else if (key === "skillMd") rows.push({ k: "skillMd", v: `${Buffer.byteLength(d.skillMd || "", "utf8")} bytes, inline` });
		else if (key === "sizeBytes" && d.sizeBytes !== undefined) rows.push({ k: "sizeBytes", v: d.sizeBytes.toLocaleString("en-US") });
		else if (d[key] !== undefined) rows.push({ k: key, v: String(d[key]) });
	}
	return rows;
};

const clearHighlight = (page) =>
	page.evaluate(() => {
		document.getElementById("__demo_hl")?.remove();
	});

async function showHighlight(page, highlight) {
	await clearHighlight(page);
	if (!highlight) return null;
	const target = highlight.text ? page.getByText(highlight.text).first() : page.locator(highlight.selector).first();
	await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
	await page.waitForTimeout(700);
	const box = await target.boundingBox();
	if (!box) return null;
	return page.evaluate((box) => {
		const top = Math.max(4, box.y - 8);
		const height = Math.min(innerHeight - top - 4, box.height + 16);
		const frame = document.createElement("div");
		frame.id = "__demo_hl";
		frame.style.cssText = `position:fixed;left:${box.x - 8}px;top:${top}px;width:${box.width + 16}px;height:${height}px;border:3px solid #f472b6;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.25),0 0 20px #f472b6;z-index:99998;pointer-events:none`;
		document.documentElement.appendChild(frame);
		const rect = frame.getBoundingClientRect();
		return [rect.left, rect.top, rect.right, rect.bottom].map((v) => Math.round(v * devicePixelRatio));
	}, box);
}

async function dismiss(page) {
	for (let i = 0; i < 2; i++) {
		const later = page.locator('button:has-text("Maybe Later")');
		if ((await later.count()) && (await later.first().isVisible())) {
			await later.first().click({ force: true });
			await page.waitForTimeout(400);
		}
	}
}

async function runAction(page, action) {
	if (action.type === "click") await page.getByRole(action.role, { name: new RegExp(action.name) }).first().click();
	else if (action.type === "press") await page.keyboard.press(action.key);
	else if (action.type === "wait") await page.waitForTimeout(action.ms);
	else if (action.type === "dismiss") await dismiss(page);
	else if (action.type === "reload") {
		await clearHighlight(page);
		await page.reload();
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(1500);
		await dismiss(page);
	} else if (action.type === "goto") {
		await clearHighlight(page);
		await page.goto(scenario.baseUrl + fill(action.url));
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(1500);
	}
}

(async () => {
	const browser = await chromium.launch({ channel: "chrome", args: [`--force-device-scale-factor=${SCALE}`, `--window-size=${WINDOW[0]},${WINDOW[1]}`] });
	const context = await browser.newContext({ viewport: null, colorScheme: "dark" });
	await context.grantPermissions(["notifications"], { origin: scenario.baseUrl });
	await context.addInitScript(() => {
		localStorage.setItem("v2-theme", "dark");
		setInterval(() => {
			for (const b of document.querySelectorAll("button")) if (b.textContent && b.textContent.trim() === "Maybe Later") b.click();
		}, 150);
	});
	const page = await context.newPage();

	const password = fs.readFileSync(scenario.login.passwordFile, "utf8").trim();
	await page.goto(`${scenario.baseUrl}/login`);
	await page.waitForSelector('input[type="password"]', { timeout: 120000 });
	await page.locator('input[type="email"]').fill(scenario.login.email);
	await page.locator('input[type="password"]').fill(password);
	await page.locator('button[type="submit"]').click();
	await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 60000 });
	await page.waitForTimeout(1500);
	const tok = await token(page);

	vars.refundRevision = (await api(tok, "GET", `/playbook/skills/${seed.refundId}/draft`)).json.data.revision;
	vars.oldRevision = (await api(tok, "GET", `/playbook/skills/${seed.oldId}/draft`)).json.data.revision;
	vars.staleRevision = vars.refundRevision - 1;
	vars.bigRevision = (await api(tok, "GET", `/playbook/skills/${seed.bigId}/draft`)).json.data.revision;

	await page.goto(scenario.baseUrl + fill(scenario.startUrl));
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.waitForTimeout(2000);
	await dismiss(page);

	const [cssW, cssH, dpr] = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
	if (Math.abs(cssW * dpr - 1920) > 6 || Math.abs(cssH * dpr - 1080) > 6) throw new Error(`frame is not 1920x1080: ${cssW}x${cssH}@${dpr}`);

	const framesDir = path.join(workdir, "frames");
	fs.rmSync(framesDir, { recursive: true, force: true });
	fs.mkdirSync(framesDir, { recursive: true });
	const frames = [];
	const cdp = await context.newCDPSession(page);
	cdp.on("Page.screencastFrame", async (frame) => {
		const file = path.join(framesDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
		fs.writeFileSync(file, Buffer.from(frame.data, "base64"));
		frames.push({ file, ts: frame.metadata.timestamp });
		await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95 });

	const t0 = Date.now() / 1000;
	const now = () => Date.now() / 1000 - t0;
	const cues = [];
	const notes = [];
	const apis = [];
	const compares = [];
	const checklists = [];
	const written = [];
	let bodyStart = null;
	let bodyEnd = null;

	const call = async (spec, show) => {
		const body = spec.body === undefined ? undefined : fill(spec.body);
		const res = await api(tok, spec.method, fill(spec.path), body);
		return {
			at: now(),
			method: spec.method,
			path: shortPath(fill(spec.path)),
			body: body === undefined ? null : JSON.stringify(body),
			status: res.status,
			rows: rowsFor(res, spec.show || show || [], spec),
		};
	};

	for (const [stepIndex, step] of scenario.steps.entries()) {
		const framing = Boolean(step.part);
		if (!framing && bodyStart === null) bodyStart = now();
		for (const action of step.actions || []) await runAction(page, action);
		const open = notes[notes.length - 1];
		if (open && open.to === null) open.to = now();
		const box = await showHighlight(page, step.highlight);
		if (box && step.highlight.note) notes.push({ from: now(), to: null, box, text: step.highlight.note });

		let apiEntry = null;
		if (step.api) {
			apiEntry = { from: now(), to: null, calls: [], hl: [] };
			apis.push(apiEntry);
		}
		let compareEntry = null;
		if (step.compare) {
			const v = (await api(tok, "GET", `/playbook/skills/${seed.refundId}/versions/${step.compare.version}`)).json.data;
			const compiled = (await api(tok, "POST", `/playbook/skills/${seed.refundId}/compile`)).json.data.skillMd;
			compareEntry = {
				from: now(),
				to: null,
				version: step.compare.version,
				path: `GET /versions/${step.compare.version} → skillMd`,
				storagePath: "inline di dokumen skillBundles, tanpa signed URL",
				bytes: Buffer.byteLength(v.skillMd, "utf8"),
				identical: v.skillMd === compiled,
				text: v.skillMd,
			};
			compares.push(compareEntry);
		}
		let checkEntry = null;
		if (step.checklist) {
			checkEntry = { from: now(), to: null, lines: [] };
			checklists.push(checkEntry);
		}

		for (const [lineIndex, line] of audio[stepIndex].lines.entries()) {
			const lineStart = now();
			cues.push({ file: line.file, show: line.show, dur: line.dur, at: lineStart });
			if (checkEntry) checkEntry.lines.push(lineStart);
			if (apiEntry) {
				if (lineIndex === 0) apiEntry.calls.push(await call(step.api, step.api.show));
				for (const next of (step.api.then || []).filter((n) => n.atLine === lineIndex))
					apiEntry.calls.push(await call(next, step.api.show));
				for (const key of (step.api.hl || {})[String(lineIndex)] || [])
					apiEntry.hl.push({ key, from: lineStart, to: lineStart + line.dur + LINE_GAP_MS / 1000 });
			}
			const spent = now() - lineStart;
			await page.waitForTimeout(Math.max(0, line.dur * 1000 + LINE_GAP_MS - spent * 1000));
		}
		await page.waitForTimeout(250);
		if (apiEntry) apiEntry.to = now();
		if (compareEntry) compareEntry.to = now();
		if (checkEntry) checkEntry.to = now();
		if (!framing) bodyEnd = now();
	}
	const open = notes[notes.length - 1];
	if (open && open.to === null) open.to = now();
	await clearHighlight(page);
	await page.waitForTimeout(600);
	await cdp.send("Page.stopScreencast").catch(() => {});
	const end = Date.now() / 1000;
	await browser.close();

	fs.writeFileSync(
		path.join(workdir, "cues.json"),
		JSON.stringify({ t0, end, bodyStart, bodyEnd, cues, notes, frames, apis, compares, checklists }, null, 1)
	);
	console.log(
		`recorded ${(end - t0).toFixed(1)}s, ${frames.length} frames, ${cues.length} cues, ${notes.length} notes, ${apis.length} api, ${compares.length} compare, body ${bodyStart?.toFixed(2)}-${bodyEnd?.toFixed(2)}s`
	);
	console.log("api statuses", apis.map((a) => a.calls.map((c) => c.status).join("+")).join(" | "), "identical", compares.map((c) => c.identical));
	for (const a of apis) for (const c of a.calls) console.log(c.status, c.path, JSON.stringify(c.rows));
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
