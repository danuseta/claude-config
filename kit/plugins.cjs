// Prints the storage and voice plugins chosen in DOCK Settings › Plugins, as one JSON line.
//   node plugins.cjs
// {"storage":"s3|local|none","voice":"elevenlabs|none"}; without DOCK (no dock.json or no answer) it prints the old defaults.
const dock = require("./dock-push.cjs");

const DEFAULT = { storage: "s3", voice: "elevenlabs" };

async function main() {
	let r;
	try {
		r = await dock.send("/plugins", {}, 10000);
	} catch {
		r = null;
	}
	const got = r && r.status === 200 && r.result ? r.result : null;
	const storage = ["s3", "local", "none"].includes(got?.storage) ? got.storage : DEFAULT.storage;
	const voice = ["elevenlabs", "none"].includes(got?.voice) ? got.voice : DEFAULT.voice;
	console.log(JSON.stringify({ storage, voice }));
}

main();
