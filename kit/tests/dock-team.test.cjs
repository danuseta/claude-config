"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const KIT = path.join(__dirname, "..");
const SNOWFLAKE = /^\d{15,25}$/;

test("dock-team.json names the team's Discord server and forums with ids DOCK accepts", () => {
	const team = JSON.parse(fs.readFileSync(path.join(KIT, "dock-team.json"), "utf8"));
	assert.match(team.discord.guild, SNOWFLAKE);
	assert.ok(team.discord.channels.length > 0);
	for (const channel of team.discord.channels) {
		assert.match(channel.id, SNOWFLAKE, `${channel.name} id`);
		assert.ok(["bug", "uat", "pr", "follow"].includes(channel.kind), `${channel.name} kind`);
	}
	assert.strictEqual(new Set(team.discord.channels.map((channel) => channel.id)).size, team.discord.channels.length, "no forum twice");
});

test("the DOCK service gets the team file only when the kit has it", () => {
	const lib = fs.readFileSync(path.join(KIT, "..", "linux", "lib.sh"), "utf8");
	assert.match(lib, /if \[ -f "\$CCFG_CLAUDE_DIR\/kit\/dock-team\.json" \]; then export DOCK_TEAM_FILE="\$CCFG_CLAUDE_DIR\/kit\/dock-team\.json"; fi/);
});
