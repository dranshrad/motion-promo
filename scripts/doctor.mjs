#!/usr/bin/env node
// motion-promo doctor: check every runtime dependency and print one fix line per failure.
// MIT License, Copyright (c) 2026 motion-promo contributors.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SCRIPTS_DIR, TEMPLATE_DIR, FFMPEG_HINT, BROWSER_FIX, findTool, loadPlaywright, launchBrowser, UserError,
} from './lib/common.mjs';

const results = [];
const ok = (name, detail) => { results.push({ ok: true, name, detail }); console.log(`  ok    ${name}${detail ? ' — ' + detail : ''}`); };
const bad = (name, detail, fix) => { results.push({ ok: false, name, detail, fix }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}\n        fix: ${fix}`); };

async function main() {
  console.log('motion-promo doctor\n');
  // node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok('node', `v${process.versions.node}`);
  else bad('node', `v${process.versions.node} (need >= 18)`, 'install Node 18 or newer (https://nodejs.org or your package manager)');

  // npm deps
  let pw = null;
  try {
    pw = loadPlaywright();
    const v = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'node_modules/playwright-core/package.json'), 'utf8')).version;
    ok('npm: playwright-core', v);
  } catch (e) {
    bad('npm: playwright-core', 'not installed', `cd "${SCRIPTS_DIR}" && npm ci`);
  }

  // template files
  const missing = ['index.html', 'engine.js', 'scenes.js', 'main.js', 'promo.css', 'promo.config.js'].filter((f) => !fs.existsSync(path.join(TEMPLATE_DIR, f)));
  if (missing.length) bad('template', `missing ${missing.join(', ')}`, 'reinstall the skill (install.sh)');
  else ok('template', TEMPLATE_DIR);

  // ffmpeg + libx264
  const ffmpeg = findTool('ffmpeg');
  const fr = ffmpeg && spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 20000 });
  if (!fr || fr.error || fr.status !== 0) bad('ffmpeg', ffmpeg ? `${ffmpeg} did not run` : 'not found', FFMPEG_HINT);
  else {
    const ver = (spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout || '').split('\n')[0];
    if (/\blibx264\b/.test(fr.stdout)) ok('ffmpeg + libx264', `${ver} (${ffmpeg})`);
    else bad('ffmpeg + libx264', `${ver} has no libx264 encoder`, 'install a full ffmpeg build — macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt-get install -y ffmpeg` (includes libx264)');
    // encode smoke test
    const enc = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
    if (enc.status === 0) ok('ffmpeg encode', 'libx264 yuv420p smoke test passed');
    else bad('ffmpeg encode', (enc.stderr || '').trim().split('\n').pop(), 'reinstall ffmpeg with libx264');
  }
  const ffprobe = findTool('ffprobe');
  const pr = ffprobe && spawnSync(ffprobe, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20000 });
  if (!pr || pr.error || pr.status !== 0) bad('ffprobe', ffprobe ? `${ffprobe} did not run` : 'not found', FFMPEG_HINT);
  else ok('ffprobe', ffprobe);

  // browser launch + 3D transform / animation render
  if (pw) {
    let browser = null;
    try {
      const t0 = Date.now();
      const l = await launchBrowser();
      browser = l.browser;
      ok('browser launch', `${l.browserPath} (${browser.version()}, ${Date.now() - t0} ms)`);
      const page = await browser.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><style>html,body{margin:0;background:#fff}
        #s{position:absolute;inset:0;perspective:400px}
        #b{position:absolute;left:50px;top:50px;width:100px;height:100px;background:#e00;transform-origin:50% 50%}</style>
        <div id="s"><div id="b"></div></div>
        <script>window.seek=(t)=>{document.getElementById('b').style.transform='rotateY('+(t*60)+'deg) translateX('+(t*30)+'px)';}</script>`);
      const px = async (t) => {
        await page.evaluate((x) => window.seek(x), t);
        const buf = await page.screenshot({ type: 'png' });
        return buf;
      };
      const a1 = await px(0), b1 = await px(1), a2 = await px(0);
      const redAt = async (x, y) => page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el && el.id === 'b';
      }, [x, y]);
      await page.evaluate(() => window.seek(1));
      const moved = !(await redAt(55, 100)); // left edge area uncovered after rotateY + translate
      if (!a1.equals(b1) && a1.equals(a2) && moved) ok('render: 3D transform + seek', 'frames change with t and repeat exactly');
      else bad('render: 3D transform + seek', `changed=${!a1.equals(b1)} repeat=${a1.equals(a2)} moved=${moved}`, 'update Chrome/Chromium; on Linux install system libs (install.sh --with-deps)');
    } catch (e) {
      if (e instanceof UserError) bad('browser launch', e.message.split('\n')[0], e.fix || BROWSER_FIX);
      else bad('browser launch', String(e.message || e).split('\n')[0], BROWSER_FIX);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  } else {
    bad('browser launch', 'skipped (playwright-core missing)', `cd "${SCRIPTS_DIR}" && npm ci`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
