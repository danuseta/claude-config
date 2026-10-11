const Module = require("module");
const stub = require.resolve("./ai-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
	if (req === "ai" || req.startsWith("ai/") || req.startsWith("@ai-sdk/")) return stub;
	return orig.call(this, req, ...rest);
};
