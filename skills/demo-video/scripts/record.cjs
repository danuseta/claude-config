const fs = require("fs");
const path = require("path");

const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE || "E:/qonflo/ms-client-dashboard-frontend/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright";
const { chromium } = require(PLAYWRIGHT);

const SCALE = 1.35;
const WINDOW = [1436, 893];
const LINE_GAP_MS = 350;
const LEGACY_CARDS = process.argv.includes("--legacy-cards");

const scenarioPath = path.resolve(process.argv[2]);
const workdir = path.dirname(scenarioPath);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const audio = JSON.parse(fs.readFileSync(path.join(workdir, "audio.json"), "utf8"));

const showCard = (page, card) =>
	page.evaluate((card) => {
		document.getElementById("__demo_card")?.remove();
		if (!card) return;
		const el = document.createElement("div");
		el.id = "__demo_card";
		el.style.cssText =
			"position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:radial-gradient(circle at 30% 20%,#3b1d6e,#0b0b12 70%);color:#fff;font-family:'Segoe UI',Inter,Arial,sans-serif";
		el.innerHTML = '<div style="font-size:14px;letter-spacing:.22em;color:#c4b5fd">QONFLO · DEMO REVIEW</div><div style="font-size:44px;font-weight:700;text-align:center"></div><div style="font-size:20px;color:#d4d4d8"></div>';
		el.children[1].textContent = card.title || "";
		el.children[2].textContent = card.sub || "";
		document.documentElement.appendChild(el);
	}, card || null);

const clearHighlight = (page) =>
	page.evaluate(() => {
		document.getElementById("__demo_hl")?.remove();
		document.getElementById("__demo_note")?.remove();
	});

function resolveTarget(page, highlight) {
	let locator = highlight.text ? page.getByText(highlight.text).first() : page.locator(highlight.selector).first();
	if (highlight.line) locator = locator.locator("xpath=ancestor::div[@class='cm-line'][1]");
	return locator;
}

async function showHighlight(page, highlight) {
	await clearHighlight(page);
	if (!highlight) return null;
	const target = resolveTarget(page, highlight);
	await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
	await page.waitForTimeout(700);
	const box = await target.boundingBox();
	if (!box) return null;
	return page.evaluate(
		([box, note]) => {
			const top = Math.max(4, box.y - 8);
			const height = Math.min(innerHeight - top - 4, box.height + 16);
			const frame = document.createElement("div");
			frame.id = "__demo_hl";
			frame.style.cssText = `position:fixed;left:${box.x - 8}px;top:${top}px;width:${box.width + 16}px;height:${height}px;border:3px solid #f472b6;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.25),0 0 20px #f472b6;z-index:99998;pointer-events:none`;
			document.documentElement.appendChild(frame);
			const rect = frame.getBoundingClientRect();
			const dpr = devicePixelRatio;
			const logged = [rect.left, rect.top, rect.right, rect.bottom].map((v) => Math.round(v * dpr));
			if (!note) return logged;
			const label = document.createElement("div");
			label.id = "__demo_note";
			label.textContent = note;
			label.style.cssText = "position:fixed;visibility:hidden;z-index:99999;background:#f472b6;color:#1a0b14;font:700 15px 'Segoe UI',Arial,sans-serif;padding:7px 12px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.5);pointer-events:none;max-width:360px";
			document.documentElement.appendChild(label);
			const w = label.offsetWidth;
			const h = label.offsetHeight;
			const right = box.x + box.width + 20;
			let x;
			let y;
			if (right + w < innerWidth - 12) {
				x = right;
				y = Math.min(Math.max(12, top), innerHeight - h - 12);
			} else if (top + height + 12 + h < innerHeight - 12) {
				x = Math.max(12, box.x - 8);
				y = top + height + 12;
			} else {
				x = Math.max(12, box.x - 8);
				y = Math.max(12, top - h - 12);
			}
			label.style.left = `${x}px`;
			label.style.top = `${y}px`;
			label.style.visibility = "visible";
			return logged;
		},
		[box, LEGACY_CARDS ? highlight.note || null : null]
	);
}

async function runAction(page, action) {
	if (action.type === "click") {
		const target = action.role ? page.getByRole(action.role, { name: new RegExp(action.name) }) : page.locator(action.selector);
		await target.first().click();
	} else if (action.type === "press") await page.keyboard.press(action.key);
	else if (action.type === "type") await page.keyboard.type(action.text, { delay: action.delayPerChar || 40 });
	else if (action.type === "scrollTop") {
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
		await page.waitForTimeout(500);
	} else if (action.type === "wait") await page.waitForTimeout(action.ms);
	else if (action.type === "goto") {
		await page.goto(scenario.baseUrl + action.url);
		await page.waitForLoadState("networkidle").catch(() => {});
	} else if (action.type === "eval") await page.evaluate(action.js);
}

async function dismissPrompts(page) {
	for (let i = 0; i < 2; i++) {
		const later = page.locator('button:has-text("Maybe Later")');
		if ((await later.count()) && (await later.first().isVisible())) {
			await later.first().click({ force: true });
			await page.waitForTimeout(400);
		}
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

	if (scenario.login) {
		const password = fs.readFileSync(scenario.login.passwordFile, "utf8").trim();
		await page.goto(`${scenario.baseUrl}/login`);
		await page.waitForSelector('input[type="password"]', { timeout: 120000 });
		await page.locator('input[type="email"]').fill(scenario.login.email);
		await page.locator('input[type="password"]').fill(password);
		await page.locator('button[type="submit"]').click();
		await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 60000 });
		await page.waitForTimeout(1500);
	}
	await page.goto(scenario.baseUrl + scenario.startUrl);
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.waitForTimeout(2000);
	await dismissPrompts(page);

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
	let bodyStart = null;
	let bodyEnd = null;
	const closeNote = () => {
		const open = notes[notes.length - 1];
		if (open && open.to === null) open.to = now();
	};
	for (const [stepIndex, step] of scenario.steps.entries()) {
		const framing = Boolean(step.part || step.card);
		if (LEGACY_CARDS) {
			await showCard(page, step.card);
			if (!step.card && stepIndex > 0 && scenario.steps[stepIndex - 1].card) await showCard(page, null);
		}
		if (!framing && bodyStart === null) bodyStart = now();
		for (const action of (step.actions || []).filter((a) => a.atLine === undefined)) await runAction(page, action);
		closeNote();
		const box = await showHighlight(page, step.highlight);
		if (box && step.highlight.note) notes.push({ from: now(), to: null, box, text: step.highlight.note });
		for (const [lineIndex, line] of audio[stepIndex].lines.entries()) {
			cues.push({ file: line.file, show: line.show, dur: line.dur, at: Date.now() / 1000 - t0 });
			let spent = 0;
			for (const action of (step.actions || []).filter((a) => a.atLine === lineIndex)) {
				await page.waitForTimeout(action.delayMs || 0);
				spent += action.delayMs || 0;
				await runAction(page, action);
			}
			await page.waitForTimeout(Math.max(0, line.dur * 1000 + LINE_GAP_MS - spent));
		}
		await page.waitForTimeout(250);
		if (!framing) bodyEnd = now();
	}
	closeNote();
	await clearHighlight(page);
	await page.waitForTimeout(600);
	await cdp.send("Page.stopScreencast").catch(() => {});
	const end = Date.now() / 1000;
	await browser.close();

	fs.writeFileSync(
		path.join(workdir, "cues.json"),
		JSON.stringify({ t0, end, bodyStart, bodyEnd, cues, notes, frames }, null, 1)
	);
	console.log(
		`recorded ${(end - t0).toFixed(1)}s, ${frames.length} frames, ${cues.length} cues, ${notes.length} notes, body ${bodyStart?.toFixed(2)}-${bodyEnd?.toFixed(2)}s`
	);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
