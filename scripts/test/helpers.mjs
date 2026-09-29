// Test helpers: temp dirs, lavfi-generated images, configs, CLI runner. No network needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findTool, fileUrl, TEMPLATE_DIR } from '../lib/common.mjs';

export const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FFMPEG = findTool('ffmpeg');
export const FFPROBE = findTool('ffprobe');

const ROOT = fs.mkdtempSync(path.join(process.env.MOTION_PROMO_TEST_TMP || os.tmpdir(), 'motion-promo-test-'));
export function tmpDir(name) {
  const d = path.join(ROOT, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export function cleanupAll() {
  if (!process.env.MOTION_PROMO_KEEP_TEST_TMP) fs.rmSync(ROOT, { recursive: true, force: true });
}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
}
/** Generate distinct test images with lavfi (no network, no text rendering needed). */
export function makeImages(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  const gen = (name, src, size) => { const p = path.join(dir, name); ff(['-f', 'lavfi', '-i', `${src}=size=${size}`, '-frames:v', '1', p]); out[name] = p; };
  gen('a.png', 'testsrc2', '1200x900');
  gen('b.jpg', 'smptehdbars', '1200x900');
  gen('c.png', 'mandelbrot', '900x900');
  gen('d.jpg', 'rgbtestsrc', '800x1000');
  // tall "screenshot" for the device scene: gradient + boxes, 1170 x 3600
  const tall = path.join(dir, 'tall.png');
  ff(['-f', 'lavfi', '-i', 'gradients=size=1170x3600:c0=0x1b2a4a:c1=0xe8eefc:x0=0:y0=0:x1=0:y1=3600:seed=7', '-vf',
    'drawbox=x=80:y=300:w=1010:h=500:color=white@0.9:t=fill,drawbox=x=80:y=1000:w=480:h=480:color=0x3355ff:t=fill,drawbox=x=610:y=1000:w=480:h=480:color=0xff7a33:t=fill,drawbox=x=80:y=1800:w=1010:h=900:color=white@0.8:t=fill',
    '-frames:v', '1', tall]);
  out['tall.png'] = tall;
  const logo = path.join(dir, 'logo.png');
  ff(['-f', 'lavfi', '-i', 'color=c=0x15151a:size=600x180', '-vf', 'drawbox=x=0:y=0:w=180:h=180:color=0x3355ff:t=fill', '-frames:v', '1', logo]);
  out['logo.png'] = logo;
  return out;
}
export function writeConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `window.PROMO_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
  return file;
}
/** A config with no placeholders and no claims (final render allowed). */
export function cleanConfig(over = {}) {
  return Object.assign({
    format: '4:5',
    topic: 'test',
    brand: { name: 'Testbrand', logo: 'assets/logo.png', url: 'example.com' },
    colors: { background: '#f5f2ec', text: '#15151a', accent: '#3355ff' },
    font: { family: 'Arial' },
    scenes: [
      { type: 'title', duration: 1.0, kicker: 'Test', headline: 'A clean *test* frame', subline: 'Rendered in the test suite.' },
      { type: 'cta', duration: 1.0, transition: 'fade', headline: 'Try it *now*.', button: 'Open' },
    ],
  }, over);
}
export function copyAssets(images, projectDir) {
  const a = path.join(projectDir, 'assets');
  fs.mkdirSync(a, { recursive: true });
  for (const [name, p] of Object.entries(images)) fs.copyFileSync(p, path.join(a, name));
}

/** Run a script; resolves {code, stdout, stderr, ms}. Kills after timeoutMs (then code = 'timeout'). */
export function run(script, args, { env = {}, timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { env: { ...process.env, ...env }, cwd: cwd || SCRIPTS });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: killed ? 'timeout' : code, stdout, stderr, out: stdout + stderr, ms: Date.now() - t0 }); });
  });
}
export function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,nb_read_packets,duration', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}
/** RGB of one pixel of an image file (via ffmpeg). */
export function pixel(file, x, y) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 });
  return [...r.stdout.subarray(0, 3)];
}
export function pageUrl(configPath, extra = {}) {
  const u = new URL(fileUrl(path.join(TEMPLATE_DIR, 'index.html')));
  u.searchParams.set('capture', '1');
  u.searchParams.set('config', fileUrl(configPath));
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.href;
}
