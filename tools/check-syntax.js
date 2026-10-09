#!/usr/bin/env node
/**
 * Syntax-check every game script with `node --check` (catches typos and
 * broken edits without starting a browser).
 *
 *   npm run check
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

const files = [...walk(path.join(root, 'js')), ...walk(path.join(root, 'tests')), path.join(root, 'sw.js')];
let failed = 0;
for (const f of files) {
    try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
        failed++;
        console.error(`✗ ${path.relative(root, f)}\n${e.stderr.toString()}`);
    }
}
console.log(failed ? `${failed} of ${files.length} files failed` : `✓ ${files.length} files OK`);
process.exit(failed ? 1 : 0);
