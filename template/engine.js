/*
 * motion-promo — engine utilities (easing, colour, rich text, fitting, placeholders).
 * MIT License, Copyright (c) 2026 motion-promo contributors.
 *
 * Everything here is a pure helper. Nothing reads the clock or keeps animation state:
 * the visual state of a frame is computed from (time, config) only.
 */
(function () {
  'use strict';
  const MP = (window.MotionPromo = window.MotionPromo || {});

  // ---------------------------------------------------------------- math & easing
  const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, p) => a + (b - a) * p;
  /** Progress 0..1 of a segment starting at `start` lasting `dur` (clamped). */
  const prog = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur));
  const ease = {
    linear: (p) => p,
    inCubic: (p) => p * p * p,
    inQuart: (p) => p * p * p * p,
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    outQuart: (p) => 1 - Math.pow(1 - p, 4),
    outQuint: (p) => 1 - Math.pow(1 - p, 5),
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    inOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    inOutQuart: (p) => (p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2),
    /** Overshooting ease-out; s ~ 1.2 is a gentle overshoot. */
    outBack: (p, s = 1.2) => {
      const c3 = s + 1;
      return 1 + c3 * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
    },
  };
  /** Round to 3 decimals so style strings are stable and compact. */
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // ---------------------------------------------------------------- DOM helpers
  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function css(e, styles) {
    for (const k in styles) {
      const v = styles[k];
      if (k.startsWith('--')) e.style.setProperty(k, v);
      else e.style[k] = v;
    }
    return e;
  }

  // ---------------------------------------------------------------- colour
  let colorCtx = null;
  /** Parse any CSS colour to {r,g,b,a} (0-255, a 0-1). Returns null when invalid. */
  function parseColor(input) {
    if (input && typeof input === 'object' && 'r' in input) return input;
    if (typeof input !== 'string' || !input.trim()) return null;
    if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
    colorCtx.fillStyle = '#010203';
    colorCtx.fillStyle = input;
    const a = colorCtx.fillStyle;
    colorCtx.fillStyle = '#040506';
    colorCtx.fillStyle = input;
    const b = colorCtx.fillStyle;
    if (a !== b) return null; // the input was rejected, sentinel shows through
    if (a[0] === '#') {
      return { r: parseInt(a.slice(1, 3), 16), g: parseInt(a.slice(3, 5), 16), b: parseInt(a.slice(5, 7), 16), a: 1 };
    }
    const m = a.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  function toCss(c, alpha) {
    const a = alpha == null ? c.a : alpha;
    if (a >= 1) return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
    return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${r3(a)})`;
  }
  function mix(c1, c2, p) {
    return { r: lerp(c1.r, c2.r, p), g: lerp(c1.g, c2.g, p), b: lerp(c1.b, c2.b, p), a: 1 };
  }
  function channel(v) {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }
  /** WCAG 2.x relative luminance. */
  function luminance(c) {
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }
  /** WCAG 2.x contrast ratio (1..21). */
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const INK = { r: 12, g: 12, b: 14, a: 1 };
  const isDark = (c) => contrast(c, WHITE) > contrast(c, INK);
  /**
   * Return `fg` if it reaches `min` contrast on `bg`; otherwise push it toward white or ink
   * (whichever gains contrast) in small steps until it does. Hue is kept as long as possible.
   */
  function ensureContrast(fg, bg, min = 4.5) {
    if (contrast(fg, bg) >= min) return fg;
    const target = contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK;
    for (let k = 0.04; k <= 1.0001; k += 0.04) {
      const c = mix(fg, target, k);
      if (contrast(c, bg) >= min) return c;
    }
    return target;
  }
  /** Pick the first candidate with >= min contrast on bg; fall back to the best, adjusted. */
  function textOn(bg, candidates, min = 4.5) {
    let best = null, bestC = 0;
    for (const c of candidates) {
      if (!c) continue;
      const k = contrast(c, bg);
      if (k >= min) return c;
      if (k > bestC) { best = c; bestC = k; }
    }
    return ensureContrast(best || INK, bg, min);
  }

  // ---------------------------------------------------------------- rich text
  /**
   * Parse copy with accent markup. `*word*` / `*several words*` = accent; `\*` = literal star;
   * newline (or the two characters backslash-n) = forced line break.
   * Returns { lines: [ [ word: [ {text, accent} ] ] ], unbalanced }.
   */
  function parseMarkup(input) {
    const src = String(input == null ? '' : input).replace(/\\n/g, '\n');
    let stars = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\\' && src[i + 1] === '*') { i++; continue; }
      if (src[i] === '*') stars++;
    }
    const unbalanced = stars % 2 === 1;
    const lines = [];
    let accent = false;
    for (const rawLine of src.split(/\r?\n/)) {
      const words = [];
      let word = [];
      let seg = null;
      const push = (ch) => {
        if (!seg || seg.accent !== accent) { seg = { text: '', accent }; word.push(seg); }
        seg.text += ch;
      };
      const endWord = () => { if (word.length) words.push(word); word = []; seg = null; };
      for (let i = 0; i < rawLine.length; i++) {
        const ch = rawLine[i];
        if (ch === '\\' && rawLine[i + 1] === '*') { push('*'); i++; continue; }
        if (ch === '*' && !unbalanced) { accent = !accent; seg = null; continue; }
        if (/\s/.test(ch)) { endWord(); continue; }
        push(ch);
      }
      endWord();
      lines.push(words);
    }
    return { lines, unbalanced };
  }
  function plainText(input) {
    return parseMarkup(input).lines.map((l) => l.map((w) => w.map((s) => s.text).join('')).join(' ')).join(' ');
  }
  const PLACEHOLDER_RE = /\[[^\]\n]{1,80}\]/;
  const isPlaceholderText = (s) => typeof s === 'string' && PLACEHOLDER_RE.test(s);

  function appendSegments(parent, word) {
    for (const s of word) {
      if (s.accent) { const a = el('span', 'acc', parent); a.textContent = s.text; }
      else parent.appendChild(document.createTextNode(s.text));
    }
  }
  /**
   * Render copy as individual words for kinetic reveals.
   * Structure: .rich > .ln (one per forced line) > .w (layout box) > .wi (moving inner). Nothing clips.
   */
  function renderWords(container, input) {
    const parsed = parseMarkup(input);
    const words = [];
    const lines = [];
    container.textContent = '';
    for (const line of parsed.lines) {
      const ln = el('div', 'ln', container);
      lines.push(ln);
      line.forEach((w, i) => {
        if (i > 0) ln.appendChild(document.createTextNode(' '));
        const box = el('span', 'w', ln);
        const inner = el('span', 'wi', box);
        appendSegments(inner, w);
        words.push(box);
      });
      if (!line.length) ln.appendChild(document.createTextNode(' '));
    }
    return { words, lines, unbalanced: parsed.unbalanced };
  }
  /** Render copy inline (accent spans, forced breaks) without per-word boxes. */
  function renderInline(container, input) {
    const parsed = parseMarkup(input);
    container.textContent = '';
    parsed.lines.forEach((line, li) => {
      if (li > 0) el('br', null, container);
      line.forEach((w, i) => {
        if (i > 0) container.appendChild(document.createTextNode(' '));
        appendSegments(container, w);
      });
    });
    return { unbalanced: parsed.unbalanced };
  }

  /** Count rendered lines of a word block (layout based, ignores transforms). */
  function countLines(container) {
    const tops = new Set();
    container.querySelectorAll('.w').forEach((w) => tops.add(Math.round(w.offsetTop / 4)));
    return Math.max(tops.size, container.querySelectorAll('.ln').length ? 1 : 0);
  }
  /**
   * Shrink-to-fit: largest integer font size in [min, max] such that the block fits
   * `width` x `height` and wraps to at most `maxLines`. Returns {size, fits, lines}.
   */
  function fitText(block, o) {
    const tol = 1;
    const test = (size) => {
      block.style.fontSize = size + 'px';
      const lines = countLines(block);
      const ok =
        block.scrollWidth <= o.width + tol + size * 0.08 &&
        block.scrollHeight <= o.height + tol &&
        (!o.maxLines || lines <= o.maxLines) &&
        wordsFit(block, o.width, size);
      return { ok, lines };
    };
    let r = test(o.max);
    if (r.ok) return { size: o.max, fits: true, lines: r.lines };
    let lo = o.min, hi = o.max, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = test(mid);
      if (t.ok) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best == null) {
      r = test(o.min);
      return { size: o.min, fits: false, lines: r.lines };
    }
    r = test(best);
    return { size: best, fits: true, lines: r.lines };
  }
  function wordsFit(block, width, size) {
    const slack = size * 0.08 + 1;
    const ws = block.querySelectorAll('.w');
    for (const w of ws) if (w.offsetWidth > width + slack) return false;
    return true;
  }

  // ---------------------------------------------------------------- placeholders
  function escXml(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }
  /** An obviously-placeholder image (hatched card with a label) as an SVG data URI. */
  function placeholderImage(label, w, h, tone) {
    w = Math.max(40, Math.round(w || 800));
    h = Math.max(40, Math.round(h || 600));
    const dark = tone === 'dark';
    const base = dark ? '#23242a' : '#e9e7e2';
    const stripe = dark ? '#2c2d34' : '#dedbd4';
    const ink = dark ? '#b9bac2' : '#5d5a54';
    const fs = Math.max(14, Math.round(Math.min(w, h) * 0.055));
    const lines = wrapLabel(String(label || 'image'), Math.max(8, Math.floor((w * 0.8) / (fs * 0.55))));
    const text = lines
      .map((ln, i) => `<text x="50%" y="${h / 2 + fs * 0.9 + i * fs * 1.25}" font-size="${fs}" text-anchor="middle" fill="${ink}" font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif">${escXml(ln)}</text>`)
      .join('');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><pattern id="p" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="28" height="28" fill="${base}"/><rect width="12" height="28" fill="${stripe}"/></pattern></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#p)"/>` +
      `<rect x="6" y="6" width="${w - 12}" height="${h - 12}" fill="none" stroke="${ink}" stroke-opacity=".55" stroke-width="3" stroke-dasharray="14 10" rx="10"/>` +
      `<text x="50%" y="${h / 2 - fs * 0.5}" font-size="${Math.round(fs * 0.8)}" letter-spacing="3" text-anchor="middle" fill="${ink}" font-weight="700" font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif">PLACEHOLDER</text>` +
      text +
      `</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function wrapLabel(s, maxChars) {
    const words = s.split(/\s+/);
    const out = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars && cur) { out.push(cur); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) out.push(cur);
    return out.slice(0, 3);
  }

  // ---------------------------------------------------------------- number parsing (stat)
  /** Split "$12,400+" into {prefix:'$', value:12400, decimals:0, grouped:true, suffix:'+'}. */
  function parseNumber(str) {
    const s = String(str == null ? '' : str);
    const m = s.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?|\.\d+)(.*)$/s);
    if (!m) return null;
    const num = m[2];
    const grouped = num.includes(',');
    const clean = num.replace(/,/g, '');
    const decimals = clean.includes('.') ? clean.split('.')[1].length : 0;
    return { prefix: m[1], value: parseFloat(clean), decimals, grouped, suffix: m[3] };
  }
  function formatNumber(v, n) {
    let s = v.toFixed(n.decimals);
    if (n.grouped) {
      const [i, d] = s.split('.');
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '');
    }
    return n.prefix + s + n.suffix;
  }

  Object.assign(MP, {
    clamp, lerp, prog, ease, r3, el, css,
    parseColor, toCss, mix, luminance, contrast, ensureContrast, textOn, isDark, WHITE, INK,
    parseMarkup, plainText, isPlaceholderText, renderWords, renderInline, countLines, fitText,
    placeholderImage, parseNumber, formatNumber, escXml,
  });
})();
