// Logs the local test account in once and saves the browser state for browser-verifier.
//   [QONFLO_PASS_FILE=<file holding the password>] node login-state.cjs <fe-port> [email]
// The password is read from QONFLO_PASS_FILE, or ~/.qonflo-pass when that is unset, and never printed or stored here.
// Root, evidence and the FE repo come from paths.cjs; Windows uses the installed Chrome, Linux the system chromium.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolvePaths } = require("./paths.cjs");

const LINUX_CHROMIUM = "/usr/local/bin/chromium";

// The playwright the FE repo pins (pnpm keeps it under node_modules/.pnpm), newest version first.
function playwrightDir(feRepo) {
	const store = path.join(feRepo, "node_modules", ".pnpm");
	const found = fs.existsSync(store) ? fs.readdirSync(store).filter((d) => /^playwright@\d/.test(d)).sort().reverse() : [];
	for (const d of found) {
		const dir = path.join(store, d, "node_modules", "playwright");
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	return null;
}

// How the browser starts, for this script and for playwright-cli's per-port config.
function launchOptions(platform = process.platform, env = process.env) {
	if (platform === "win32") return { channel: "chrome" };
	const executablePath = env.PLAYWRIGHT_CHROMIUM || LINUX_CHROMIUM;
	return fs.existsSync(executablePath) ? { executablePath } : {};
}

function main() {
	const paths = resolvePaths();
	const port = process.argv[2];
	const email = process.argv[3] || "local@test.com";
	const passFile = process.env.QONFLO_PASS_FILE || path.join(os.homedir(), ".qonflo-pass");
	if (!port || !fs.existsSync(passFile)) {
		console.error("usage: [QONFLO_PASS_FILE=<file>] node login-state.cjs <fe-port> [email]   (no password file: set QONFLO_PASS_FILE or create ~/.qonflo-pass)");
		process.exit(1);
	}
	if (paths.protectedPorts.includes(port)) {
		console.error("REFUSED: that port belongs to the user's own servers");
		process.exit(2);
	}
	const pw = playwrightDir(paths.repos.fe);
	if (!pw) {
		console.error(`playwright not found under ${paths.repos.fe}/node_modules/.pnpm (install the FE dependencies first)`);
		process.exit(1);
	}
	const { chromium } = require(pw);
	const launch = launchOptions();
	const out = `${paths.root}/.playwright/auth/local-${port}.json`;
	const config = `${paths.root}/.playwright/cli-${port}.json`;

	(async () => {
		const browser = await chromium.launch(launch);
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
		fs.writeFileSync(
			config,
			JSON.stringify(
				{
					browser: {
						browserName: "chromium",
						launchOptions: launch,
						contextOptions: { viewport: { width: 1600, height: 950 }, colorScheme: "dark", storageState: out },
					},
					outputDir: `${paths.evidence}/.playwright-cli`,
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
}

if (require.main === module) main();
else module.exports = { playwrightDir, launchOptions };
