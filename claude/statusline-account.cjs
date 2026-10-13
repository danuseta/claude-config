// Prefix the kit statusline with the logged-in account so the active profile is always visible.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const input = fs.readFileSync(0);
const account = JSON.parse(fs.readFileSync(path.join(__dirname, '.claude.json'), 'utf8')).oauthAccount.emailAddress;
const kit = spawnSync(process.execPath, [path.join(__dirname, 'kit', 'statusline.cjs')], { input });
process.stdout.write(`\x1b[7m ${account} \x1b[0m ${kit.stdout}`);
