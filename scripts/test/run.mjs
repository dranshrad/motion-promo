#!/usr/bin/env node
// Runs the test files one after another (they launch browsers and ffmpeg; running them in
// parallel only makes them slower and flakier). Works on Node >= 18.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()
  .filter((f) => !only.length || only.some((o) => f.includes(o)));
let failed = 0;
for (const f of files) {
  console.log(`\n### ${f}`);
  const r = spawnSync(process.execPath, ['--test', path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed.` : `\nAll ${files.length} test files passed.`);
process.exitCode = failed ? 1 : 0;
