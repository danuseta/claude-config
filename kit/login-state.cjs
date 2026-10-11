// Logs the local test account in once and saves the browser state for browser-verifier.
//   QONFLO_PASS_FILE=<file holding the password> node login-state.cjs <fe-port> [email]
// The password is read from the file named by QONFLO_PASS_FILE and never printed or stored here.
const fs = require("fs");
const path = require("path");
const { chromium } = require("E:/qonflo/ms-client-dashboard-frontend/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright");

const port = process.argv[2];
const email = process.argv[3] || "local@test.com";
const passFile = process.env.QONFLO_PASS_FILE;
if (!port || !passFile || !fs.existsSync(passFile)) {
	console.error("usage: QONFLO_PASS_FILE=<file> node login-state.cjs <fe-port> [email]");
	process.exit(1);
}
if (["3000", "3001", "5173"].includes(port)) {
	console.error("REFUSED: that port belongs to the user's own servers");
	process.exit(2);
}
const out = `E:/qonflo/.playwright/auth/local-${port}.json`;

(async () => {
	const browser = await chromium.launch({ channel: "chrome" });
	const context = await browser.newContext({ colorScheme: "dark" });
	const page = await context.newPage();
	await page.goto(`http://localhost:${port}/login`);
	await page.waitForSelector('input[type="password"]', { timeout: 120000 });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(fs.readFileSync(passFile, "utf8").trim());
	await page.locator('button[type="submit"]').click();
	await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 60000 });
	await page.waitForTimeout(3000);
	await page.evaluate(() => localStorage.setItem("v2-theme", "dark"));
	fs.mkdirSync(path.dirname(out), { recursive: true });
	await context.storageState({ path: out, indexedDB: true });
	await browser.close();
	// playwright-cli's `state-load` hangs on a state that carries IndexedDB (Firebase auth lives
	// there), so the state is handed to the browser context through a per-port config instead.
	const config = `E:/qonflo/.playwright/cli-${port}.json`;
	fs.writeFileSync(
		config,
		JSON.stringify(
			{
				browser: {
					browserName: "chromium",
					launchOptions: { channel: "chrome" },
					contextOptions: { viewport: { width: 1600, height: 950 }, colorScheme: "dark", storageState: out },
				},
				outputDir: "E:/qonflo/.evidence/.playwright-cli",
				console: { level: "warning" },
			},
			null,
			"\t"
		)
	);
	console.log(`saved ${out} and ${config}`);
})().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
