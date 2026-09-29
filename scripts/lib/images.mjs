// motion-promo — image sniffing, dimension parsing, srcset and CSS url() parsing.
// MIT License, Copyright (c) 2026 motion-promo contributors.
// parseSrcset / pickLargest / cssUrls are self-contained so they can also be injected into a page.

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'image/bmp': 'bmp', 'image/heic': 'heic',
};

/** Identify an image by magic bytes, falling back to an image/* content-type. Returns {ext, mime} or null. */
export function sniffImage(buf, contentType = '') {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  const ascii = (o, n) => b.toString('latin1', o, o + n);
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return { ext: 'png', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (/avif|avis/.test(brand)) return { ext: 'avif', mime: 'image/avif' };
    if (/heic|heix|mif1|msf1/.test(brand)) return { ext: 'heic', mime: 'image/heic' };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { ext: 'ico', mime: 'image/x-icon' };
  if (ascii(0, 2) === 'BM' && b.length > 26) return { ext: 'bmp', mime: 'image/bmp' };
  const head = b.toString('utf8', 0, Math.min(b.length, 2048)).replace(/^﻿/, '').trimStart();
  if ((/^<\?xml|^<svg|^<!DOCTYPE svg|^<!--/i.test(head)) && /<svg[\s>]/i.test(head)) return { ext: 'svg', mime: 'image/svg+xml' };
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/') && !/^\s*</.test(head)) return { ext: MIME_EXT[ct] || ct.slice(6).replace(/[^a-z0-9]/g, '') || 'img', mime: ct };
  return null;
}

/** Pixel dimensions from the file header. Returns {width, height} or null. */
export function imageSize(buf, type) {
  try {
    const ext = type && type.ext;
    if (ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ext === 'bmp') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    if (ext === 'ico') return { width: buf[6] || 256, height: buf[7] || 256 };
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (ext === 'webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      return null;
    }
    if (ext === 'avif' || ext === 'heic') {
      const i = buf.indexOf('ispe', 0, 'latin1');
      if (i > 0) return { width: buf.readUInt32BE(i + 8), height: buf.readUInt32BE(i + 12) };
      return null;
    }
    if (ext === 'svg') {
      const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
      const tag = (head.match(/<svg\b[^>]*>/i) || [''])[0];
      const num = (name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([\\d.]+)(px)?\\s*["']?`, 'i')); return m ? parseFloat(m[1]) : null; };
      let w = num('width'), h = num('height');
      const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if ((!w || !h) && vb) { w = w || parseFloat(vb[1]); h = h || parseFloat(vb[2]); }
      return w && h ? { width: Math.round(w), height: Math.round(h) } : null;
    }
  } catch { /* truncated header */ }
  return null;
}

/** Spec-style srcset parser (URLs may contain commas). Returns [{url, w, x}]. */
export function parseSrcset(ss) {
  const out = [];
  const s = String(ss || '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let desc = '';
    if (/,+$/.test(url)) { url = url.replace(/,+$/, ''); i = j; }
    else {
      let k = j, depth = 0;
      while (k < s.length) { const c = s[k]; if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth <= 0) break; k++; }
      desc = s.slice(j, k).trim();
      i = k + 1;
    }
    let w = 0, x = 0;
    const mw = desc.match(/(\d+)w\b/); if (mw) w = +mw[1];
    const mx = desc.match(/([\d.]+)x\b/); if (mx) x = +mx[1];
    if (url) out.push({ url, w, x });
  }
  return out;
}
/** Largest candidate: highest w descriptor, else highest x density, else the first. */
export function pickLargest(cands) {
  if (!cands || !cands.length) return null;
  const byW = cands.filter((c) => c.w);
  if (byW.length) return byW.slice().sort((a, b) => b.w - a.w)[0];
  return cands.slice().sort((a, b) => (b.x || 1) - (a.x || 1))[0];
}
/**
 * Quote-aware extraction of URLs from a CSS value: url("a b.png"), url('x'), url(x),
 * escaped characters, and image-set("a.png" 1x, url(b.png) 2x). Skips data: URIs and
 * #fragment references (e.g. url(#gradient)).
 */
export function cssUrls(value) {
  const out = [];
  const v = String(value || '');
  let i = 0;
  const readUrl = (k) => {
    while (/\s/.test(v[k])) k++;
    let url = '';
    if (v[k] === '"' || v[k] === "'") {
      const q = v[k++];
      while (k < v.length && v[k] !== q) { if (v[k] === '\\' && k + 1 < v.length) { url += v[k + 1]; k += 2; continue; } url += v[k++]; }
      k++;
      while (k < v.length && v[k] !== ')') k++;
    } else {
      while (k < v.length && v[k] !== ')') { if (v[k] === '\\' && k + 1 < v.length) { url += v[k + 1]; k += 2; continue; } url += v[k++]; }
      url = url.trim();
    }
    return { url, end: k + 1 };
  };
  while (i < v.length) {
    const u = v.indexOf('url(', i);
    const is = v.search(/image-set\(/i) >= 0 ? v.slice(i).search(/image-set\(/i) : -1;
    const iset = is >= 0 ? i + is : -1;
    if (u < 0 && iset < 0) break;
    if (u >= 0 && (iset < 0 || u < iset)) {
      const r = readUrl(u + 4);
      out.push(r.url);
      i = r.end;
    } else {
      let k = iset + v.slice(iset).indexOf('(') + 1, depth = 1;
      const start = k;
      while (k < v.length && depth > 0) { if (v[k] === '(') depth++; else if (v[k] === ')') depth--; k++; }
      const inner = v.slice(start, k - 1);
      // bare quoted strings are URLs inside image-set(); url() inside is handled recursively
      let m;
      const re = /url\(|(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
      while ((m = re.exec(inner))) {
        if (m[0] === 'url(') {
          const sub = cssUrls(inner.slice(m.index));
          if (sub.length) out.push(sub[0]);
          const close = inner.indexOf(')', m.index);
          re.lastIndex = close > 0 ? close + 1 : inner.length;
        } else out.push(m[2].replace(/\\(.)/g, '$1'));
      }
      i = k;
    }
  }
  return out.filter((s) => s && !/^data:/i.test(s) && !s.startsWith('#'));
}
