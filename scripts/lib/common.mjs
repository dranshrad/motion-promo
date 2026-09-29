// motion-promo — shared helpers for the renderer, fetcher and doctor.
// MIT License, Copyright (c) 2026 motion-promo contributors.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = path.dirname(SCRIPTS_DIR);
export const TEMPLATE_DIR = path.join(SKILL_DIR, 'template');

// ------------------------------------------------------------------ errors
/** An expected failure with a user-facing message, an optional fix line and an exit code. */
export class UserError extends Error {
  constructor(message, { fix, code = 1 } = {}) {
    super(message);
    this.fix = fix;
    this.exitCode = code;
  }
}
export function fail(err) {
  if (err instanceof UserError) {
    console.error(`\nERROR: ${err.message}`);
    if (err.fix) console.error(`FIX:   ${err.fix}`);
    process.exitCode = err.exitCode;
  } else {
    console.error(`\nERROR: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ args
/**
 * Tiny argv parser. spec: { name: 'string' | 'boolean' | 'number' | 'list' }.
 * Supports --name value, --name=value, repeated --name for lists, and positionals.
 */
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (const [k, t] of Object.entries(spec)) if (t === 'list') out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [name, val] = a.slice(2).split(/=(.*)/s, 2);
    const type = spec[name];
    if (!type) throw new UserError(`unknown option --${name}`, { fix: 'run with --help to see the options', code: 2 });
    if (type === 'boolean') { out[name] = val == null ? true : !/^(0|false|no)$/i.test(val); continue; }
    if (val == null) {
      val = argv[++i];
      if (val == null) throw new UserError(`--${name} needs a value`, { code: 2 });
    }
    if (type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) throw new UserError(`--${name} must be a number (got "${val}")`, { code: 2 });
      out[name] = n;
    } else if (type === 'list') out[name].push(val);
    else out[name] = val;
  }
  return out;
}

// ------------------------------------------------------------------ tools
function tryExec(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000 });
    if (r.error) return null;
    return r;
  } catch {
    return null;
  }
}
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];
/** Locate ffmpeg/ffprobe: env override, PATH, then common install dirs. */
export function findTool(name) {
  const envName = `MOTION_PROMO_${name.toUpperCase()}`;
  if (process.env[envName]) return process.env[envName];
  const r = tryExec(name, ['-version']);
  if (r && r.status === 0) return name;
  for (const d of EXTRA_BIN_DIRS) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export const FFMPEG_HINT =
  'install ffmpeg — macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt-get install -y ffmpeg`; or set MOTION_PROMO_FFMPEG=/path/to/ffmpeg (and MOTION_PROMO_FFPROBE).';

export function requireFfmpeg() {
  const ffmpeg = findTool('ffmpeg');
  const ok = ffmpeg && tryExec(ffmpeg, ['-hide_banner', '-version']);
  if (!ok || ok.status !== 0) {
    throw new UserError(`ffmpeg not found or not runnable${ffmpeg ? ` (${ffmpeg})` : ''}.`, { fix: FFMPEG_HINT, code: 2 });
  }
  const ffprobe = findTool('ffprobe');
  const okp = ffprobe && tryExec(ffprobe, ['-hide_banner', '-version']);
  if (!okp || okp.status !== 0) {
    throw new UserError(`ffprobe not found or not runnable${ffprobe ? ` (${ffprobe})` : ''}.`, { fix: FFMPEG_HINT, code: 2 });
  }
  return { ffmpeg, ffprobe };
}

// ------------------------------------------------------------------ browser
export function loadPlaywright() {
  const require = createRequire(path.join(SCRIPTS_DIR, 'package.json'));
  try {
    return require('playwright-core');
  } catch {
    throw new UserError('npm dependency playwright-core is not installed.', {
      fix: `cd "${SCRIPTS_DIR}" && npm ci   (or npm install)`,
      code: 2,
    });
  }
}
function browserCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (process.platform === 'win32') {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return pf.map((p) => path.join(p, 'Google/Chrome/Application/chrome.exe'));
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  ];
}
/**
 * Ordered browser candidates, each {path, source}:
 *   1. MOTION_PROMO_BROWSER / CHROME_PATH — an explicit choice, used alone (no silent fallback)
 *   2. the shared Chromium recorded by install-all-users.sh (.browser-path) — the admin's choice
 *   3. installed system browsers
 *   4. this account's Playwright Chromium download
 */
export function findBrowsers(pw) {
  const env = process.env.MOTION_PROMO_BROWSER || process.env.CHROME_PATH;
  if (env) return [{ path: env, source: 'MOTION_PROMO_BROWSER' }];
  const out = [];
  const add = (p, source) => { if (p && fs.existsSync(p) && !out.some((c) => c.path === p)) out.push({ path: p, source }); };
  try { add(fs.readFileSync(path.join(SKILL_DIR, '.browser-path'), 'utf8').trim(), 'shared (.browser-path)'); } catch { /* none recorded */ }
  for (const p of browserCandidates()) add(p, 'installed');
  try { add(pw.chromium.executablePath(), 'playwright'); } catch { /* not downloaded */ }
  return out;
}
/** Returns the first {path, source} candidate, or null. */
export function findBrowser(pw) {
  return findBrowsers(pw)[0] || null;
}

export const BROWSER_FIX =
  'install Google Chrome, or download Playwright Chromium: `cd "' + SCRIPTS_DIR + '" && npx playwright-core install chromium` ' +
  '(Linux servers also: `sudo npx playwright-core install-deps chromium`), or set MOTION_PROMO_BROWSER=/path/to/chrome.';

export const BROWSER_ARGS = [
  '--allow-file-access-from-files',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--mute-audio',
  // Software raster: measured to make frames independent of render history (GPU raster left
  // off-by-one antialiasing that differed between sequential and --jobs rendering) and it is
  // what headless Linux servers use anyway, so output matches across machines more closely.
  '--disable-gpu',
  ...(process.env.MOTION_PROMO_BROWSER_ARGS ? process.env.MOTION_PROMO_BROWSER_ARGS.split(/\s+/).filter(Boolean) : []),
];
// Drop inherited temp/XDG paths this account cannot write (cron, systemd, `sudo -u` often pass
// another account's). Chromium otherwise fails with "Failed to create headless user data
// directory container".
function sanitizeInheritedEnv() {
  const dropped = [];
  for (const k of ['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    const v = process.env[k];
    if (!v) continue;
    try { fs.accessSync(v, fs.constants.W_OK); } catch { delete process.env[k]; dropped.push(k); }
  }
  if (dropped.length && !process.env.MOTION_PROMO_QUIET_ENV) {
    process.stderr.write(`note: ignoring ${dropped.join(', ')} (not writable by this account)\n`);
    process.env.MOTION_PROMO_QUIET_ENV = '1';
  }
}
export async function launchBrowser() {
  sanitizeInheritedEnv();
  const pw = loadPlaywright();
  const candidates = findBrowsers(pw);
  if (!candidates.length) throw new UserError('no Chromium-family browser found.', { fix: BROWSER_FIX, code: 2 });
  const args = BROWSER_ARGS.slice();
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  // A browser that is present but broken for this account (e.g. a system Edge whose crash
  // handler cannot start) must not block the others: try each candidate in order.
  const failures = [];
  const missing = candidates.filter((c) => !fs.existsSync(c.path));
  if (missing.length === candidates.length) {
    const c = candidates[0];
    throw new UserError(`browser not found at ${c.path} (from ${c.source}).`, { fix: BROWSER_FIX, code: 2 });
  }
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) { failures.push(`${c.path} (${c.source}): not found`); continue; }
    try {
      const browser = await pw.chromium.launch({ executablePath: c.path, headless: true, args, timeout: 60000 });
      if (failures.length) process.stderr.write(`note: skipped ${failures.length} browser(s) that failed to launch; using ${c.path}\n`);
      return { browser, browserPath: c.path };
    } catch (e) {
      failures.push(`${c.path} (${c.source}):\n    ` + String(e.message || e).split('\n').slice(0, 4).join('\n    '));
    }
  }
  throw new UserError(`no browser could be launched:\n  ${failures.join('\n  ')}`, {
    fix: process.platform === 'linux'
      ? 'install system libraries: `sudo npx playwright-core install-deps chromium` (in scripts/), or run install.sh --with-deps; or set MOTION_PROMO_BROWSER'
      : BROWSER_FIX,
    code: 2,
  });
}

// ------------------------------------------------------------------ paths & names
export const fileUrl = (p) => pathToFileURL(path.resolve(p)).href;
export function slug(s, fallback = 'promo') {
  const v = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss').replace(/[đĐð]/g, 'd')
    .replace(/[łŁ]/g, 'l').replace(/[þÞ]/g, 'th').replace(/[œŒ]/g, 'oe')
    .replace(/\[|\]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return v || fallback;
}
/** Next free "<base>-vN.mp4" in dir. */
export function nextVersion(dir, base, ext = '.mp4') {
  let max = 0;
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-v(\\d+)' + ext.replace('.', '\\.') + '$');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { const m = f.match(re); if (m) max = Math.max(max, +m[1]); }
  return path.join(dir, `${base}-v${max + 1}${ext}`);
}
/** For an explicit path that exists: name.mp4 -> name-v2.mp4; name-v3.mp4 -> name-v4.mp4 (first free). */
export function bumpVersion(p) {
  const dir = path.dirname(p), ext = path.extname(p) || '.mp4';
  let stem = path.basename(p, ext);
  let n = 2;
  const m = stem.match(/^(.*)-v(\d+)$/);
  if (m) { stem = m[1]; n = +m[2] + 1; }
  let cand;
  do { cand = path.join(dir, `${stem}-v${n++}${ext}`); } while (fs.existsSync(cand));
  return cand;
}
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ------------------------------------------------------------------ facts check
const MULT = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
/** Numbers appearing in text, with k/m/bn expansions. "12,400+" -> [12400]; "10k" -> [10, 10000]. */
export function numbersIn(text) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?|\.\d+)\s?(bn|[kmb])?(?![a-z])/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    const raw = m[1].replace(/,(?=\d{3}\b)/g, '').replace(/,/g, '');
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    const vals = [v];
    const suf = (m[2] || '').toLowerCase();
    if (MULT[suf]) vals.push(v * MULT[suf]);
    out.push({ token: m[0].trim(), vals });
  }
  return out;
}
export function checkClaimsAgainstFacts(claims, factsText) {
  const factVals = new Set();
  for (const n of numbersIn(factsText)) for (const v of n.vals) factVals.add(Number(v.toPrecision(12)));
  const mismatches = [];
  for (const c of claims) {
    for (const n of numbersIn(c.text)) {
      const hit = n.vals.some((v) => factVals.has(Number(v.toPrecision(12))));
      if (!hit) mismatches.push({ claim: c.text, number: n.token });
    }
  }
  return mismatches;
}
