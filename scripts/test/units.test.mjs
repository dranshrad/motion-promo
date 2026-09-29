// Pure unit tests: CSS url() parsing, srcset, image sniffing, facts numbers, naming.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cssUrls, parseSrcset, pickLargest, sniffImage, imageSize } from '../lib/images.mjs';
import { numbersIn, checkClaimsAgainstFacts, slug, nextVersion, bumpVersion, parseArgs } from '../lib/common.mjs';
import { makeImages, tmpDir } from './helpers.mjs';

test('cssUrls: quotes, spaces, escapes, multiple, image-set; skips data: and #fragment', () => {
  assert.deepEqual(cssUrls('url("a b.png")'), ['a b.png']);
  assert.deepEqual(cssUrls("url('x(1).jpg')"), ['x(1).jpg']);
  assert.deepEqual(cssUrls('url(plain.webp)'), ['plain.webp']);
  assert.deepEqual(cssUrls('url( "sp.png" )'), ['sp.png']);
  assert.deepEqual(cssUrls('url("q\\"uote.png")'), ['q"uote.png']);
  assert.deepEqual(cssUrls('linear-gradient(red, blue), url("one.png"), url(two.png)'), ['one.png', 'two.png']);
  assert.deepEqual(cssUrls('url(data:image/png;base64,AAAA), url("#grad"), url(real.png)'), ['real.png']);
  assert.deepEqual(cssUrls('image-set("lo.png" 1x, "hi.png" 2x)'), ['lo.png', 'hi.png']);
  assert.deepEqual(cssUrls('-webkit-image-set(url(a1.png) 1x, url("a2.png") 2x)'), ['a1.png', 'a2.png']);
  assert.deepEqual(cssUrls('none'), []);
});

test('srcset: largest w candidate, x densities, commas inside URLs', () => {
  const c = parseSrcset('small.jpg 480w, big.jpg 1600w, mid.jpg 960w');
  assert.equal(pickLargest(c).url, 'big.jpg');
  assert.equal(pickLargest(parseSrcset('a.png, a@2x.png 2x, a@3x.png 3x')).url, 'a@3x.png');
  const cl = parseSrcset('https://cdn.x/w_400,h_300/img.jpg 400w, https://cdn.x/w_1200,h_900/img.jpg 1200w');
  assert.equal(pickLargest(cl).url, 'https://cdn.x/w_1200,h_900/img.jpg');
});

test('sniffImage + imageSize from magic bytes (lavfi-generated files)', () => {
  const imgs = makeImages(tmpDir('units-img'));
  const png = fs.readFileSync(imgs['a.png']);
  assert.deepEqual(sniffImage(png, 'text/html'), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(imageSize(png, { ext: 'png' }), { width: 1200, height: 900 });
  const jpg = fs.readFileSync(imgs['b.jpg']);
  assert.equal(sniffImage(jpg, '').ext, 'jpg');
  assert.deepEqual(imageSize(jpg, { ext: 'jpg' }), { width: 1200, height: 900 });
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 90"></svg>');
  assert.equal(sniffImage(svg, 'image/svg+xml').ext, 'svg');
  assert.deepEqual(imageSize(svg, { ext: 'svg' }), { width: 320, height: 90 });
  assert.equal(sniffImage(Buffer.from('<!doctype html><html>404</html>'), 'text/html'), null);
  assert.equal(sniffImage(Buffer.from('<html>not found</html>'), 'image/png'), null, 'HTML served as image/png is rejected');
});

test('numbersIn + facts check: formatting variants match, missing numbers are reported', () => {
  assert.deepEqual(numbersIn('12,400+ teams').map((n) => n.vals[0]), [12400]);
  assert.ok(numbersIn('10k users')[0].vals.includes(10000));
  const facts = 'Trusted by 12,400 teams. Plans from $29/month. Rated 4.9 by 10,000 users.';
  const claims = [{ text: '12400+ teams' }, { text: '$29 a month' }, { text: '10k users' }, { text: '99% uptime' }];
  const mism = checkClaimsAgainstFacts(claims, facts);
  assert.deepEqual(mism.map((m) => m.number), ['99']);
});

test('naming: slug, versioning, bump; arg parser', () => {
  assert.equal(slug('[Brand]'), 'brand');
  assert.equal(slug('Dr. Jane Example'), 'dr-jane-example');
  assert.equal(slug('Ünïcødé Café'), 'unicode-cafe');
  const d = tmpDir('units-ver');
  assert.equal(path.basename(nextVersion(d, 'b-t-4x5')), 'b-t-4x5-v1.mp4');
  fs.writeFileSync(path.join(d, 'b-t-4x5-v1.mp4'), '');
  fs.writeFileSync(path.join(d, 'b-t-4x5-v3.mp4'), '');
  assert.equal(path.basename(nextVersion(d, 'b-t-4x5')), 'b-t-4x5-v4.mp4');
  fs.writeFileSync(path.join(d, 'x.mp4'), '');
  assert.equal(path.basename(bumpVersion(path.join(d, 'x.mp4'))), 'x-v2.mp4');
  assert.equal(path.basename(bumpVersion(path.join(d, 'b-t-4x5-v3.mp4'))), 'b-t-4x5-v4.mp4');
  const a = parseArgs(['dir', '--stills=auto', '--fps', '10', '--draft', '--target', 'a', '--target', 'b'], { stills: 'string', fps: 'number', draft: 'boolean', target: 'list' });
  assert.deepEqual(a, { _: ['dir'], stills: 'auto', fps: 10, draft: true, target: ['a', 'b'] });
  assert.throws(() => parseArgs(['--nope'], {}), /unknown option/);
});
