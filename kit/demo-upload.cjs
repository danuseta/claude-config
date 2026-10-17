// Puts a ticket's demo video in DOCK's bucket and sets its demo link on both DOCKs.
//   node demo-upload.cjs <KEY> <file.mp4>
// The workspace DOCK keeps the bucket keys; this only sends the file with the machine's ingest token.
// Prints the permanent link. A new render for the same ticket replaces the video; the link stays.
const fs = require("fs");
const dock = require("./dock-push.cjs");

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
	const [key, file] = process.argv.slice(2);
	if (!key || !file) {
		console.error("usage: node demo-upload.cjs <KEY> <file.mp4>");
		process.exitCode = 1;
		return;
	}
	if (!fs.existsSync(file)) {
		console.error(`no such file ${file}`);
		process.exitCode = 1;
		return;
	}
	const r = await dock.sendFile("/demo-video", { key }, fs.readFileSync(file), "video/mp4", UPLOAD_TIMEOUT_MS);
	if (r.skipped) {
		console.error("DOCK is not configured (dock.json); the demo video was not uploaded");
		process.exitCode = 1;
		return;
	}
	if (r.status !== 200) {
		console.error(`DOCK refused the demo video: ${r.status}${r.error ? " " + r.error : ""}`);
		process.exitCode = 1;
		return;
	}
	console.log(r.result.url);
}

main().catch((err) => {
	console.error(err.message || err);
	process.exitCode = 1;
});
