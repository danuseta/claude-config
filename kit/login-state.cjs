// Logs the local test account in once and saves the browser state for browser-verifier.
//   [QONFLO_PASS_FILE=<file holding the password>] node login-state.cjs <fe-port> [email]
// The password is read from QONFLO_PASS_FILE, or ~/.qonflo-pass when that is unset, and never printed or stored here.
// Root, evidence and the FE repo come from paths.cjs; Windows uses the installed Chrome, Linux the system chromium.
// Before logging in it gives the account's group an ACTIVE local subscription when it has none, so the app does not
// send it to /checkout. That only touches a MongoDB on this machine, read from the BE repo's .env, through mongosh.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
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

function readEnv(file) {
	const values = {};
	if (!fs.existsSync(file)) return values;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (m) values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return values;
}

// True only when every host of a mongodb:// string is this machine; mongodb+srv always names a remote cluster.
function isLocalMongo(conn) {
	const m = String(conn || "").match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/);
	if (!m) return false;
	return m[1].split(",").every((host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host.trim()));
}

// mongosh script: reads SEED_DB and SEED_EMAIL; adds one zero-amount ACTIVE subscription only when the group has none.
const SEED_SCRIPT = `
const d = db.getSiblingDB(process.env.SEED_DB);
const u = d.users.findOne({ email: process.env.SEED_EMAIL });
if (!u || !u.groupId) { print("no user " + process.env.SEED_EMAIL); quit(); }
const g = typeof u.groupId === "string" ? u.groupId : u.groupId.toHexString();
if (d.subscriptions.countDocuments({ groupId: g, status: { $in: ["ACTIVE", "PAST_DUE"] } }) > 0) { print("active already"); quit(); }
const now = new Date();
d.subscriptions.updateOne(
	{ groupId: g, referenceId: "LOCAL-TEST-SEED" },
	{ $set: { status: "ACTIVE", updatedAt: now }, $setOnInsert: { currency: "IDR", amount: 0, interval: "MONTHLY", intervalCount: 1, anchorDate: now, paymentMethods: ["XENDIT"], recurringAction: "PAYMENT", activatedAt: now, createdAt: now, __v: 0 } },
	{ upsert: true }
);
print("seeded");
`;

// One line about the local subscription; never stops the login.
function ensureSubscription(beRepo, email, run = spawnSync) {
	const env = readEnv(path.join(beRepo, ".env"));
	const conn = env.MONGO_CONN_STRING;
	if (!conn || !env.MONGO_CONN_DBNAME) return "subscription: skipped, no MONGO_CONN_STRING / MONGO_CONN_DBNAME in the BE .env";
	if (!isLocalMongo(conn)) return "subscription: skipped, MongoDB is not on this machine";
	const r = run("mongosh", ["--quiet", conn, "--eval", SEED_SCRIPT], {
		encoding: "utf8",
		timeout: 30000,
		env: { ...process.env, SEED_DB: env.MONGO_CONN_DBNAME, SEED_EMAIL: email },
	});
	if (r.error) return `subscription: skipped, ${r.error.code === "ENOENT" ? "mongosh not found" : r.error.message}`;
	if (r.status !== 0) return `subscription: failed, ${String(r.stderr || "").trim().split("\n").pop()}`;
	return `subscription: ${String(r.stdout || "").trim()}`;
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
	console.log(ensureSubscription(paths.repos.be, email));
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
else module.exports = { playwrightDir, launchOptions, isLocalMongo, ensureSubscription, SEED_SCRIPT };
