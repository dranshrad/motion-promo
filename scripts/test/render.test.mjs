// End-to-end tests for the renderer (spawned as a CLI, like an agent would use it).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TEMPLATE_DIR } from '../lib/common.mjs';
import { tmpDir, makeImages, writeConfig, cleanConfig, copyAssets, run, probe, pixel, cleanupAll, FFMPEG } from './helpers.mjs';

after(cleanupAll);
const IMGS = makeImages(tmpDir('images'));

function starterProject(name) {
  const d = tmpDir(name);
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'promo.config.js'), path.join(d, 'promo.config.js'));
  return d;
}
function cleanProject(name, over) {
  const d = tmpDir(name);
  copyAssets(IMGS, d);
  writeConfig(path.join(d, 'promo.config.js'), cleanConfig(over));
  return d;
}
function fakeFfmpeg(name, body) {
  const p = path.join(tmpDir('fake-' + name), 'ffmpeg');
  fs.writeFileSync(p, `#!/bin/sh\ncase "$*" in *-version*|*-encoders*) echo "ffmpeg version fake"; exit 0;; esac\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

for (const format of ['4:5', '9:16', '1:1', '16:9']) {
  test(`starter config renders stills + one contact sheet in ${format}`, async () => {
    const d = starterProject('starter-' + format.replace(':', 'x'));
    const r = await run('render.mjs', [d, '--stills', 'auto', '--format', format]);
    assert.equal(r.code, 0, r.out);
    const stills = fs.readdirSync(path.join(d, 'stills'));
    assert.ok(stills.includes('contact-sheet.png'), 'contact sheet written');
    const pngs = stills.filter((f) => /^still-.*\.png$/.test(f));
    assert.equal(pngs.length, 13, '6 scenes x (mid + settled) + final frame');
    const [w, h] = { '4:5': [1080, 1350], '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] }[format];
    const s = probe(path.join(d, 'stills', pngs[1])).streams[0];
    assert.deepEqual([s.width, s.height], [w, h]);
    // layout lint must be clean for the starter in every format: only placeholder issues
    const issueLines = r.stdout.split('\n').filter((l) => l.startsWith('  x '));
    const layout = issueLines.filter((l) => !/placeholder|image not set|none set/.test(l));
    assert.deepEqual(layout, [], 'no overflow / overlap / safe-zone issues');
  });
}

test('stills: previous run is deleted first; explicit times work', async () => {
  const d = starterProject('stills-rerun');
  fs.mkdirSync(path.join(d, 'stills'));
  fs.writeFileSync(path.join(d, 'stills', 'still-99-old.png'), 'x');
  const r = await run('render.mjs', [d, '--stills', '0.5,3,14.9']);
  assert.equal(r.code, 0, r.out);
  const files = fs.readdirSync(path.join(d, 'stills')).sort();
  assert.ok(!files.includes('still-99-old.png'));
  assert.equal(files.filter((f) => f.startsWith('still-')).length, 3);
});

test('starter: issues list non-empty and final render refused (exit 3)', async () => {
  const d = starterProject('starter-final');
  const r = await run('render.mjs', [d, '--fps', '10']);
  assert.equal(r.code, 3, r.out);
  const m = r.stdout.match(/Issues \((\d+)\)/);
  assert.ok(m && +m[1] > 0, 'issues reported');
  assert.match(r.stderr, /final render refused/);
  assert.ok(!fs.existsSync(path.join(d, 'out')) || fs.readdirSync(path.join(d, 'out')).length === 0, 'nothing written');
});

test('path with spaces, #, %, and non-ASCII characters works', async () => {
  const d = path.join(tmpDir('paths'), 'my promo #1 100% ünïcødé 日本');
  fs.mkdirSync(path.join(d, 'assets', 'sub dir #2'), { recursive: true });
  fs.copyFileSync(IMGS['a.png'], path.join(d, 'assets', 'sub dir #2', 'shot 50% #a.png'));
  copyAssets(IMGS, d);
  writeConfig(path.join(d, 'promo.config.js'), cleanConfig({
    scenes: [
      { type: 'title', duration: 1, headline: 'Paths *work*' },
      { type: 'mosaic', duration: 1.2, images: ['assets/sub dir #2/shot 50% #a.png', 'assets/b.jpg', 'assets/c.png'] },
      { type: 'cta', duration: 1, headline: 'Done.', button: 'Go' },
    ],
  }));
  const r = await run('render.mjs', [d, '--stills', 'auto']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /failed to load|image .* failed/);
  assert.match(r.out, /Issues \(0\)/);
  const v = await run('render.mjs', [d, '--fps', '5', '--quiet']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /verified/);
  assert.ok(fs.readdirSync(path.join(d, 'out')).some((f) => /^testbrand-test-4x5-v1\.mp4$/.test(f)));
});

test('short full render (2 s @ 10 fps): ffprobe-verified, output dir created, versioned, never overwritten', async () => {
  const d = cleanProject('full');
  const out = path.join(d, 'new', 'nested dir', 'ad.mp4');
  const r = await run('render.mjs', [d, '--fps', '10', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /verified +ffprobe frame count and duration match \(20 frames, 2\.000 s\)/);
  const p = probe(out);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(Number(v.nb_read_packets), 20);
  assert.deepEqual([v.width, v.height], [1080, 1350]);
  // faststart: moov before mdat
  const head = fs.readFileSync(out).subarray(0, 4096).toString('latin1');
  assert.ok(head.indexOf('moov') >= 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'moov atom first (+faststart)');
  // never overwrite
  const again = await run('render.mjs', [d, '--fps', '10', '--out', out]);
  assert.equal(again.code, 2, again.out);
  assert.match(again.stderr, /output exists/);
  const ver = await run('render.mjs', [d, '--fps', '10', '--out', out, '--auto-version']);
  assert.equal(ver.code, 0, ver.out);
  assert.ok(fs.existsSync(path.join(path.dirname(out), 'ad-v2.mp4')));
  const forced = await run('render.mjs', [d, '--fps', '10', '--out', out, '--force']);
  assert.equal(forced.code, 0, forced.out);
  // no partial files left behind
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((f) => f.includes('partial')), []);
});

test('audio: trimmed to video length with fade-out', async () => {
  const d = cleanProject('audio');
  const wav = path.join(d, 'tone 5s.wav');
  spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', wav]);
  const out = path.join(d, 'out', 'a.mp4');
  const r = await run('render.mjs', [d, '--fps', '10', '--out', out, '--audio', wav]);
  assert.equal(r.code, 0, r.out);
  const a = probe(out).streams.find((s) => s.codec_type === 'audio');
  assert.ok(a, 'audio stream present');
  assert.ok(Math.abs(Number(a.duration) - 2) < 0.1, `audio trimmed to ~2 s (got ${a.duration})`);
});

test('draft: allowed with open issues and a DRAFT mark is burned into every frame', async () => {
  const d = starterProject('draft');
  const out = path.join(d, 'draft.mp4');
  const r = await run('render.mjs', [d, '--draft', '--fps', '2', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /DRAFT/);
  const frames = path.join(d, 'frames');
  fs.mkdirSync(frames);
  spawnSync(FFMPEG, ['-v', 'error', '-i', out, path.join(frames, 'f%03d.png')]);
  const list = fs.readdirSync(frames);
  assert.equal(list.length, 30);
  for (const f of list) {
    // the red pill sits at the top centre of every frame
    const [R, G, B] = pixel(path.join(frames, f), 540, 35);
    assert.ok(R > 180 && G < 90 && B < 100, `${f}: expected DRAFT red at (540,35), got ${R},${G},${B}`);
  }
  // and not in a normal still
  const s = await run('render.mjs', [d, '--stills', '1']);
  assert.equal(s.code, 0);
  const still = fs.readdirSync(path.join(d, 'stills')).find((f) => f.startsWith('still-'));
  const [R, G] = pixel(path.join(d, "stills", still), 540, 35);
  assert.ok(!(R > 180 && G < 90), 'no mark without --draft');
});

test('claim without a source blocks the final render; with a source it is listed', async () => {
  const noSrc = cleanProject('claim-nosrc', {
    scenes: [
      { type: 'stat', duration: 1.8, value: '12,400', label: 'teams' },
      { type: 'cta', duration: 1, headline: 'Go.', button: 'Open', offer: { text: '20% off this week' } },
    ],
  });
  const r = await run('render.mjs', [noSrc, '--fps', '10']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.stdout, /"12,400 teams" — source: MISSING/);
  assert.match(r.stdout, /"20% off this week" — source: MISSING/);
  assert.match(r.stderr, /claim\(s\) without a source/);

  const withSrc = cleanProject('claim-src', {
    scenes: [
      { type: 'stat', duration: 1.8, value: '12,400', label: 'teams', source: 'https://example.com/customers' },
      { type: 'quote', duration: 2, text: 'It *works*.', author: 'A. Person', role: 'Tester', source: 'https://example.com/reviews/1' },
    ],
  });
  fs.mkdirSync(path.join(withSrc, 'assets', 'fetched'), { recursive: true });
  fs.writeFileSync(path.join(withSrc, 'assets', 'fetched', 'facts.txt'), 'Used by 12400 teams worldwide.\n');
  const ok = await run('render.mjs', [withSrc, '--fps', '10']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.stdout, /Claims to verify \(2\)/);
  assert.match(ok.stdout, /every number in the claims appears in facts\.txt/);

  const mism = cleanProject('claim-facts', { scenes: [{ type: 'stat', duration: 1.8, value: '99%', label: 'uptime', source: 'status page' }] });
  fs.mkdirSync(path.join(mism, 'assets', 'fetched'), { recursive: true });
  fs.writeFileSync(path.join(mism, 'assets', 'fetched', 'facts.txt'), 'We aim for high availability.\n');
  const w = await run('render.mjs', [mism, '--stills', '1']);
  assert.equal(w.code, 0, 'facts mismatch warns, does not block');
  assert.match(w.stdout, /\? 99 in "99% uptime"/);
});

test('ffmpeg missing: clear message + install hint, exit 2', async () => {
  const d = cleanProject('noffmpeg');
  const r = await run('render.mjs', [d, '--fps', '10'], { env: { MOTION_PROMO_FFMPEG: '/nonexistent/ffmpeg' } });
  assert.equal(r.code, 2, r.out);
  assert.match(r.stderr, /ffmpeg not found/);
  assert.match(r.stderr, /brew install ffmpeg|apt-get install -y ffmpeg/);
});

test('ffmpeg failing mid-render: no hang, no raw EPIPE, non-zero exit within 30 s', async () => {
  const d = cleanProject('ffcrash');
  const fake = fakeFfmpeg('crash', 'head -c 300000 >/dev/null\necho "simulated encoder crash" >&2\nexit 1');
  const r = await run('render.mjs', [d, '--fps', '10', '--quiet'], { env: { MOTION_PROMO_FFMPEG: fake }, timeoutMs: 30000 });
  assert.notEqual(r.code, 'timeout', 'must not hang');
  assert.notEqual(r.code, 0);
  assert.ok(r.ms < 30000);
  assert.match(r.stderr, /ffmpeg stopped during encoding/);
  assert.match(r.stderr, /simulated encoder crash/);
  assert.doesNotMatch(r.out, /EPIPE|Unhandled|at .*node:internal/);
  assert.ok(!fs.existsSync(path.join(d, 'out')) || !fs.readdirSync(path.join(d, 'out')).some((f) => f.endsWith('.mp4')), 'no output left');
});

test('ffmpeg that stops reading stdin (backpressure stall): killed, non-zero exit within 30 s', async () => {
  const d = cleanProject('ffstall');
  const fake = fakeFfmpeg('stall', 'sleep 120');
  const r = await run('render.mjs', [d, '--fps', '10', '--quiet'], { env: { MOTION_PROMO_FFMPEG: fake, MOTION_PROMO_STALL_MS: '4000' }, timeoutMs: 30000 });
  assert.notEqual(r.code, 'timeout', 'must not hang');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /stopped reading frames|ffmpeg stopped/);
  assert.doesNotMatch(r.out, /EPIPE/);
});

test('ffmpeg exiting immediately (before any frame): clear error, exit non-zero', async () => {
  const d = cleanProject('ffearly');
  const fake = fakeFfmpeg('early', 'echo "Unknown encoder libx264" >&2\nexit 1');
  const r = await run('render.mjs', [d, '--fps', '10', '--quiet'], { env: { MOTION_PROMO_FFMPEG: fake }, timeoutMs: 30000 });
  assert.notEqual(r.code, 'timeout');
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /Unknown encoder libx264/);
  assert.doesNotMatch(r.out, /EPIPE/);
});

test('browser missing: message + fix, exit 2', async () => {
  const d = cleanProject('nobrowser');
  const r = await run('render.mjs', [d, '--stills', 'auto'], { env: { MOTION_PROMO_BROWSER: '/nonexistent/chrome' } });
  assert.equal(r.code, 2, r.out);
  assert.match(r.stderr, /browser not found/);
  assert.match(r.stderr, /playwright-core install chromium|MOTION_PROMO_BROWSER/);
});

test('page script errors are surfaced and block a final render', async () => {
  const d = tmpDir('pageerr');
  copyAssets(IMGS, d);
  fs.writeFileSync(path.join(d, 'promo.config.js'), 'window.PROMO_CONFIG = { format: "4:5", scenes: [ { type: "title", duration: 1, headline: "x" } ] ;\n');
  const r = await run('render.mjs', [d, '--stills', '0.5']);
  assert.match(r.out, /SyntaxError|script error/);
  assert.match(r.out, /PROMO_CONFIG is not defined/);
  const f = await run('render.mjs', [d, '--fps', '10']);
  assert.equal(f.code, 3, f.out);
});

test('odd frame dimensions are rejected', async () => {
  const d = cleanProject('odd', { size: { width: 1081, height: 1350 } });
  const r = await run('render.mjs', [d, '--fps', '10']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.stderr, /odd dimension/);
});

test('A/B variants via --config, and --format override', async () => {
  const d = cleanProject('ab');
  writeConfig(path.join(d, 'variant-b.js'), cleanConfig({ topic: 'hook-b', scenes: [{ type: 'title', duration: 1.5, headline: 'A *different* hook' }] }));
  const r = await run('render.mjs', [d, '--config', path.join(d, 'variant-b.js'), '--format', '9:16', '--fps', '10']);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(d, 'out', 'testbrand-hook-b-9x16-v1.mp4')), fs.readdirSync(path.join(d, 'out')).join(','));
  const v = probe(path.join(d, 'out', 'testbrand-hook-b-9x16-v1.mp4')).streams[0];
  assert.deepEqual([v.width, v.height], [1080, 1920]);
});
