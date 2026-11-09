// The demo video is made once per ticket, for the first PR. This lock refuses the two steps that make a new one, whatever the
// prompt that led there says: dispatching `sous-video`, and `node demo-upload.cjs <KEY> ...`. It reads the ticket's ledger: once
// the newest `video` handoff is `done`, a new video needs the owner's own words, carried as
//   new video: yes, owner: "<words>"          in the sous-video prompt
//   NEW_VIDEO_OWNER="<words>"                  on the demo-upload command line
// and those words must appear in an owner message of the session transcript. On QRD-1312 and QRD-1511 (9 Nov) the lead's own plan
// ("memperbarui video", "add/redo the scene ... and upload") reached the runner and a first video was redone; prompt wording alone
// could not stop it, so the lock sits where the video is made.
// Used by runner-announce.cjs (Agent) and guard.cjs (Bash), which are already registered hooks, so a change here reaches running sessions.
const fs = require("fs");
const path = require("path");

const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const OWNER_LINE = /^\s*new video:\s*yes, owner:\s*"([^"]+)"\s*$/im;
const UPLOAD = /demo-upload\.cjs["']?\s+["']?([A-Z][A-Z0-9]+-\d+)/;
const UPLOAD_OWNER = /NEW_VIDEO_OWNER=(?:"([^"]+)"|'([^']+)')/;

function evidenceRoot() {
	if (process.env.QONFLO_EVIDENCE) return process.env.QONFLO_EVIDENCE;
	try { return require("./paths.cjs").resolvePaths().evidence; } catch { return null; }
}

// The newest video handoff of a ticket, or null when the ledger has none or cannot be read.
function lastVideo(key, readFile = (f) => fs.readFileSync(f, "utf8"), root = evidenceRoot()) {
	if (!root) return null;
	let ledger;
	try { ledger = JSON.parse(readFile(path.join(root, key, "status.json"))); } catch { return null; }
	const videos = (ledger.handoffs || []).filter((h) => h && h.who === "video");
	return videos.length ? videos[videos.length - 1] : null;
}

const blocks = (entry) => (typeof entry.message?.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message?.content || []);

// True when `quote` is in a message the owner wrote in this session (not meta, not a subagent's).
function ownerSaid(quote, transcript) {
	const want = String(quote || "").trim().toLowerCase();
	if (!want) return false;
	for (const line of String(transcript || "").split("\n")) {
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== "user" || entry.isSidechain || entry.isMeta) continue;
		if (blocks(entry).some((b) => b.type === "text" && String(b.text || "").toLowerCase().includes(want))) return true;
	}
	return false;
}

const reason = (key, where) =>
	`video-lock: ${key} already has its demo video (${where}). The video is made once, for the first PR, and is kept on every revision. ` +
	"A new one needs the owner's own words: `new video: yes, owner: \"<words>\"` in the sous-video prompt, or NEW_VIDEO_OWNER=\"<words>\" " +
	"on the demo-upload command, with words the owner wrote in this session. Skip the video section and reuse the existing link.";

// deps: { readFile, readTranscript, root } for tests.
function checkAgent(input, transcriptPath, deps = {}) {
	if (String(input?.subagent_type || "") !== "sous-video") return null;
	const prompt = String(input.prompt || "");
	const key = (prompt.match(/\bKEY\s*[=:]\s*([A-Z][A-Z0-9]+-\d+)/) || prompt.match(KEY) || [])[1];
	if (!key) return null;
	const last = lastVideo(key, deps.readFile, deps.root);
	if (!last || last.status !== "done") return null;
	const quote = (prompt.match(OWNER_LINE) || [])[1];
	const read = deps.readTranscript || ((f) => fs.readFileSync(f, "utf8"));
	let transcript = "";
	try { transcript = transcriptPath ? read(transcriptPath) : ""; } catch {}
	return quote && ownerSaid(quote, transcript) ? null : reason(key, last.where || last.evidence || "video handoff done");
}

function checkCommand(command, transcriptPath, deps = {}) {
	const m = String(command || "").match(UPLOAD);
	if (!m) return null;
	const key = m[1];
	const last = lastVideo(key, deps.readFile, deps.root);
	if (!last || last.status !== "done") return null;
	const q = String(command).match(UPLOAD_OWNER);
	const quote = q ? q[1] || q[2] : null;
	const read = deps.readTranscript || ((f) => fs.readFileSync(f, "utf8"));
	let transcript = "";
	try { transcript = transcriptPath ? read(transcriptPath) : ""; } catch {}
	return quote && ownerSaid(quote, transcript) ? null : reason(key, last.where || last.evidence || "video handoff done");
}

module.exports = { checkAgent, checkCommand, lastVideo, ownerSaid };
