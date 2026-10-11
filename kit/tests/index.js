'use strict';
// `node --test kit/tests` hands the folder to node as a module path; this file runs every *.test.cjs in it.
const fs = require('fs');
const path = require('path');
for (const f of fs.readdirSync(__dirname).sort()) if (/\.test\.cjs$/.test(f)) require(path.join(__dirname, f));
