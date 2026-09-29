#!/usr/bin/env node
// motion-promo renderer: stills + contact sheet, or a frame-exact H.264 MP4.
// MIT License, Copyright (c) 2026 motion-promo contributors.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  UserError, fail, parseArgs, requireFfmpeg, launchBrowser, fileUrl, slug, nextVersion, bumpVersion,
  fmtBytes, checkClaimsAgainstFacts, TEMPLATE_DIR,
} from './lib/common.mjs';

const HELP = `motion-promo render

Usage:
  node render.mjs [PROJECT_DIR] [options]

PROJECT_DIR holds promo.config.js and assets/ (create one with init.mjs). Default: current dir.

Modes:
  --stills auto|t1,t2,...   write PNG stills + ONE contact sheet (auto = settled + mid-transition per scene)
  (no --stills)             render the MP4

Options:
  --config FILE      config file to render (A/B variants); default PROJECT_DIR/promo.config.js
  --format F         override format: 4:5 | 9:16 | 1:1 | 16:9
  --out FILE         output MP4 path (default PROJECT_DIR/out/<brand>-<topic>-<format>-vN.mp4)
  --force            overwrite --out if it exists
  --auto-version     if --out exists, write -v2, -v3 ... instead
  --draft            allowed with open issues; burns a DRAFT mark into every frame
  --fps N            frames per second (default: config fps or 30)
  --audio FILE       add an audio track (trimmed to length, short fade-out)
  --audio-fade S     fade-out length in seconds (default 0.6)
  --jobs N           parallel browser pages rendering frames (default 1)
  --crf N            x264 quality (default 18; lower = better)
  --stills-dir DIR   where stills go (default PROJECT_DIR/stills)
  --facts FILE       facts.txt from fetch.mjs (default: auto-detected next to the config)
  --quiet            less progress output
Exit codes: 0 ok · 1 render failed · 2 environment/usage problem · 3 refused (issues or unsourced claims)`;

const SPEC = {
  stills: 'string', config: 'string', format: 'string', out: 'string', force: 'boolean', 'auto-version': 'boolean',
  draft: 'boolean', fps: 'number', audio: 'string', 'audio-fade': 'number', jobs: 'number', crf: 'number',
  'stills-dir': 'string', facts: 'string', quiet: 'boolean', help: 'boolean', 'ready-timeout': 'number',
};
const FORMATS = ['4:5', '9:16', '1:1', '16:9'];
const STALL_MS = Number(process.env.MOTION_PROMO_STALL_MS) || 60000;
// debug aid: write every piped frame as PNG into this directory
const DUMP = process.env.MOTION_PROMO_DUMP_FRAMES || null;

const cleanup = { browser: null, ffmpeg: null, tmp: null, extra: [] };
/** Kill ffmpeg and anything it spawned (it runs in its own process group). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch {} }
}
/** Drop our ends of the child's pipes so a lingering grandchild cannot keep Node alive. */
function releaseChild(child) {
  for (const s of [child.stdin, child.stdout, child.stderr]) { try { s && s.destroy(); } catch {} }
  try { child.unref(); } catch {}
}
async function doCleanup() {
  if (cleanup.ffmpeg) { killTree(cleanup.ffmpeg); releaseChild(cleanup.ffmpeg); }
  if (cleanup.tmp) { try { fs.rmSync(cleanup.tmp, { force: true }); } catch {} }
  for (const b of cleanup.extra.splice(0)) await b.close().catch(() => {});
  if (cleanup.browser) { const b = cleanup.browser; cleanup.browser = null; await b.close().catch(() => {}); }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { console.error(`\n${sig} — stopping.`); await doCleanup(); process.exit(130); });
}

function resolveProject(opts) {
  const arg = opts._[0] ? path.resolve(opts._[0]) : process.cwd();
  let projectDir = arg;
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) projectDir = path.dirname(arg);
  if (!fs.existsSync(projectDir)) throw new UserError(`project directory not found: ${projectDir}`, { code: 2 });
  const config = opts.config ? path.resolve(opts.config) : path.join(projectDir, 'promo.config.js');
  if (!fs.existsSync(config)) {
    throw new UserError(`config not found: ${config}`, { fix: `create a project with: node "${path.join(path.dirname(new URL(import.meta.url).pathname), 'init.mjs')}" ${projectDir}`, code: 2 });
  }
  // Always the skill's own page: projects hold only config + assets, so they never run a stale engine.
  const page = path.join(TEMPLATE_DIR, 'index.html');
  return { projectDir, config, page };
}

function findFacts(opts, proj) {
  if (opts.facts) {
    if (!fs.existsSync(opts.facts)) throw new UserError(`facts file not found: ${opts.facts}`, { code: 2 });
    return path.resolve(opts.facts);
  }
  const cdir = path.dirname(proj.config);
  const cands = [
    path.join(cdir, 'assets/fetched/facts.txt'), path.join(cdir, 'fetched/facts.txt'), path.join(cdir, 'facts.txt'),
    path.join(proj.projectDir, 'assets/fetched/facts.txt'), path.join(proj.projectDir, 'facts.txt'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

async function openPage(browser, proj, opts, viewport) {
  const url = new URL(fileUrl(proj.page));
  url.searchParams.set('capture', '1');
  if (opts.draft) url.searchParams.set('draft', '1');
  if (opts.format) url.searchParams.set('format', opts.format);
  url.searchParams.set('config', fileUrl(proj.config));
  const SIZES = { '4:5': [1080, 1350], '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
  if (!viewport) { const z = SIZES[opts.format] || SIZES['4:5']; viewport = { width: z[0], height: z[1] }; }
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith('file:')) errors.push(`failed to load ${decodeURIComponent(u)} (${r.failure() && r.failure().errorText})`);
  });
  await page.goto(url.href, { waitUntil: 'load', timeout: 60000 });
  const hasPromo = await page.waitForFunction(() => window.promo && window.promo.ready, null, { timeout: 15000 }).then(() => true, () => false);
  if (!hasPromo) throw new UserError(`the page does not expose window.promo (${proj.page}). ${errors.join('; ')}`, { code: 1 });
  const readyMs = (opts['ready-timeout'] || 120) * 1000;
  const info = await Promise.race([
    page.evaluate(async () => {
      await window.promo.ready;
      const p = window.promo;
      return { duration: p.duration, size: p.size, fps: p.fps, format: p.format, issues: p.issues, warnings: p.warnings, claims: p.claims, timeline: p.timeline, errors: p.errors, version: p.version };
    }),
    new Promise((_, rej) => setTimeout(() => rej(new UserError(`page did not become ready within ${readyMs / 1000} s. ${errors.join('; ')}`)), readyMs).unref()),
  ]);
  const size = info.size;
  if (!viewport || viewport.width !== size.width || viewport.height !== size.height) {
    await page.setViewportSize({ width: size.width, height: size.height });
  }
  info.pageErrors = errors;
  return { page, context, info };
}

const cdpSessions = new WeakMap();
/** Seek, then capture the viewport through CDP (a fresh compositor frame; ~3x faster than page.screenshot). */
async function shoot(page, t) {
  await page.evaluate((tt) => window.promo.seek(tt), t);
  let cdp = cdpSessions.get(page);
  if (!cdp) { cdp = await page.context().newCDPSession(page); cdpSessions.set(page, cdp); }
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true });
  return Buffer.from(r.data, 'base64');
}

function report(info, opts, proj) {
  const q = opts.quiet;
  console.log(`\nmotion-promo · ${path.basename(proj.config)} · ${info.format} ${info.size.width}x${info.size.height} · ${info.duration.toFixed(2)} s · ${info.timeline.length} scenes`);
  const errs = [...(info.errors || []).map((e) => 'page: ' + e), ...info.pageErrors];
  if (errs.length) {
    console.log(`\nPage script errors (${errs.length}):`);
    for (const e of errs) console.log(`  ! ${e}`);
  }
  if (info.warnings.length) {
    console.log(`\nWarnings (${info.warnings.length}):`);
    for (const w of info.warnings) console.log(`  - ${w}`);
  }
  console.log(`\nIssues (${info.issues.length})${info.issues.length ? ' — a final render is refused until these are fixed:' : ':'}`);
  if (!info.issues.length) console.log('  none');
  for (const m of info.issues) console.log(`  x ${m}`);
  console.log(`\nClaims to verify (${info.claims.length}):`);
  if (!info.claims.length) console.log('  none');
  for (const c of info.claims) console.log(`  * "${c.text}" — source: ${c.source || 'MISSING'}`);
  const factsPath = findFacts(opts, proj);
  if (factsPath && info.claims.length) {
    const mism = checkClaimsAgainstFacts(info.claims, fs.readFileSync(factsPath, 'utf8'));
    if (mism.length) {
      console.log(`\nFacts check (${path.relative(process.cwd(), factsPath) || factsPath}) — numbers not found on the fetched page (verify by hand; formatting may differ):`);
      for (const m of mism) console.log(`  ? ${m.number} in "${m.claim}"`);
    } else console.log(`\nFacts check: every number in the claims appears in ${path.basename(factsPath)}.`);
  } else if (!factsPath && info.claims.length && !q) {
    console.log('\nFacts check: no facts.txt found (run fetch.mjs on the destination page to enable it).');
  }
}

// ------------------------------------------------------------------ stills
function stillTimes(spec, info) {
  const out = [];
  const dur = info.duration;
  if (spec === 'auto') {
    for (const s of info.timeline) {
      // a wipe is a solid colour at its exact midpoint, so sample it while the panels are still moving
      if (s.mid != null) out.push({ t: s.transition.type === 'wipe' ? s.start + s.transition.duration * 0.12 : s.mid, label: `${s.type} · ${s.transition.type} (mid-transition)`, kind: 'mid', scene: s.index });
      else out.push({ t: Math.min(s.start + Math.max(0.2, s.enter + 0.35), s.end - 0.05), label: `${s.type} · entering`, kind: 'mid', scene: s.index });
      out.push({ t: s.settle, label: `${s.type} · settled`, kind: 'settled', scene: s.index });
    }
    out.push({ t: Math.max(0, dur - 1 / 30), label: 'final frame', kind: 'final' });
  } else {
    for (const part of String(spec).split(',')) {
      const v = parseFloat(part.trim().replace(/s$/, ''));
      if (!Number.isFinite(v)) throw new UserError(`--stills: "${part}" is not a time in seconds`, { code: 2 });
      if (v < 0 || v > dur) throw new UserError(`--stills: ${v} s is outside 0–${dur.toFixed(2)} s`, { code: 2 });
      const sc = info.timeline.find((s) => v >= s.start && v < s.end) || info.timeline[info.timeline.length - 1];
      out.push({ t: v, label: sc ? sc.type : '', kind: 'user' });
    }
  }
  return out;
}

async function renderStills(browser, proj, opts, first) {
  const { page, info } = first;
  const dir = path.resolve(opts['stills-dir'] || path.join(proj.projectDir, 'stills'));
  fs.mkdirSync(dir, { recursive: true });
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (/^still-.*\.png$/.test(f) || f === 'contact-sheet.png' || f === '.contact-sheet.html') { fs.rmSync(path.join(dir, f), { force: true }); removed++; }
  }
  const times = stillTimes(opts.stills, info);
  const files = [];
  let i = 0;
  for (const s of times) {
    i++;
    const name = `still-${String(i).padStart(2, '0')}-t${s.t.toFixed(2)}${s.label ? '-' + slug(s.label.split(' · ')[0]) : ''}${s.kind ? '-' + s.kind : ''}.png`;
    const buf = await shoot(page, s.t, 'png');
    fs.writeFileSync(path.join(dir, name), buf);
    files.push({ ...s, name });
  }
  const sheet = await contactSheet(browser, dir, files, info, proj, opts);
  console.log(`\nStills: ${files.length} written to ${dir}${removed ? ` (removed ${removed} from the previous run)` : ''}`);
  console.log(`Contact sheet: ${sheet}`);
  return { dir, files, sheet };
}

async function contactSheet(browser, dir, files, info, proj, opts) {
  const { width: W, height: H } = info.size;
  const cols = W > H ? 3 : files.length > 8 ? 5 : 4;
  const tileW = W > H ? 520 : 360;
  const tileH = Math.round((tileW * H) / W);
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const tiles = files.map((f, i) => `
    <figure><img src="${esc(encodeURIComponent(f.name))}" width="${tileW}" height="${tileH}">
    <figcaption><b>${f.t.toFixed(2)} s</b><span>${i + 1}. ${esc(f.label)}</span></figcaption></figure>`).join('');
  const nIssues = info.issues.length;
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;background:#121216;color:#e8e8ee;font:14px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px;width:${cols * (tileW + 20) + 28}px}
    header{display:flex;gap:16px;align-items:baseline;margin:0 0 18px;flex-wrap:wrap} h1{font-size:18px;margin:0} .m{opacity:.7}
    .bad{color:#ff9aa5} .ok{color:#9fe3b5}
    main{display:grid;grid-template-columns:repeat(${cols},${tileW}px);gap:20px}
    figure{margin:0} img{display:block;border-radius:6px;background:#222;box-shadow:0 0 0 1px #2c2c33}
    figcaption{display:flex;gap:10px;padding:7px 2px 0;font-size:13px} figcaption b{font-variant-numeric:tabular-nums;color:#fff} figcaption span{opacity:.75}
  </style><header><h1>${esc(path.basename(proj.config))} · ${esc(info.format)} ${W}×${H}</h1>
  <span class="m">${info.duration.toFixed(2)} s · ${info.timeline.length} scenes${opts.draft ? ' · DRAFT' : ''}</span>
  <span class="${nIssues ? 'bad' : 'ok'}">${nIssues ? nIssues + ' issue(s) open' : 'no issues'}</span></header><main>${tiles}</main>`;
  const htmlPath = path.join(dir, '.contact-sheet.html');
  fs.writeFileSync(htmlPath, html);
  const ctx = await browser.newContext({ viewport: { width: cols * (tileW + 20) + 28, height: 600 }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.goto(fileUrl(htmlPath), { waitUntil: 'load' });
  await pg.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  const out = path.join(dir, 'contact-sheet.png');
  await pg.screenshot({ path: out, fullPage: true });
  await ctx.close();
  fs.rmSync(htmlPath, { force: true });
  return out;
}

// ------------------------------------------------------------------ video
function resolveOutput(opts, proj, info) {
  if (opts.out) {
    let p = path.resolve(opts.out);
    if (!/\.mp4$/i.test(p)) p += '.mp4';
    if (fs.existsSync(p)) {
      if (opts.force) return p;
      if (opts['auto-version']) return bumpVersion(p);
      throw new UserError(`output exists: ${p}`, { fix: 'delivered files are never overwritten — pass --auto-version (writes -v2, -v3 …), choose another --out, or --force', code: 2 });
    }
    return p;
  }
  const cfg = readConfigMeta(info);
  const base = `${slug(cfg.brand, 'brand')}-${slug(cfg.topic, 'promo')}-${info.format.replace(':', 'x')}${opts.draft ? '-draft' : ''}`;
  return nextVersion(path.join(proj.projectDir, 'out'), base);
}
function readConfigMeta(info) { return info.meta || { brand: 'brand', topic: 'promo' }; }

function probe(ffprobe, file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-count_packets', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_packets,duration:format=duration,size',
    '-of', 'json', file], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new UserError(`ffprobe could not read ${file}: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

async function renderVideo(browser, proj, opts, first) {
  const { info } = first;
  const tools = requireFfmpeg();
  const fps = opts.fps || info.fps || 30;
  if (!(fps > 0 && fps <= 120)) throw new UserError(`--fps must be between 1 and 120 (got ${fps})`, { code: 2 });
  const { width: W, height: H } = info.size;
  const N = Math.round(info.duration * fps);
  if (N < 1) throw new UserError('nothing to render: duration is 0', { code: 2 });
  if (opts.audio && !fs.existsSync(opts.audio)) throw new UserError(`audio file not found: ${opts.audio}`, { code: 2 });
  const out = resolveOutput(opts, proj, info);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = path.join(path.dirname(out), `.${path.basename(out, '.mp4')}.partial-${process.pid}.mp4`);
  cleanup.tmp = tmp;

  const jobs = Math.max(1, Math.min(8, Math.floor(opts.jobs || 1)));
  const pages = [first.page];
  // one browser process per extra job: pages inside one browser serialise on screenshot encoding
  for (let j = 1; j < jobs; j++) {
    const { browser: b } = await launchBrowser();
    cleanup.extra.push(b);
    const extra = await openPage(b, proj, opts, info.size);
    pages.push(extra.page);
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0'];
  if (opts.audio) args.push('-i', path.resolve(opts.audio));
  args.push('-map', '0:v:0');
  if (opts.audio) args.push('-map', '1:a:0');
  args.push('-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.crf != null ? opts.crf : 18), '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-frames:v', String(N));
  if (opts.audio) {
    const D = N / fps;
    const fade = Math.min(opts['audio-fade'] != null ? opts['audio-fade'] : 0.6, D);
    args.push('-c:a', 'aac', '-b:a', '192k', '-af', `atrim=0:${D.toFixed(3)},afade=t=out:st=${Math.max(0, D - fade).toFixed(3)}:d=${fade.toFixed(3)}`, '-t', D.toFixed(3));
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', tmp);

  const t0 = Date.now();
  let ff;
  try {
    ff = spawn(tools.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  } catch (e) {
    throw new UserError(`could not start ffmpeg (${tools.ffmpeg}): ${e.message}`, { fix: 'check the ffmpeg install', code: 2 });
  }
  cleanup.ffmpeg = ff;
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  let exited = null;
  const exitWaiters = [];
  const exitPromise = new Promise((resolve) => {
    ff.on('close', (code, signal) => { exited = { code, signal }; exitWaiters.splice(0).forEach((f) => f()); resolve(exited); });
    ff.on('error', (e) => { exited = { code: -1, signal: null, error: e }; exitWaiters.splice(0).forEach((f) => f()); resolve(exited); });
  });
  ff.stdin.on('error', () => { /* EPIPE etc. — reported through the exit status below */ });

  const ffDied = () => new UserError(
    `ffmpeg stopped during encoding (${exited && exited.error ? exited.error.message : `exit code ${exited && exited.code}${exited && exited.signal ? ', signal ' + exited.signal : ''}`}) after ${written} of ${N} frames.` +
    (stderr.trim() ? `\n  ffmpeg said: ${stderr.trim().split('\n').slice(-6).join('\n  ')}` : ''),
    { fix: 'check disk space and the ffmpeg build (needs libx264); run the doctor: node scripts/doctor.mjs' });

  let written = 0;
  async function writeFrame(buf) {
    if (exited) throw ffDied();
    const ok = ff.stdin.write(buf);
    if (ok) return;
    await new Promise((resolve, reject) => {
      let timer;
      const finish = (err) => { clearTimeout(timer); ff.stdin.off('drain', onDrain); err ? reject(err) : resolve(); };
      const onDrain = () => finish();
      ff.stdin.on('drain', onDrain);
      exitWaiters.push(() => finish(ffDied()));
      timer = setTimeout(() => {
        killTree(ff);
        finish(new UserError(`ffmpeg stopped reading frames for ${STALL_MS / 1000} s (after ${written} of ${N}) — killed it.`, { fix: 'run the doctor: node scripts/doctor.mjs' }));
      }, STALL_MS);
    });
  }

  // Ordered, bounded producer/consumer across `jobs` pages. Frame i is always time i/fps.
  const results = new Map();
  let nextFrame = 0, failed = null;
  let wakeWriter = null;
  const producerWaiters = [];
  const wakeProducers = () => producerWaiters.splice(0).forEach((f) => f());
  const ahead = jobs * 3;
  const producers = pages.map(async (pg) => {
    while (!failed) {
      while (!failed && nextFrame - written >= ahead) await new Promise((r) => producerWaiters.push(r));
      if (failed) return;
      const i = nextFrame++;
      if (i >= N) return;
      try {
        const buf = await shoot(pg, i / fps);
        if (DUMP) fs.writeFileSync(path.join(DUMP, `frame-${String(i).padStart(5, '0')}.png`), buf);
        results.set(i, buf);
      } catch (e) {
        failed = failed || e;
      }
      if (wakeWriter) { const w = wakeWriter; wakeWriter = null; w(); }
    }
  });
  const progressEvery = Math.max(1, Math.round(fps));
  let lastLine = 0;
  try {
    for (let i = 0; i < N; i++) {
      while (!results.has(i)) {
        if (failed) throw failed;
        if (exited) throw ffDied();
        await new Promise((r) => { wakeWriter = r; exitWaiters.push(r); });
      }
      const buf = results.get(i);
      results.delete(i);
      await writeFrame(buf);
      written++;
      wakeProducers();
      if (!opts.quiet && (written % progressEvery === 0 || written === N) && Date.now() - lastLine > 900) {
        lastLine = Date.now();
        const el = (Date.now() - t0) / 1000;
        process.stdout.write(`\r  frames ${written}/${N}  ${(written / el).toFixed(1)} fps  ${el.toFixed(1)} s   `);
      }
    }
  } catch (e) {
    failed = failed || e;
    wakeProducers();
    await Promise.allSettled(producers);
    try { ff.stdin.destroy(); } catch {}
    if (!exited) killTree(ff);
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000).unref())]);
    releaseChild(ff);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  await Promise.allSettled(producers);
  ff.stdin.end();
  const res = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 180000).unref())]);
  if (!opts.quiet) process.stdout.write('\n');
  if (res.code === 'timeout') { killTree(ff); releaseChild(ff); fs.rmSync(tmp, { force: true }); throw new UserError('ffmpeg did not finish within 180 s after the last frame.'); }
  if (res.code !== 0) { fs.rmSync(tmp, { force: true }); throw ffDied(); }

  // verify
  const pr = probe(tools.ffprobe, tmp);
  const v = (pr.streams || []).find((s) => s.codec_type === 'video');
  const a = (pr.streams || []).find((s) => s.codec_type === 'audio');
  const frames = v ? Number(v.nb_read_packets) : 0;
  const vdur = v && v.duration ? Number(v.duration) : frames / fps;
  const problems = [];
  if (!v) problems.push('no video stream');
  else {
    if (frames !== N) problems.push(`frame count ${frames} != expected ${N}`);
    if (Math.abs(vdur - N / fps) > 1 / fps + 1e-3) problems.push(`duration ${vdur.toFixed(3)} s != expected ${(N / fps).toFixed(3)} s`);
    if (v.width !== W || v.height !== H) problems.push(`size ${v.width}x${v.height} != ${W}x${H}`);
    if (v.codec_name !== 'h264') problems.push(`codec ${v.codec_name} != h264`);
    if (v.pix_fmt !== 'yuv420p') problems.push(`pix_fmt ${v.pix_fmt} != yuv420p`);
  }
  if (opts.audio && !a) problems.push('audio track missing');
  if (problems.length) {
    fs.rmSync(tmp, { force: true });
    throw new UserError(`ffprobe verification failed: ${problems.join('; ')}`);
  }
  if (fs.existsSync(out) && !opts.force) {
    // another process wrote it meanwhile — never overwrite
    const alt = bumpVersion(out);
    fs.renameSync(tmp, alt);
    cleanup.tmp = null;
    return finish(alt);
  }
  fs.renameSync(tmp, out);
  cleanup.tmp = null;
  return finish(out);

  function finish(file) {
    const size = fs.statSync(file).size;
    const el = (Date.now() - t0) / 1000;
    console.log(`\nRendered ${opts.draft ? 'DRAFT (review only — not for delivery)' : 'final'}:`);
    console.log(`  path      ${file}`);
    console.log(`  size      ${fmtBytes(size)}`);
    console.log(`  video     ${W}x${H} h264 yuv420p · ${frames} frames @ ${fps} fps · ${vdur.toFixed(3)} s${a ? ' · audio aac' : ''}`);
    console.log(`  verified  ffprobe frame count and duration match (${N} frames, ${(N / fps).toFixed(3)} s)`);
    console.log(`  elapsed   ${el.toFixed(1)} s (${jobs} job${jobs > 1 ? 's' : ''})`);
    return { file, frames, duration: vdur, size };
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2), SPEC);
  if (opts.help) { console.log(HELP); return; }
  if (opts.format && !FORMATS.includes(opts.format)) throw new UserError(`--format must be one of ${FORMATS.join(', ')} (got "${opts.format}")`, { code: 2 });
  if (opts.stills != null && opts.stills !== 'auto' && !/^[\d.,\ss]+$/.test(opts.stills)) {
    throw new UserError('--stills takes "auto" or a comma-separated list of seconds, e.g. --stills 0.5,2,4.25', { code: 2 });
  }
  const proj = resolveProject(opts);
  const videoMode = opts.stills == null;
  if (videoMode) requireFfmpeg(); // fail fast, before the browser starts

  const { browser } = await launchBrowser();
  cleanup.browser = browser;
  const first = await openPage(browser, proj, opts, null);
  const { info } = first;
  info.meta = await first.page.evaluate(() => {
    const c = window.PROMO_CONFIG || {};
    return { brand: (c.brand && c.brand.name) || 'brand', topic: c.topic || 'promo' };
  });
  const { width: W, height: H } = info.size;
  if (W % 2 || H % 2) {
    throw new UserError(`frame size ${W}x${H} has an odd dimension; H.264 yuv420p needs even width and height.`, { fix: 'use an even size (e.g. 1080x1350) or a named format', code: 2 });
  }
  report(info, opts, proj);

  if (!videoMode) {
    await renderStills(browser, proj, opts, first);
    return;
  }
  const unsourced = info.claims.filter((c) => !c.source);
  const pageErrs = [...(info.errors || []), ...info.pageErrors];
  if (!opts.draft && (info.issues.length || unsourced.length || pageErrs.length)) {
    const why = [];
    if (info.issues.length) why.push(`${info.issues.length} open issue(s)`);
    if (unsourced.length) why.push(`${unsourced.length} claim(s) without a source`);
    if (pageErrs.length) why.push(`${pageErrs.length} page script error(s)`);
    throw new UserError(`final render refused: ${why.join(', ')} (listed above).`, {
      fix: 'fix them in the config and re-run, or render a review copy with --draft (DRAFT mark burned in)',
      code: 3,
    });
  }
  await renderVideo(browser, proj, opts, first);
}

main()
  .catch(fail)
  .finally(async () => {
    await doCleanup();
  });
