import { defineConfig } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const dataDir = process.env.QA_LOCAL_DIR || path.join(os.homedir(), "qa-local");
const runDir = process.env.QA_RUN_DIR || path.join(dataDir, "runs", "_adhoc");
const chromium = process.env.PLAYWRIGHT_CHROMIUM || "/usr/local/bin/chromium";
const viewport = { width: 1600, height: 950 };

export default defineConfig({
	testDir: process.env.QA_TESTS_DIR || path.join(dataDir, "tests"),
	testMatch: /.*\.spec\.(ts|js|mjs|cjs)$/,
	outputDir: path.join(runDir, "pw-output"),
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	timeout: 180000,
	expect: { timeout: 15000 },
	reporter: [["list"], ["json", { outputFile: process.env.QA_REPORT_FILE || path.join(runDir, "pw-report.json") }]],
	use: {
		baseURL: process.env.QA_FE_URL,
		storageState: process.env.QA_STATE_LOCAL || undefined,
		video: { mode: "on", size: viewport },
		viewport,
		colorScheme: "dark",
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		actionTimeout: 20000,
		navigationTimeout: 60000,
		launchOptions: fs.existsSync(chromium) ? { executablePath: chromium } : {},
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
