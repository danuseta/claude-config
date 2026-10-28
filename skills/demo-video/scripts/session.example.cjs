const fs = require("fs");
const { chromium } = require("E:/qonflo/ms-client-dashboard-frontend/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright");

const FE = process.env.DEMO_FE || "http://localhost:5199";
const API = process.env.DEMO_API || "http://localhost:3099/api/v2";
const PASS_FILE = process.env.DEMO_PASSWORD_FILE;

async function login(page) {
	const password = fs.readFileSync(PASS_FILE, "utf8").trim();
	await page.goto(`${FE}/login`);
	await page.waitForSelector('input[type="password"]', { timeout: 120000 });
	await page.locator('input[type="email"]').fill("local@test.com");
	await page.locator('input[type="password"]').fill(password);
	await page.locator('button[type="submit"]').click();
	await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 60000 });
	await page.waitForTimeout(1500);
}

const token = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const open = indexedDB.open("firebaseLocalStorageDb");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const tx = open.result.transaction("firebaseLocalStorage", "readonly");
					const all = tx.objectStore("firebaseLocalStorage").getAll();
					all.onsuccess = () => {
						const user = all.result.find((row) => row.value && row.value.stsTokenManager);
						resolve(user ? user.value.stsTokenManager.accessToken : null);
					};
					all.onerror = () => reject(all.error);
				};
			})
	);

async function api(tok, method, path, body) {
	const res = await fetch(API + path, {
		method,
		headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json };
}

async function openBrowser() {
	const browser = await chromium.launch({ channel: "chrome" });
	const context = await browser.newContext({ colorScheme: "dark" });
	await context.addInitScript(() => localStorage.setItem("v2-theme", "dark"));
	const page = await context.newPage();
	return { browser, context, page };
}

module.exports = { FE, API, login, token, api, openBrowser };
