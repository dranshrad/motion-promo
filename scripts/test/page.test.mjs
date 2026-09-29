// Page-contract tests driven directly through the browser: determinism, lint, mosaic, contrast.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchBrowser } from '../lib/common.mjs';
import { tmpDir, makeImages, writeConfig, cleanConfig, copyAssets, pageUrl, cleanupAll } from './helpers.mjs';

let browser;
const IMGS = makeImages(tmpDir('page-images'));
before(async () => { ({ browser } = await launchBrowser()); });
after(async () => { if (browser) await browser.close(); cleanupAll(); });

async function open(name, cfg, size = { width: 1080, height: 1350 }) {
  const d = tmpDir(name);
  copyAssets(IMGS, d);
  const file = writeConfig(path.join(d, 'promo.config.js'), cfg);
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pageUrl(file));
  const info = await page.evaluate(async () => { await window.promo.ready; return { issues: promo.issues, warnings: promo.warnings, claims: promo.claims, duration: promo.duration, timeline: promo.timeline, size: promo.size }; });
  const cdp = await ctx.newCDPSession(page);
  const shot = async (t) => {
    await page.evaluate((x) => window.promo.seek(x), t);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(r.data, 'base64');
  };
  return { page, ctx, info, shot, errors };
}

const RICH = cleanConfig({
  scenes: [
    { type: 'title', duration: 1.4, kicker: 'Kicker', headline: 'Deterministic *motion*.\nEvery frame.', subline: 'Pure function of time.' },
    { type: 'device', duration: 2, transition: 'slide', frame: 'phone', caption: 'A tall *screen*', image: 'assets/tall.png', tap: { x: 585, y: 1200 } },
    { type: 'compare', duration: 1.6, transition: 'wipe', from: 'assets/a.png', to: 'assets/b.jpg' },
    { type: 'mosaic', duration: 1.4, transition: 'zoom', images: ['assets/a.png', 'assets/b.jpg', 'assets/c.png', 'assets/d.jpg'] },
    { type: 'features', duration: 1.6, transition: 'fade', items: ['One', 'Two', 'Three'] },
    { type: 'cta', duration: 1.4, transition: 'iris', headline: 'Go *today*.', button: 'Open' },
  ],
});

test('determinism: same frame twice is identical; backward and out-of-order seeks equal forward', async () => {
  const { shot, ctx, info, errors } = await open('det', RICH);
  assert.deepEqual(info.issues, []);
  const times = [0, 0.37, 1.55, 2.41, 3.9, 4.05, 5.3, 6.2, 7.1, 8.9];
  const forward = [];
  for (const t of times) forward.push(await shot(t));
  for (let i = 0; i < times.length; i++) assert.ok((await shot(times[i])).equals(forward[i]), `repeat at ${times[i]}`);
  const order = [...times.keys()].reverse();
  for (const i of order) assert.ok((await shot(times[i])).equals(forward[i]), `backward at ${times[i]}`);
  const shuffled = [3, 7, 0, 9, 5, 1, 8, 2, 6, 4];
  for (const i of shuffled) assert.ok((await shot(times[i])).equals(forward[i]), `out of order at ${times[i]}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('determinism: a second, independent page renders the same pixels (as used by --jobs)', async () => {
  const A = await open('det-a', RICH);
  const B = await open('det-b', RICH);
  for (let i = 0; i < 90; i += 7) {
    const t = i / 10;
    assert.ok((await A.shot(t)).equals(await B.shot(t)), `pages agree at ${t}`);
  }
  await A.ctx.close(); await B.ctx.close();
});

test('overflow lint catches an absurdly long headline', async () => {
  const { info, ctx } = await open('overflow', cleanConfig({
    scenes: [{ type: 'title', duration: 2, headline: 'Supercalifragilisticexpialidociously '.repeat(8) + 'Pneumonoultramicroscopicsilicovolcanoconiosis' }],
  }));
  assert.ok(info.issues.some((m) => /does not fit|overflows|clipped|outside the safe zone/.test(m)), info.issues.join('\n'));
  await ctx.close();
});

test('lint catches overflow in CTA and features too', async () => {
  const { info, ctx } = await open('overflow2', cleanConfig({
    scenes: [
      { type: 'features', duration: 2, items: ['x '.repeat(200), 'Two', 'Three'] },
      { type: 'cta', duration: 2, headline: 'word '.repeat(120), button: 'Open' },
    ],
  }));
  assert.ok(info.issues.some((m) => /scene 1 \(features\)/.test(m)), info.issues.join('\n'));
  assert.ok(info.issues.some((m) => /scene 2 \(cta\)/.test(m)), info.issues.join('\n'));
  await ctx.close();
});

test('mosaic with 3 real images shows no placeholder and avoids identical neighbours', async () => {
  const { page, info, ctx } = await open('mosaic3', cleanConfig({
    scenes: [{ type: 'mosaic', duration: 2, count: 12, images: ['assets/a.png', 'assets/b.jpg', 'assets/c.png'] }],
  }));
  assert.deepEqual(info.issues, []);
  const r = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.scene-mosaic .cell-img')];
    const grid = document.querySelector('.scene-mosaic .mosaic-grid');
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    return { srcs: cells.map((c) => c.src), placeholders: document.querySelectorAll('.scene-mosaic .is-placeholder').length, cols };
  });
  assert.equal(r.placeholders, 0);
  assert.ok(r.srcs.length >= 12);
  assert.ok(r.srcs.every((s) => !s.startsWith('data:')), 'real images only');
  for (let i = 0; i < r.srcs.length; i++) {
    if (i % r.cols > 0) assert.notEqual(r.srcs[i], r.srcs[i - 1], `cell ${i} equals left neighbour`);
    if (i >= r.cols) assert.notEqual(r.srcs[i], r.srcs[i - r.cols], `cell ${i} equals top neighbour`);
  }
  await ctx.close();
});

test('mosaic: a failed image is reported but real ones fill the grid (no placeholder cells)', async () => {
  const { page, info, ctx } = await open('mosaic-fail', cleanConfig({
    scenes: [{ type: 'mosaic', duration: 2, images: ['assets/a.png', 'assets/missing.png'] }],
  }));
  assert.ok(info.issues.some((m) => /missing\.png/.test(m)));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.scene-mosaic .is-placeholder').length), 0);
  await ctx.close();
});

test('word reveal: hidden words are never painted and no word is ever clipped (no partial glyphs)', async () => {
  const { page, info, ctx } = await open('reveal', cleanConfig({
    scenes: [{ type: 'title', duration: 2.5, headline: 'One two three four five six seven' }],
  }));
  assert.deepEqual(info.issues, []);
  for (let t = 0; t <= 2.0; t += 0.05) {
    const bad = await page.evaluate((tt) => {
      promo.seek(tt);
      const out = [];
      for (const w of document.querySelectorAll('.scene-title .w')) {
        const inner = w.firstChild;
        const cs = getComputedStyle(inner);
        const op = parseFloat(cs.opacity);
        // a word that is not yet revealed must not be painted at all
        if (op === 0 && cs.visibility !== 'hidden') out.push('painted-while-hidden:' + inner.textContent);
        // nothing between the word and the stage may clip it
        for (let e = w; e && e.id !== 'stage'; e = e.parentElement) {
          const ov = getComputedStyle(e).overflow;
          if (ov !== 'visible' && !e.classList.contains('scene') && !e.classList.contains('layers')) out.push('clipped-by:' + e.className);
        }
      }
      return out;
    }, t);
    assert.deepEqual(bad, [], `t=${t.toFixed(2)}`);
  }
  await ctx.close();
});

test('accent markup: *word* and *several words* with trailing punctuation; \\n breaks lines', async () => {
  const { page, ctx } = await open('markup', cleanConfig({
    scenes: [{ type: 'title', duration: 2, headline: 'Ship it *today*.\nMade *for small teams*, finally' }],
  }));
  const r = await page.evaluate(() => {
    const h = document.querySelector('.scene-title .headline');
    return { lines: h.querySelectorAll('.ln').length, acc: [...h.querySelectorAll('.acc')].map((a) => a.textContent), text: [...h.querySelectorAll('.ln')].map((l) => l.textContent.trim()).join(' ') };
  });
  assert.equal(r.lines, 2);
  assert.deepEqual(r.acc, ['today', 'for', 'small', 'teams']);
  assert.equal(r.text, 'Ship it today. Made for small teams, finally');
  await ctx.close();
});

test('automatic contrast: low-contrast brand text is corrected to >= 4.5:1 and warned', async () => {
  const { page, info, ctx } = await open('contrast', cleanConfig({
    colors: { background: '#ffffff', text: '#dddddd', accent: '#ffe066' },
    scenes: [{ type: 'cta', duration: 2, headline: 'Low *contrast* brand', button: 'Buy' }],
  }));
  assert.ok(info.warnings.some((w) => /contrast/.test(w)));
  const ratios = await page.evaluate(() => {
    const MP = window.MotionPromo;
    const col = (el, prop) => MP.parseColor(getComputedStyle(el)[prop]);
    const bg = MP.parseColor('#ffffff');
    const head = document.querySelector('.scene-cta .headline');
    const acc = document.querySelector('.scene-cta .acc');
    const btn = document.querySelector('.scene-cta .cta-btn');
    return { head: MP.contrast(col(head, 'color'), bg), acc: MP.contrast(col(acc, 'color'), bg), btn: MP.contrast(col(btn, 'color'), col(btn, 'backgroundColor')) };
  });
  for (const [k, v] of Object.entries(ratios)) assert.ok(v >= 4.5, `${k} contrast ${v.toFixed(2)}`);
  await ctx.close();
});

test('9:16 default safe zone keeps headline, CTA and key content out of the platform UI bands', async () => {
  const { page, info, ctx } = await open('safe916', Object.assign(cleanConfig(), { format: '9:16' }), { width: 1080, height: 1920 });
  assert.deepEqual(info.issues, []);
  for (const s of info.timeline) {
    const boxes = await page.evaluate((t) => {
      promo.seek(t);
      return [...document.querySelectorAll('.headline, .cta-btn, .cta-url, .kicker, .subline')].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.bottom]; });
    }, s.settle);
    for (const [top, bottom] of boxes) { assert.ok(top >= 258, `top ${top}`); assert.ok(bottom <= 1920 - 418, `bottom ${bottom}`); }
  }
  await ctx.close();
});

test('valign: title/features/cta sit at the centre, top or bottom of the safe area (9:16)', async () => {
  const scenes = (v) => [
    { type: 'title', duration: 2, kicker: 'Kicker', headline: 'A centred *title*', subline: 'Sub line.', valign: v },
    { type: 'features', duration: 2.4, headline: 'Why', items: ['One', 'Two', 'Three'], valign: v },
    { type: 'cta', duration: 2.4, headline: 'Go *now*.', button: 'Open', valign: v },
  ];
  const measure = async (v) => {
    const { page, info, ctx } = await open('valign-' + v, Object.assign(cleanConfig({ scenes: scenes(v) }), { format: '9:16' }), { width: 1080, height: 1920 });
    const r = await page.evaluate(() => promo.timeline.map((s) => {
      promo.seek(s.settle);
      const box = document.querySelectorAll('.scene .box')[s.index];
      const b = box.getBoundingClientRect();
      const kids = [...box.children].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
      return { top: Math.min(...kids.map((k) => k.top)) - b.top, bottom: b.bottom - Math.max(...kids.map((k) => k.bottom)) };
    }));
    await ctx.close();
    return { r, issues: info.issues };
  };
  const c = await measure('center'), top = await measure('top'), bot = await measure('bottom');
  for (const m of [c, top, bot]) assert.deepEqual(m.issues, []);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(c.r[i].top - c.r[i].bottom) < 40, `scene ${i + 1} centred: ${JSON.stringify(c.r[i])}`);
    assert.ok(top.r[i].top < 40 && top.r[i].bottom > 200, `scene ${i + 1} top: ${JSON.stringify(top.r[i])}`);
    assert.ok(bot.r[i].bottom < 40 && bot.r[i].top > 200, `scene ${i + 1} bottom: ${JSON.stringify(bot.r[i])}`);
  }
  // align: 'bottom' shorthand, and an invalid value is reported
  const sh = await open('valign-sh', cleanConfig({ scenes: [{ type: 'title', duration: 2, headline: 'x', align: 'bottom' }, { type: 'cta', duration: 2, headline: 'y', button: 'b', valign: 'sideways' }] }));
  assert.equal(await sh.page.evaluate(() => document.querySelector('.scene-title .box').classList.contains('valign-bottom')), true);
  assert.ok(sh.info.issues.some((m) => /valign "sideways"/.test(m)));
  await sh.ctx.close();
});

test('contract: duration derives from scenes; claims default absent; capture does not autoplay', async () => {
  const { page, info, ctx } = await open('contract', RICH);
  assert.equal(info.duration, 9.4);
  assert.deepEqual(info.claims, []);
  const a = await page.evaluate(() => { promo.seek(2); return document.querySelector('.scene-device').style.display; });
  await page.waitForTimeout(400);
  const still = await page.evaluate(() => [document.querySelector('.scene-device').style.display, document.getElementById('preview-ui').hidden]);
  assert.equal(a, still[0], 'nothing advanced the timeline on its own');
  assert.equal(still[1], true, 'preview UI hidden in capture mode');
  await ctx.close();
});
