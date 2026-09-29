#!/usr/bin/env node
// motion-promo init: create a project directory (config + assets + preview link).
// MIT License, Copyright (c) 2026 motion-promo contributors.
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATE_DIR, SCRIPTS_DIR, UserError, fail, parseArgs, fileUrl } from './lib/common.mjs';

const HELP = `motion-promo init

Usage: node init.mjs DIR [--force]

Creates in DIR:
  promo.config.js   the starter config (the only file you edit)
  assets/           put real images here (paths in the config are relative to the config)
  preview.html      open in Chrome to preview; it loads the skill's page with this config
The composition page itself stays inside the skill, so projects never run a stale engine.
An existing promo.config.js is never overwritten; --force only rewrites preview.html.`;

function previewHtml(pageUrl) {
  return `<!doctype html>
<meta charset="utf-8">
<title>motion-promo preview</title>
<!-- Opens the motion-promo page with the promo.config.js next to this file.
     Re-run init.mjs --force if the skill moved. -->
<script>
  var cfg = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, 'promo.config.js');
  var page = ${JSON.stringify(pageUrl)};
  location.replace(page + '?config=' + encodeURIComponent(cfg) + (location.search ? '&' + location.search.slice(1) : ''));
</script>
<p>Redirecting to the motion-promo page… If nothing happens, open <code>${pageUrl.replace(/</g, '&lt;')}</code>.</p>
`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2), { force: 'boolean', help: 'boolean' });
  if (opts.help || !opts._[0]) { console.log(HELP); if (!opts._[0] && !opts.help) process.exitCode = 2; return; }
  const dir = path.resolve(opts._[0]);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const cfg = path.join(dir, 'promo.config.js');
  if (fs.existsSync(cfg)) {
    if (!opts.force) throw new UserError(`${cfg} already exists — not touching it.`, { fix: 'use --force to rewrite only preview.html', code: 2 });
  } else {
    fs.copyFileSync(path.join(TEMPLATE_DIR, 'promo.config.js'), cfg);
  }
  fs.writeFileSync(path.join(dir, 'preview.html'), previewHtml(fileUrl(path.join(TEMPLATE_DIR, 'index.html'))));
  const render = path.join(SCRIPTS_DIR, 'render.mjs');
  console.log(`motion-promo project ready: ${dir}`);
  console.log(`  edit      ${cfg}`);
  console.log(`  assets    ${path.join(dir, 'assets')}${path.sep}`);
  console.log(`  preview   open ${path.join(dir, 'preview.html')} in Chrome`);
  console.log(`  stills    node "${render}" "${dir}" --stills auto`);
}
try { main(); } catch (e) { fail(e); }
