const path = require("path");
const toSlash = (p) => p.split(path.sep).join("/").split("\\").join("/");
const root = toSlash(process.env.JEST_ROOT || process.cwd());
const base = require(path.join(root, "jest.config.ts"));
const stub = toSlash(path.join(__dirname, "ai-stub.js"));
const map = { "^ai$": stub, "^ai/(.*)$": stub, "^@ai-sdk/(.*)$": stub };
module.exports = {
	...base,
	rootDir: root,
	projects: (base.projects || [base]).map((p) => ({ ...p, rootDir: root, moduleNameMapper: { ...p.moduleNameMapper, ...map } })),
};
