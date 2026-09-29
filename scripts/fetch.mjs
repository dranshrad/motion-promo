#!/usr/bin/env node
// motion-promo fetcher: collect real images, facts and brand hints from a site the user owns
// or is authorised to use. MIT License, Copyright (c) 2026 motion-promo contributors.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError, fail, parseArgs, launchBrowser, slug } from './lib/common.mjs';
import { sniffImage, imageSize, parseSrcset, pickLargest, cssUrls } from './lib/images.mjs';

const HELP = `motion-promo fetch — assets and facts from YOUR OWN (or authorised) site

Usage:
  node fetch.mjs --url https://example.com [--out DIR] [options]

Writes to DIR (default ./assets/fetched):
  img-NNN-*.{jpg,png,webp,avif,gif,svg}   images from <img>/srcset/<picture>, CSS backgrounds, og/twitter
  logo-NN.*                               logo candidates from header/nav (inline SVG saved as .svg)
  screenshot-desktop.png, screenshot-mobile.png   full-page captures for device scenes
  manifest.json   provenance: source page, url, alt, dimensions, kind — plus skipped items and why
  facts.txt       title, meta description, h1–h3, visible text containing numbers / currency / %
  brand.json      theme-color, most-used colours, font families, logo candidates

Options:
  --out DIR            output directory (default ./assets/fetched)
  --limit N            max images to keep (default 40)
  --min PX             min width and height for content images (default 200)
  --max-bytes N        per-file size cap (default 15000000)
  --timeout S          per-download timeout in seconds (default 20)
  --max-scrolls N      lazy-load scroll steps (default 14; infinite scroll always terminates)
  --wait S             max wait for the load event (default 12)
  --no-screenshots     skip the full-page captures (same as --screenshots=false)
Only use this on sites the user owns or is authorised to use.`;

const HELPERS = `(() => { const parseSrcset = ${parseSrcset}; const pickLargest = ${pickLargest}; const cssUrls = ${cssUrls}; window.__mp = { parseSrcset, pickLargest, cssUrls }; })()`;

const SPEC = {
  url: 'string', out: 'string', limit: 'number', min: 'number', 'max-bytes': 'number', timeout: 'number',
  'max-scrolls': 'number', wait: 'number', screenshots: 'boolean', 'no-screenshots': 'boolean', help: 'boolean',
};

/** Bounded lazy-load scroll. Never relies on network idle; always terminates. */
async function lazyScroll(page, maxSteps, budgetMs) {
  const t0 = Date.now();
  let lastH = 0, still = 0;
  for (let i = 0; i < maxSteps && Date.now() - t0 < budgetMs; i++) {
    const { h, y, vh } = await page.evaluate(() => {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      return { h: document.documentElement.scrollHeight, y: window.scrollY, vh: window.innerHeight };
    });
    await page.waitForTimeout(350);
    const atBottom = y + vh >= h - 4;
    if (h === lastH && atBottom) { if (++still >= 2) break; } else still = 0;
    lastH = h;
    if (h > 40000 && atBottom) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

async function loadPage(page, url, waitS) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    throw new UserError(`could not open ${url}: ${String(e.message).split('\n')[0]}`, { fix: 'check the URL and network access', code: 1 });
  }
  await page.waitForLoadState('load', { timeout: waitS * 1000 }).catch(() => {});
  await page.waitForTimeout(700);
}

/** Runs inside the page: gather candidates, facts and brand hints. */
function collectInPage() {
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const visible = (el) => {
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    return !!(el.offsetParent || el.getClientRects().length);
  };
  // parsers injected from lib/images.mjs (single source of truth, unit-tested in Node)
  const { parseSrcset, pickLargest: largest, cssUrls } = window.__mp;

  const images = [];
  const add = (url, kind, extra) => { const a = abs(url); if (a && /^https?:/i.test(a)) images.push(Object.assign({ url: a, kind }, extra)); };
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    const cands = [];
    const pic = img.closest('picture');
    if (pic) for (const s of pic.querySelectorAll('source[srcset]')) cands.push(...parseSrcset(s.getAttribute('srcset')));
    if (img.getAttribute('srcset')) cands.push(...parseSrcset(img.getAttribute('srcset')));
    const best = largest(cands);
    const src = (best && best.url) || img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src');
    if (!src || /^data:/i.test(src)) continue;
    add(src, 'img', { alt: img.alt || '', natural: { w: img.naturalWidth, h: img.naturalHeight }, rendered: { w: Math.round(r.width), h: Math.round(r.height) }, visible: visible(img) });
  }
  for (const v of document.querySelectorAll('video[poster]')) add(v.getAttribute('poster'), 'video-poster', { alt: '' });
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      const bg = cs.backgroundImage;
      if (!bg || bg === 'none' || !bg.includes('url(') && !bg.includes('image-set(')) continue;
      const r = el.getBoundingClientRect();
      for (const u of cssUrls(bg)) add(u, 'css-background', { alt: el.getAttribute('aria-label') || '', rendered: { w: Math.round(r.width), h: Math.round(r.height) }, selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (pseudo || '') });
    }
  }
  const meta = (sel) => { const m = document.querySelector(sel); return m ? m.getAttribute('content') : null; };
  for (const [sel, kind] of [['meta[property="og:image"]', 'og:image'], ['meta[property="og:image:url"]', 'og:image'], ['meta[name="twitter:image"]', 'twitter:image'], ['meta[property="twitter:image"]', 'twitter:image']]) {
    const c = meta(sel);
    if (c) add(c, kind, { alt: meta('meta[property="og:image:alt"]') || '' });
  }

  // logo candidates
  const logos = [];
  const logoScope = [...document.querySelectorAll('header, nav, [class*="logo" i], [id*="logo" i], a[href="/"], a[aria-label*="home" i]')];
  const seen = new Set();
  for (const scope of logoScope) {
    const imgs = scope.matches('img') ? [scope] : [...scope.querySelectorAll('img')];
    for (const img of imgs.slice(0, 3)) {
      const src = img.currentSrc || img.getAttribute('src');
      if (src && !seen.has(src)) { seen.add(src); const a = abs(src); if (a) logos.push({ url: a, alt: img.alt || '', from: scope.tagName.toLowerCase() }); }
    }
    const svgs = scope.matches('svg') ? [scope] : [...scope.querySelectorAll('svg')];
    for (const svg of svgs.slice(0, 2)) {
      const r = svg.getBoundingClientRect();
      if (r.width < 16 || r.height < 10) continue;
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
      clone.setAttribute('width', String(Math.round(r.width)));
      clone.setAttribute('height', String(Math.round(r.height)));
      const color = getComputedStyle(svg).color;
      const xml = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, color);
      if (!seen.has(xml)) { seen.add(xml); logos.push({ inlineSvg: xml, alt: svg.getAttribute('aria-label') || '', from: scope.tagName.toLowerCase(), size: { w: Math.round(r.width), h: Math.round(r.height) } }); }
    }
  }
  for (const l of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')) {
    const a = abs(l.getAttribute('href'));
    if (a) logos.push({ url: a, alt: 'icon', from: 'link[rel=' + l.getAttribute('rel') + ']', icon: true });
  }

  // facts
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const headings = {};
  for (const h of ['h1', 'h2', 'h3']) headings[h] = [...document.querySelectorAll(h)].filter(visible).map((e) => clean(e.innerText)).filter(Boolean).slice(0, 40);
  const numeric = [];
  const numRe = /\d|[$€£¥₹%]/;
  const seenT = new Set();
  for (const el of document.querySelectorAll('p, li, span, div, td, th, dd, dt, strong, b, small, h1, h2, h3, h4, h5, h6, blockquote, figcaption, a, button, label')) {
    if (!visible(el)) continue;
    // leaf-ish blocks only, so text is not repeated through every ancestor
    if ([...el.children].some((c) => /^(P|DIV|LI|UL|OL|SECTION|ARTICLE|TABLE)$/.test(c.tagName))) continue;
    const t = clean(el.innerText);
    if (!t || t.length > 300 || !numRe.test(t) || seenT.has(t)) continue;
    seenT.add(t);
    numeric.push(t);
    if (numeric.length >= 250) break;
  }

  // colours and fonts
  const toHex = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length > 3 && p[3] < 0.5) return null;
    return '#' + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  };
  const bgW = new Map(), fgW = new Map(), accW = new Map(), fonts = new Map();
  const vh = window.innerHeight;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.top > vh * 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const bg = toHex(cs.backgroundColor);
    if (bg) bgW.set(bg, (bgW.get(bg) || 0) + Math.min(r.width * r.height, 2e6));
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (own) {
      const fg = toHex(cs.color);
      if (fg) fgW.set(fg, (fgW.get(fg) || 0) + own.length);
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const role = /^H[1-3]$/.test(el.tagName) ? 'heading' : 'body';
      const key = fam + '|' + role;
      fonts.set(key, (fonts.get(key) || 0) + own.length);
    }
    if (el.matches('a, button, [class*="btn" i], [class*="button" i], [role="button"]')) {
      for (const c of [toHex(cs.backgroundColor), toHex(cs.color), toHex(cs.borderTopColor)]) {
        if (!c) continue;
        const n = parseInt(c.slice(1), 16), R = n >> 16, G = (n >> 8) & 255, B = n & 255;
        const sat = Math.max(R, G, B) - Math.min(R, G, B);
        if (sat > 60) accW.set(c, (accW.get(c) || 0) + 1);
      }
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([color, weight]) => ({ color, weight: Math.round(weight) }));
  const fontList = [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, count]) => { const [family, role] = k.split('|'); return { family, role, count }; });
  return {
    url: location.href,
    title: clean(document.title),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]') || '',
    siteName: meta('meta[property="og:site_name"]') || '',
    themeColor: meta('meta[name="theme-color"]') || null,
    headings,
    numeric,
    images,
    logos,
    colors: { backgrounds: top(bgW, 8), text: top(fgW, 6), accents: top(accW, 6) },
    fonts: fontList,
    lang: document.documentElement.lang || '',
  };
}

async function download(url, { referer, ua, timeoutMs, maxBytes }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': ua, referer, accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) return { error: `too large (${len} bytes > ${maxBytes})` };
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) { ac.abort(); return { error: `too large (> ${maxBytes} bytes)` }; }
      chunks.push(chunk);
    }
    return { buf: Buffer.concat(chunks), contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), finalUrl: res.url };
  } catch (e) {
    return { error: ac.signal.aborted ? `timed out after ${timeoutMs / 1000} s` : String(e.cause ? e.cause.code || e.cause.message : e.message) };
  } finally {
    clearTimeout(timer);
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), SPEC);
  if (opts.help || !opts.url) { console.log(HELP); if (!opts.help) process.exitCode = 2; return; }
  let pageUrl;
  try { pageUrl = new URL(opts.url); } catch { throw new UserError(`not a valid URL: ${opts.url}`, { code: 2 }); }
  if (!/^https?:$/.test(pageUrl.protocol)) throw new UserError('only http(s) URLs are supported', { code: 2 });
  const outDir = path.resolve(opts.out || 'assets/fetched');
  const limit = opts.limit || 40, minPx = opts.min != null ? opts.min : 200;
  const maxBytes = opts['max-bytes'] || 15e6, timeoutMs = (opts.timeout || 20) * 1000;
  const wantShots = opts['no-screenshots'] ? false : opts.screenshots !== false;
  fs.mkdirSync(outDir, { recursive: true });

  const { browser } = await launchBrowser();
  const t0 = Date.now();
  try {
    const ua = (await browser.newBrowserCDPSession().then((s) => s.send('Browser.getVersion')).then((v) => v.userAgent).catch(() => null) || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36').replace('HeadlessChrome', 'Chrome');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: ua, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    console.log(`fetch ${pageUrl.href}`);
    await loadPage(page, pageUrl.href, opts.wait || 12);
    await lazyScroll(page, opts['max-scrolls'] || 14, 25000);
    await page.evaluate(HELPERS);
    const data = await page.evaluate(collectInPage);
    const shots = [];
    if (wantShots) {
      const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, ...[...document.querySelectorAll('main, [class*="scroll" i]')].map((e) => e.scrollHeight)));
      const file = path.join(outDir, 'screenshot-desktop.png');
      const buf = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.min(h, 7200) }, timeout: 60000 }).catch(() => null);
      if (buf) { atomicWrite(file, buf); shots.push({ file: path.basename(file), width: 1440, height: Math.min(h, 7200), viewport: '1440x900' }); }
      const mctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      });
      const mp = await mctx.newPage();
      await loadPage(mp, pageUrl.href, opts.wait || 12).catch(() => {});
      await lazyScroll(mp, 10, 15000);
      const mh = await mp.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)).catch(() => 844);
      const mcap = Math.min(mh, 2600);
      const mbuf = await mp.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 390, height: mcap }, timeout: 60000 }).catch(() => null);
      if (mbuf) { const f = path.join(outDir, 'screenshot-mobile.png'); atomicWrite(f, mbuf); shots.push({ file: path.basename(f), width: 1170, height: mcap * 3, viewport: '390x844@3x' }); }
      await mctx.close();
    }
    await ctx.close();

    // candidates: dedupe by URL (ignoring #fragment), keep first kind seen
    const byUrl = new Map();
    for (const c of data.images) {
      const key = c.url.split('#')[0];
      if (!byUrl.has(key)) byUrl.set(key, c);
    }
    // largest rendered first so the limit keeps hero images
    const cands = [...byUrl.values()].sort((a, b) => ((b.rendered && b.rendered.w * b.rendered.h) || 0) - ((a.rendered && a.rendered.w * a.rendered.h) || 0));
    const kept = [], skipped = [], hashes = new Set();
    let n = 0;
    for (const c of cands) {
      if (kept.length >= limit) { skipped.push({ url: c.url, reason: `limit ${limit} reached` }); continue; }
      const d = await download(c.url, { referer: pageUrl.href, ua, timeoutMs, maxBytes });
      if (d.error) { skipped.push({ url: c.url, kind: c.kind, reason: d.error }); continue; }
      const type = sniffImage(d.buf, d.contentType);
      if (!type) { skipped.push({ url: c.url, kind: c.kind, reason: `not an image (content-type ${d.contentType || 'none'})` }); continue; }
      const sha1 = crypto.createHash('sha1').update(d.buf).digest('hex');
      if (hashes.has(sha1)) { skipped.push({ url: c.url, kind: c.kind, reason: 'duplicate content' }); continue; }
      const dim = imageSize(d.buf, type) || {};
      if (dim.width && dim.height && (dim.width < minPx || dim.height < minPx)) {
        skipped.push({ url: c.url, kind: c.kind, reason: `too small (${dim.width}x${dim.height} < ${minPx})` }); continue;
      }
      hashes.add(sha1);
      const base = slug(decodeURIComponent(path.basename(new URL(c.url).pathname)).replace(/\.[a-z0-9]+$/i, ''), 'image').slice(0, 32);
      const file = `img-${String(++n).padStart(3, '0')}-${base}.${type.ext}`;
      atomicWrite(path.join(outDir, file), d.buf);
      kept.push({ file, url: c.url, sourcePage: pageUrl.href, kind: c.kind, alt: c.alt || '', width: dim.width || null, height: dim.height || null, rendered: c.rendered || null, bytes: d.buf.length, contentType: type.mime, sha1 });
    }
    // logos
    const logos = [];
    let ln = 0;
    for (const l of data.logos.slice(0, 12)) {
      if (l.inlineSvg) {
        const file = `logo-${String(++ln).padStart(2, '0')}.svg`;
        atomicWrite(path.join(outDir, file), l.inlineSvg);
        logos.push({ file, source: `inline <svg> in ${l.from}`, alt: l.alt, width: l.size.w, height: l.size.h, kind: 'logo' });
        continue;
      }
      const d = await download(l.url, { referer: pageUrl.href, ua, timeoutMs, maxBytes });
      if (d.error) { skipped.push({ url: l.url, kind: 'logo', reason: d.error }); continue; }
      const type = sniffImage(d.buf, d.contentType);
      if (!type) { skipped.push({ url: l.url, kind: 'logo', reason: `not an image (content-type ${d.contentType || 'none'})` }); continue; }
      const sha1 = crypto.createHash('sha1').update(d.buf).digest('hex');
      if (hashes.has(sha1)) continue;
      hashes.add(sha1);
      const dim = imageSize(d.buf, type) || {};
      const file = `logo-${String(++ln).padStart(2, '0')}.${type.ext}`;
      atomicWrite(path.join(outDir, file), d.buf);
      logos.push({ file, url: l.url, source: l.from, alt: l.alt, width: dim.width || null, height: dim.height || null, kind: l.icon ? 'icon' : 'logo', contentType: type.mime });
    }

    const manifest = {
      tool: 'motion-promo fetch', sourcePage: pageUrl.href, finalUrl: data.url, fetchedAt: new Date().toISOString(),
      note: 'Use only if the user owns or is authorised to use this site. Check each asset before use.',
      images: kept, logos, screenshots: shots, skipped,
    };
    atomicWrite(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const L = [];
    L.push(`Source: ${pageUrl.href}`, `Fetched: ${manifest.fetchedAt}`, '');
    L.push(`Title: ${data.title}`, `Description: ${data.description}`);
    if (data.siteName) L.push(`Site name: ${data.siteName}`);
    for (const h of ['h1', 'h2', 'h3']) for (const t of data.headings[h]) L.push(`${h.toUpperCase()}: ${t}`);
    L.push('', '# Visible text containing numbers, currency or %');
    for (const t of data.numeric) L.push(t);
    atomicWrite(path.join(outDir, 'facts.txt'), L.join('\n') + '\n');

    const heading = data.fonts.find((f) => f.role === 'heading');
    const body = data.fonts.find((f) => f.role === 'body');
    const brand = {
      sourcePage: pageUrl.href,
      name: data.siteName || data.title.split(/[|–—·-]/)[0].trim(),
      themeColor: data.themeColor,
      colors: data.colors,
      fonts: { heading: heading ? heading.family : null, body: body ? body.family : null, all: data.fonts },
      logoCandidates: logos.map((l) => l.file),
      note: 'Hints only — confirm colours, font and logo with the user or their brand guide.',
    };
    atomicWrite(path.join(outDir, 'brand.json'), JSON.stringify(brand, null, 2));

    console.log(`  images   ${kept.length} kept, ${skipped.length} skipped (reasons in manifest.json)`);
    for (const k of kept.slice(0, 12)) console.log(`    ${k.file}  ${k.width || '?'}x${k.height || '?'}  ${k.kind}`);
    if (kept.length > 12) console.log(`    … ${kept.length - 12} more`);
    console.log(`  logos    ${logos.map((l) => l.file).join(', ') || 'none found'}`);
    console.log(`  shots    ${shots.map((s) => s.file).join(', ') || 'none'}`);
    console.log(`  facts    ${path.join(outDir, 'facts.txt')} (${data.numeric.length} numeric lines, ${data.headings.h1.length} h1)`);
    console.log(`  brand    ${path.join(outDir, 'brand.json')} (theme-color ${data.themeColor || 'none'}; fonts ${[brand.fonts.heading, brand.fonts.body].filter(Boolean).join(' / ') || '?'})`);
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${outDir}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(fail);
