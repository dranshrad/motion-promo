// Fetcher test against a local HTTP server (no external network).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, makeImages, run, cleanupAll, FFMPEG } from './helpers.mjs';

after(cleanupAll);

test('fetch: srcset/picture/CSS backgrounds/og, filters, dedupe, facts, brand, bounded infinite scroll', async () => {
  const imgDir = tmpDir('fetch-src');
  const I = makeImages(imgDir);
  const tiny = path.join(imgDir, 'tiny.png');
  spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=40x40', '-frames:v', '1', tiny]);
  const uniq = (name, src, size) => { const p = path.join(imgDir, name); spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=${size}`, '-frames:v', '1', p]); return p; };
  const U = {
    p800: uniq('p800.jpg', 'testsrc', '800x600'), fallback: uniq('fb.jpg', 'pal100bars', '700x500'),
    hero: uniq('hero.jpg', 'yuvtestsrc', '1600x900'), two: uniq('two.png', 'smptebars', '900x600'),
    small: uniq('small.png', 'pal75bars', '300x300'),
  };
  const files = {
    '/img/a-480.png': I['c.png'], '/img/a-1200.png': I['a.png'], '/img/p-800.jpg': U.p800, '/img/p-1600.jpg': I['b.jpg'],
    '/img/p-fallback.jpg': U.fallback, '/img/hero bg.jpg': U.hero, '/img/two.png': U.two, '/img/og.png': I['tall.png'],
    '/img/tiny.png': tiny, '/img/dup.png': I['a.png'], '/img/small.png': U.small,
  };
  const html = `<!doctype html><html lang="en"><head><title>Acme Test — tools</title>
    <meta name="description" content="Test page for the fetcher.">
    <meta name="theme-color" content="#123456">
    <meta property="og:image" content="/img/og.png">
    <style>
      body { font-family: Georgia, serif; margin: 0; background: #fafafa; color: #222; }
      h1 { font-family: Arial, sans-serif; }
      .two { height: 300px; background: url('/img/two.png') center/cover, linear-gradient(red, blue); }
      .ds { height: 50px; background-image: url(data:image/png;base64,iVBORw0KGgo=); }
      .btn { background: #e8541c; color: #fff; padding: 10px; display: inline-block; }
    </style></head><body>
    <header><a href="/" aria-label="Home"><svg width="120" height="32" viewBox="0 0 120 32" style="color:#e8541c"><rect width="32" height="32" fill="currentColor"/></svg></a><nav>Menu</nav></header>
    <h1>Acme makes tests</h1><h2>Plans</h2><h3>Detail</h3>
    <p>Plans from $29/month.</p><p>Trusted by 12,400 teams.</p><p>99.9% uptime last quarter.</p>
    <img src="/img/small.png" srcset="/img/a-480.png 480w, /img/a-1200.png 1200w" alt="Dashboard" width="600">
    <picture><source srcset="/img/p-800.jpg 800w, /img/p-1600.jpg 1600w"><img src="/img/p-fallback.jpg" alt="Picture"></picture>
    <div style='height:400px; background-image: url("/img/hero bg.jpg")'></div>
    <div class="two"></div><div class="ds"></div>
    <svg width="10" height="10"><rect fill="url(#grad)" width="10" height="10"/></svg>
    <img src="/img/fake.png" alt="fake"><img src="/img/tiny.png" alt="tiny"><img src="/img/dup.png" alt="dup" width="60">
    <a class="btn" href="#">Start</a>
    <div id="feed"></div>
    <script>
      // infinite scroll: grows forever; the fetcher must still terminate
      let n = 0;
      addEventListener('scroll', () => {
        if (innerHeight + scrollY > document.body.scrollHeight - 200) {
          const d = document.createElement('div'); d.style.height = '1500px'; d.textContent = 'more ' + (++n);
          document.getElementById('feed').appendChild(d);
        }
      });
    </script></body></html>`;
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
    if (url === '/img/fake.png') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not an image</html>'); }
    const f = files[url];
    if (!f) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': url.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const out = path.join(tmpDir('fetch-out'), 'fetched dir');
  try {
    const r = await run('fetch.mjs', ['--url', `http://127.0.0.1:${port}/`, '--out', out, '--max-scrolls', '30'], { timeoutMs: 150000 });
    assert.equal(r.code, 0, r.out);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const urls = m.images.map((i) => decodeURIComponent(new URL(i.url).pathname));
    assert.ok(urls.includes('/img/a-1200.png'), 'largest srcset candidate: ' + urls);
    assert.ok(!urls.includes('/img/a-480.png'), 'smaller srcset candidate skipped');
    assert.ok(urls.includes('/img/p-1600.jpg'), 'largest <picture><source> candidate');
    assert.ok(urls.includes('/img/hero bg.jpg'), 'quoted CSS background with a space');
    assert.ok(urls.includes('/img/two.png'), 'CSS background from a stylesheet rule');
    assert.ok(urls.includes('/img/og.png'), 'og:image');
    const kinds = new Set(m.images.map((i) => i.kind));
    for (const k of ['img', 'css-background', 'og:image']) assert.ok(kinds.has(k), 'kind ' + k);
    const reason = (p) => (m.skipped.find((s) => decodeURIComponent(new URL(s.url).pathname) === p) || {}).reason || '';
    assert.match(reason('/img/fake.png'), /not an image/);
    assert.match(reason('/img/tiny.png'), /too small/);
    assert.match(reason('/img/dup.png'), /duplicate/);
    assert.ok(!m.images.some((i) => i.url.startsWith('data:')));
    for (const i of m.images) {
      assert.ok(fs.existsSync(path.join(out, i.file)), i.file);
      assert.ok(i.width > 0 && i.height > 0 && i.sourcePage && i.contentType);
    }
    assert.ok(!fs.readdirSync(out).some((f) => f.includes('.tmp-')), 'atomic writes leave no temp files');
    const heroFile = m.images.find((i) => i.url.includes('hero'));
    assert.equal(heroFile.contentType, 'image/jpeg', 'type from magic bytes despite application/octet-stream');
    const facts = fs.readFileSync(path.join(out, 'facts.txt'), 'utf8');
    for (const s of ['Title: Acme Test — tools', 'Description: Test page for the fetcher.', 'H1: Acme makes tests', 'H2: Plans', 'H3: Detail', 'Plans from $29/month.', 'Trusted by 12,400 teams.', '99.9% uptime']) {
      assert.ok(facts.includes(s), 'facts has: ' + s);
    }
    const brand = JSON.parse(fs.readFileSync(path.join(out, 'brand.json'), 'utf8'));
    assert.equal(brand.themeColor, '#123456');
    assert.ok(brand.colors.accents.some((c) => c.color === '#e8541c'), 'button colour found as accent');
    assert.equal(brand.fonts.heading, 'Arial');
    assert.equal(brand.fonts.body, 'Georgia');
    assert.ok(brand.logoCandidates.some((f) => f.endsWith('.svg')), 'inline header SVG saved as logo');
    const svg = fs.readFileSync(path.join(out, brand.logoCandidates.find((f) => f.endsWith('.svg'))), 'utf8');
    assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /currentColor/);
    assert.ok(fs.existsSync(path.join(out, 'screenshot-desktop.png')) && fs.existsSync(path.join(out, 'screenshot-mobile.png')));
    assert.ok(r.ms < 150000);
  } finally {
    server.close();
  }
});

test('fetch: usage errors', async () => {
  const a = await run('fetch.mjs', []);
  assert.equal(a.code, 2);
  const b = await run('fetch.mjs', ['--url', 'ftp://example.com']);
  assert.equal(b.code, 2);
  assert.match(b.stderr, /http\(s\)/);
});
