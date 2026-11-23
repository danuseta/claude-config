"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// Code lives in the kit (~/.claude/kit/qa-local); the data (tests/, runs/) stays in ~/qa-local, or QA_LOCAL_DIR.
function resolveLocalPaths(env = process.env, home = os.homedir()) {
	const code = path.resolve(__dirname, "..");
	const data = env.QA_LOCAL_DIR || path.join(home, "qa-local");
	const kit = path.resolve(code, "..");
	const pwCandidates = [path.join(home, "qa", "node_modules"), path.join(code, "node_modules")].map((d) => path.join(d, "@playwright", "test", "cli.js"));
	const computeVerdict = [env.QA_COMPUTE_VERDICT, path.join(home, ".claude", "skills", "skill-qonflo-qa", "scripts", "compute-verdict.mjs")].find((f) => f && fs.existsSync(f)) || null;
	return { code, data, kit, pwCandidates, computeVerdict };
}

module.exports = { resolveLocalPaths };
