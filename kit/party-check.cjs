'use strict';
// The only way a runner reads a ticket's Party. A "## Party" block counts only when the newest Guild Master entry of type party for
// that ticket is the entry the block names (log #N), it was not rolled back, its signed lines equal the block, and DOCK confirms the
// entry's signature with the key only DOCK holds. Anything else, an unreachable DOCK included, is NO-PARTY and the ticket runs full.
//   node party-check.cjs <KEY>   -> PARTY mode=light worker=<model> log=<n> | PARTY mode=full log=<n> | NO-PARTY: <why>
const { createGm } = require("./gm.cjs");

async function partyCheck(key, { gm = createGm(), verify = async (entry) => {
	const r = await require("./dock-push.cjs").send("/chat/gm/verify", { entry }, 10000);
	return Boolean(r && r.status === 200 && r.result && r.result.valid === true);
} } = {}) {
	let block;
	try { block = gm.partyBlock(key); } catch (e) { return `NO-PARTY: ${e.message}`; }
	if (!block) return "NO-PARTY: the Contract has no Party block";
	const fields = gm.partyFields(block);
	if (!fields.mode || fields.log === null) return "NO-PARTY: the Party block was not written by Guild Master";
	const rows = gm.entries();
	const rolled = new Set(rows.filter((e) => Number.isInteger(e.rollbackOf)).map((e) => e.rollbackOf));
	const newest = rows.filter((e) => e.type === "party" && e.kind === "change" && e.ticket === key && !rolled.has(e.id)).sort((a, b) => b.id - a.id)[0];
	if (!newest || newest.id !== fields.log) return `NO-PARTY: log #${fields.log} is not the newest Party Guild Master wrote for ${key}`;
	if (!Array.isArray(newest.party) || JSON.stringify(newest.party) !== JSON.stringify(block)) return `NO-PARTY: the block differs from what log #${newest.id} wrote`;
	let valid = false;
	try { valid = await verify(newest); } catch {}
	if (!valid) return `NO-PARTY: DOCK did not confirm the signature of log #${newest.id}`;
	return fields.mode === "light" ? `PARTY mode=light worker=${fields.worker || "sonnet"} log=${newest.id}` : `PARTY mode=full log=${newest.id}`;
}

module.exports = { partyCheck };

if (require.main === module) {
	partyCheck(String(process.argv[2] || "")).then((line) => process.stdout.write(`${line}\n`), (e) => process.stdout.write(`NO-PARTY: ${String(e.message || e).slice(0, 200)}\n`));
}
