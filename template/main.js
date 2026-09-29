/*
 * motion-promo — composition runtime.
 * MIT License, Copyright (c) 2026 motion-promo contributors.
 *
 * Render contract (window.promo):
 *   duration  total seconds (sum of scene durations)
 *   size      {width, height} in CSS px (device scale factor 1)
 *   fps       frame-rate hint from the config (renderer default 30)
 *   seek(t)   sets the exact visual state for time t (pure function of t + config)
 *   ready     Promise -> {issues, warnings, claims}; resolves after fonts, images
 *             (including substituted placeholders) are loaded and decoded, and after lint
 *   issues    blocking problems (placeholders, failed images, overflow, validation)
 *   warnings  non-blocking notes (font fallback, colour adjustments)
 *   claims    [{text, source}] for every claim-bearing field
 *   timeline  [{index, type, start, duration, transition, settle, mid}]
 *
 * URL flags: ?capture (no autoplay, no preview UI), ?draft (burn DRAFT mark),
 *            ?format=9:16 (override), ?config=<url relative to this page or absolute>
 */
(function () {
  'use strict';
  const MP = window.MotionPromo;
  const { clamp, prog, ease, r3, el, css } = MP;

  const VERSION = '1.0.0';
  const FORMATS = {
    '4:5': { width: 1080, height: 1350, safe: { top: 96, right: 88, bottom: 96, left: 88 } },
    '1:1': { width: 1080, height: 1080, safe: { top: 84, right: 84, bottom: 84, left: 84 } },
    '9:16': { width: 1080, height: 1920, safe: { top: 260, right: 120, bottom: 420, left: 120 } },
    '16:9': { width: 1920, height: 1080, safe: { top: 84, right: 128, bottom: 84, left: 128 } },
  };
  const SCENE_DEFAULT_DURATION = { title: 2.5, device: 3, compare: 3, mosaic: 2.5, features: 3, stat: 2.5, quote: 3.5, cta: 3 };
  const TRANSITIONS = { cut: 0, fade: 0.45, slide: 0.55, push: 0.55, wipe: 0.75, iris: 0.7, zoom: 0.5 };
  /** Fraction of the incoming transition after which the scene's own entrance begins. */
  const ENTER_AT = { cut: 0, fade: 0.45, slide: 0.3, push: 0.3, wipe: 0.5, iris: 0.05, zoom: 0.45 };

  const params = new URLSearchParams(location.search);
  const CAPTURE = params.has('capture');
  const DRAFT = params.has('draft');

  const promo = (window.promo = {
    version: VERSION,
    duration: 0,
    size: { width: 1080, height: 1350 },
    fps: 30,
    format: '4:5',
    issues: [],
    warnings: [],
    claims: [],
    errors: [],
    timeline: [],
    capture: CAPTURE,
    draft: DRAFT,
    seek: () => {},
    ready: null,
  });
  let resolveReady;
  promo.ready = new Promise((r) => (resolveReady = r));

  const issue = (m) => { if (!promo.issues.includes(m)) promo.issues.push(m); };
  const warn = (m) => { if (!promo.warnings.includes(m)) promo.warnings.push(m); };

  window.addEventListener('error', (e) => {
    const where = e.filename ? ` (${decodeURIComponent(String(e.filename).split('/').pop())}:${e.lineno || '?'})` : '';
    const msg = (e.error && e.error.message) || e.message || 'unknown error';
    promo.errors.push(msg + where);
  });
  window.addEventListener('unhandledrejection', (e) => {
    promo.errors.push('unhandled rejection: ' + ((e.reason && e.reason.message) || String(e.reason)));
  });

  // ---------------------------------------------------------------- helpers
  const withTimeout = (p, ms, label) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + ' ms')), ms))]);

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('could not load config script ' + decodeURIComponent(url)));
      document.head.appendChild(s);
    });
  }

  let CONFIG_URL = '';
  /** Resolve an asset path against the config file. Plain paths are percent-encoded per segment. */
  function assetUrl(src) {
    if (typeof src !== 'string' || !src.trim()) return null;
    const s = src.trim();
    if (/^(data:|blob:|https?:|file:)/i.test(s)) return s;
    const enc = (p) => p.split('/').map((seg) => (seg === '.' || seg === '..' ? seg : encodeURIComponent(seg))).join('/');
    if (s.startsWith('/')) return 'file://' + enc(s);
    return new URL(enc(s), CONFIG_URL).href;
  }

  // ---------------------------------------------------------------- colours
  function derivePalette(base, label) {
    const P = MP;
    const bg = base.background;
    let text = base.text;
    if (P.contrast(text, bg) < 4.5) {
      const fixed = P.ensureContrast(text, bg, 4.5);
      if (label) warn(`colors: text ${P.toCss(text)} on ${P.toCss(bg)} has contrast ${P.contrast(text, bg).toFixed(2)}:1; using ${P.toCss(fixed)} (>= 4.5:1).`);
      text = fixed;
    }
    const accent = base.accent;
    const dark = P.isDark(bg);
    const muted = base.muted ? P.ensureContrast(base.muted, bg, 4.5) : P.ensureContrast(P.mix(text, bg, 0.36), bg, 4.5);
    const surface = base.surface || P.mix(bg, text, dark ? 0.075 : 0.045);
    const surface2 = P.mix(bg, text, dark ? 0.14 : 0.09);
    const accentSoft = P.mix(bg, accent, dark ? 0.2 : 0.13);
    return {
      dark,
      bg, text, accent, muted, surface, surface2, accentSoft,
      line: P.mix(bg, text, dark ? 0.2 : 0.14),
      accentText: P.ensureContrast(accent, bg, 4.5),
      onAccent: P.textOn(accent, [bg, text, P.WHITE, P.INK]),
      accentOnSoft: P.ensureContrast(accent, accentSoft, 4.5),
      textOnSurface: P.ensureContrast(text, surface, 4.5),
      mutedOnSurface: P.ensureContrast(muted, surface, 4.5),
      accentOnSurface: P.ensureContrast(accent, surface, 4.5),
    };
  }
  function paletteVars(p) {
    const c = MP.toCss;
    return {
      '--bg': c(p.bg), '--text': c(p.text), '--muted': c(p.muted), '--accent': c(p.accent),
      '--accent-text': c(p.accentText), '--on-accent': c(p.onAccent), '--surface': c(p.surface),
      '--surface-2': c(p.surface2), '--line': c(p.line), '--accent-soft': c(p.accentSoft),
      '--accent-on-soft': c(p.accentOnSoft), '--text-on-surface': c(p.textOnSurface),
      '--muted-on-surface': c(p.mutedOnSurface), '--accent-on-surface': c(p.accentOnSurface),
      '--shadow-rgb': p.dark ? '0, 0, 0' : '24, 22, 32',
      '--shadow-a': p.dark ? '0.55' : '0.16',
      '--glow': c(p.accent, p.dark ? 0.3 : 0.2),
      '--glow-2': c(MP.mix(p.accent, p.text, 0.35), p.dark ? 0.16 : 0.1),
    };
  }
  function themePalette(base, theme) {
    if (!theme || theme === 'default') return base;
    const P = MP;
    if (theme === 'inverse') {
      return derivePalette({ background: base.text, text: base.bg, accent: base.accent });
    }
    if (theme === 'accent') {
      const bg = base.accent;
      const text = base.onAccent;
      const cands = [base.bg, base.text, P.WHITE, P.INK].filter((c) => P.contrast(c, text) >= 1.6);
      const acc = P.textOn(bg, cands.length ? cands : [text]);
      return derivePalette({ background: bg, text, accent: acc });
    }
    issue(`theme "${theme}" is not one of default | accent | inverse.`);
    return base;
  }

  // ---------------------------------------------------------------- fonts
  const cleanFamily = (f) => String(f || '').replace(/^["']|["']$/g, '').trim().toLowerCase();
  function systemFontAvailable(family) {
    const c = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmmlliWQ@#1';
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      c.font = `72px ${generic}`;
      const w0 = c.measureText(probe).width;
      c.font = `72px "${family}", ${generic}`;
      if (c.measureText(probe).width !== w0) return true;
    }
    return false;
  }
  async function loadFonts(font, allText) {
    await loadFontFamily(font, [font.weights.body, font.weights.strong, font.weights.headline], allText);
    if (font.display) await loadFontFamily(font.display, [font.display.weight || font.weights.headline], allText);
  }
  async function loadFontFamily(font, weightList, allText) {
    const family = font.family;
    const fallback = font.fallback || 'the fallback';
    const weights = [...new Set(weightList)];
    const tried = !!(font.url || (font.files && font.files.length));
    if (font.url) {
      await new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = font.url;
        const done = (ok) => { if (!ok) warn(`font stylesheet did not load: ${font.url}`); resolve(); };
        link.onload = () => done(true);
        link.onerror = () => done(false);
        setTimeout(() => done(false), 10000);
        document.head.appendChild(link);
      });
    }
    for (const f of font.files || []) {
      const url = assetUrl(typeof f === 'string' ? f : f.src);
      if (!url) continue;
      const face = new FontFace(family, `url("${url}")`, {
        weight: String((f && f.weight) || '100 900'),
        style: (f && f.style) || 'normal',
      });
      document.fonts.add(face);
      try { await withTimeout(face.load(), 10000, 'font file'); }
      catch (e) { warn(`font file did not load: ${typeof f === 'string' ? f : f.src} (${e.message || e})`); }
    }
    const sample = (allText || '') + ' AaBbGgQqWw0123456789%$€.,';
    try {
      await withTimeout(Promise.all(weights.map((w) => document.fonts.load(`${w} 64px "${family}"`, sample))), 10000, 'font load');
    } catch (e) { /* reported below */ }
    await withTimeout(document.fonts.ready, 10000, 'fonts').catch(() => {});
    if (tried) {
      const faces = [...document.fonts].filter((f) => cleanFamily(f.family) === cleanFamily(family));
      const loaded = faces.filter((f) => f.status === 'loaded');
      if (!loaded.length) warn(`font "${family}" did not load; frames use the fallback (${fallback}). Offline machines need font.files.`);
      else {
        const have = loaded.map((f) => f.weight);
        const missing = weights.filter((w) => !have.some((h) => weightCovers(h, w)));
        if (missing.length) warn(`font "${family}" has no loaded face for weight ${missing.join(', ')}; the browser will synthesise it.`);
      }
    } else if (!systemFontAvailable(family)) {
      warn(`font "${family}" is not installed on this machine and no font.url / font.files was given; frames use the fallback (${fallback}).`);
    }
  }
  function weightCovers(range, w) {
    const parts = String(range).split(/\s+/).map((x) => (x === 'normal' ? 400 : x === 'bold' ? 700 : parseInt(x, 10)));
    if (parts.length === 1) return parts[0] === w;
    return w >= parts[0] && w <= parts[1];
  }

  // ---------------------------------------------------------------- images
  function loadInto(img, url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok, why) => {
        if (settled) return;
        settled = true;
        img.onload = img.onerror = null;
        if (!ok) return resolve({ ok: false, why });
        (img.decode ? img.decode() : Promise.resolve()).then(
          () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }),
          () => resolve({ ok: img.naturalWidth > 0, why: 'decode failed', w: img.naturalWidth, h: img.naturalHeight })
        );
      };
      img.onload = () => done(true);
      img.onerror = () => done(false, 'failed to load');
      setTimeout(() => done(false, 'timed out'), timeoutMs);
      img.src = url;
      if (img.complete && img.naturalWidth) done(true);
    });
  }
  const pending = [];
  /**
   * Create an <img> for a config image field. Unset -> placeholder card (issue).
   * Failed -> placeholder substituted (issue). `info` is filled in when loading settles.
   */
  function makeImage(src, o) {
    const img = document.createElement('img');
    img.decoding = 'sync';
    img.draggable = false;
    img.alt = '';
    if (o.cls) img.className = o.cls;
    const info = { img, ok: false, placeholder: false, w: 0, h: 0, src };
    const ph = () => {
      info.placeholder = true;
      img.classList.add('is-placeholder');
      const sz = typeof o.phSize === 'function' ? o.phSize() : o.phSize || { w: 800, h: 600 };
      return loadInto(img, MP.placeholderImage('[' + (o.label || 'image') + ']', sz.w, sz.h, o.tone), 5000).then((r) => {
        info.w = r.w || sz.w;
        info.h = r.h || sz.h;
      });
    };
    const url = assetUrl(src);
    let p;
    if (!url) {
      issue(`${o.where}: image not set — placeholder shown (${o.label || 'image'}).`);
      p = o.deferPlaceholder ? Promise.resolve() : ph();
      info.needsPlaceholder = !!o.deferPlaceholder;
    } else {
      p = loadInto(img, url, 20000).then((r) => {
        if (r.ok) { info.ok = true; info.w = r.w; info.h = r.h; return; }
        issue(`${o.where}: image "${src}" ${r.why} — placeholder shown.`);
        if (o.deferPlaceholder) { info.needsPlaceholder = true; return; }
        return ph();
      });
    }
    info.done = p;
    info.fillPlaceholder = ph;
    pending.push(p);
    return info;
  }

  // ---------------------------------------------------------------- config normalisation
  function normalise(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      issue('config: window.PROMO_CONFIG is not defined — the config script must assign it.');
      cfg = { scenes: [], colors: { background: '#f5f3ee', text: '#15151a', accent: '#3b5bfd' }, __missing: true };
    }
    let format = params.get('format') || cfg.format || '4:5';
    let size, safe;
    if (cfg.size && !params.get('format')) {
      size = { width: Math.round(+cfg.size.width), height: Math.round(+cfg.size.height) };
      if (!(size.width > 0 && size.height > 0)) {
        issue('config: size must have positive width and height.');
        size = { width: 1080, height: 1350 };
      }
      format = 'custom';
      const m = Math.round(Math.min(size.width, size.height) * 0.08);
      safe = { top: m, right: m, bottom: m, left: m };
    } else {
      if (!FORMATS[format]) {
        issue(`config: format "${format}" is not supported (use 4:5, 9:16, 1:1 or 16:9); using 4:5.`);
        format = '4:5';
      }
      size = { width: FORMATS[format].width, height: FORMATS[format].height };
      safe = Object.assign({}, FORMATS[format].safe);
    }
    const sz = cfg.safeZone;
    if (sz && typeof sz === 'object') {
      const o = sz[format] && typeof sz[format] === 'object' ? sz[format] : sz;
      for (const k of ['top', 'right', 'bottom', 'left']) {
        if (o[k] == null) continue;
        const v = +o[k];
        if (!(v >= 0 && v < Math.min(size.width, size.height) / 2)) issue(`config: safeZone.${k} (${o[k]}) must be between 0 and half the frame.`);
        else safe[k] = v;
      }
    }
    const colorsIn = cfg.colors || {};
    const need = (k, d) => {
      const c = MP.parseColor(colorsIn[k]);
      if (!c) {
        if (colorsIn[k] == null) issue(`config: colors.${k} is required.`);
        else issue(`config: colors.${k} "${colorsIn[k]}" is not a valid CSS colour.`);
        return MP.parseColor(d);
      }
      return c;
    };
    const base = {
      background: need('background', '#f5f3ee'),
      text: need('text', '#15151a'),
      accent: need('accent', '#3b5bfd'),
      surface: MP.parseColor(colorsIn.surface),
      muted: MP.parseColor(colorsIn.muted),
    };
    const fontIn = cfg.font || {};
    const font = {
      family: fontIn.family || 'Inter',
      url: fontIn.url || null,
      files: Array.isArray(fontIn.files) ? fontIn.files : fontIn.files ? [fontIn.files] : [],
      fallback: fontIn.fallback || 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      weights: Object.assign({ body: 400, strong: 600, headline: 700 }, fontIn.weights || {}),
      tracking: fontIn.tracking != null ? +fontIn.tracking : -0.03,
      display: null,
    };
    if (fontIn.display && typeof fontIn.display === 'object' && fontIn.display.family) {
      const d = fontIn.display;
      font.display = {
        family: d.family, url: d.url || null,
        files: Array.isArray(d.files) ? d.files : d.files ? [d.files] : [],
        weight: d.weight || font.weights.headline, fallback: d.fallback || font.fallback,
        tracking: d.tracking != null ? +d.tracking : null,
      };
    }
    const brand = Object.assign({ name: '', logo: null, logoOnDark: null, url: '' }, cfg.brand || {});
    const scenes = Array.isArray(cfg.scenes) ? cfg.scenes : [];
    if (!scenes.length && !cfg.__missing) issue('config: scenes is empty — add at least one scene.');
    const fps = +cfg.fps > 0 ? +cfg.fps : 30;
    return { cfg, format, size, safe, base, font, brand, scenes, fps, align: cfg.align, valign: cfg.valign };
  }

  function normValign(v, where) {
    if (v == null || v === '') return 'center';
    const s = String(v).toLowerCase();
    if (s === 'middle') return 'center';
    if (['center', 'top', 'bottom'].includes(s)) return s;
    issue(`${where}: valign "${v}" is not one of center | top | bottom; using center.`);
    return 'center';
  }
  function normTransition(tr, index, dur, prevDur) {
    if (tr == null) tr = index === 0 ? 'cut' : 'fade';
    if (typeof tr === 'string') tr = { type: tr };
    let type = String(tr.type || 'cut').toLowerCase();
    if (!(type in TRANSITIONS)) {
      issue(`scene ${index + 1}: transition "${tr.type}" is not one of ${Object.keys(TRANSITIONS).join(', ')}; using cut.`);
      type = 'cut';
    }
    if (type === 'push') type = 'slide';
    let d = tr.duration != null ? +tr.duration : TRANSITIONS[type];
    if (!(d >= 0)) d = TRANSITIONS[type];
    const limit = Math.min(dur * 0.6, prevDur == null ? dur * 0.6 : prevDur * 0.6);
    if (type !== 'cut' && d > limit) d = Math.max(0.1, limit);
    if (type === 'cut') d = 0;
    const dir = ['left', 'right', 'up', 'down'].includes(tr.direction) ? tr.direction : 'left';
    return { type, duration: r3(d), direction: dir };
  }

  // ---------------------------------------------------------------- claims
  function addClaim(text, source, where) {
    const t = String(text || '').trim();
    const s = source == null ? '' : String(source).trim();
    promo.claims.push({ text: t, source: s || null, where });
    if (!s) issue(`${where}: claim "${t}" has no source — add a source (the page or document it comes from).`);
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const configParam = params.get('config') || 'promo.config.js';
    CONFIG_URL = new URL(configParam, location.href).href;
    try {
      await loadScript(CONFIG_URL);
    } catch (e) {
      issue('config: ' + e.message);
    }
    if (promo.errors.length) issue('config: script error — ' + promo.errors.join('; '));
    const N = normalise(window.PROMO_CONFIG);
    const { size, safe } = N;
    promo.size = size;
    promo.fps = N.fps;
    promo.format = N.format;
    promo.safeZone = safe;
    const W = size.width, H = size.height;
    const box = { x: safe.left, y: safe.top, w: W - safe.left - safe.right, h: H - safe.top - safe.bottom };
    const orient = W > H * 1.2 ? 'landscape' : H > W * 1.2 ? 'portrait' : 'square';

    document.documentElement.classList.toggle('capture', CAPTURE);
    const stage = document.getElementById('stage');
    const basePalette = derivePalette(N.base, 'colors');
    css(stage, Object.assign({ width: W + 'px', height: H + 'px' }, paletteVars(basePalette)));
    stage.style.setProperty('--font', `"${N.font.family}", ${N.font.fallback}`);
    stage.style.setProperty('--font-head', N.font.display ? `"${N.font.display.family}", ${N.font.display.fallback}` : 'var(--font)');
    stage.style.setProperty('--w-display', N.font.display ? N.font.display.weight : N.font.weights.headline);
    if (N.font.display && N.font.display.tracking != null) stage.style.setProperty('--track', N.font.display.tracking + 'em');
    stage.style.setProperty('--w-body', N.font.weights.body);
    stage.style.setProperty('--w-strong', N.font.weights.strong);
    stage.style.setProperty('--w-head', N.font.weights.headline);
    stage.style.setProperty('--track', N.font.tracking + 'em');
    stage.dataset.format = N.format;
    stage.dataset.orient = orient;

    // Background layer: brand colour, two drifting glows, static grain.
    const bg = el('div', 'bg', stage);
    const glowA = el('div', 'glow glow-a', bg);
    const glowB = el('div', 'glow glow-b', bg);
    el('div', 'grain', bg);
    const layers = el('div', 'layers', stage);
    const wipeA = el('div', 'wipe wipe-a', stage);
    const wipeB = el('div', 'wipe wipe-b', stage);
    const ring = el('div', 'iris-ring', stage);
    if (DRAFT) {
      const d = el('div', 'draft-mark', stage);
      el('div', 'draft-pill', d).textContent = 'DRAFT · NOT FOR DELIVERY';
      el('div', 'draft-diag', d).textContent = 'DRAFT';
    }

    // Build scenes.
    const built = [];
    const glows = [[glowA, glowB]];
    let start = 0;
    const allText = [];
    N.scenes.forEach((sc, i) => {
      const type = sc && sc.type;
      const where = `scene ${i + 1} (${type || '?'})`;
      const builder = MP.scenes && MP.scenes[type];
      let dur = sc && sc.duration != null ? +sc.duration : NaN;
      if (!builder) {
        issue(`${where}: unknown scene type "${type}". Use one of ${Object.keys(MP.scenes).join(', ')}.`);
        return;
      }
      if (!(dur > 0 && dur <= 30)) {
        const d = SCENE_DEFAULT_DURATION[type] || 2.5;
        issue(`${where}: duration must be a number of seconds between 0 and 30 (got ${sc.duration}); using ${d}.`);
        dur = d;
      }
      const prevDur = built.length ? built[built.length - 1].duration : null;
      const tr = normTransition(sc.transition, built.length, dur, prevDur);
      const palette = themePalette(basePalette, sc.theme);
      const root = el('div', 'scene scene-' + type, layers);
      const sbg = el('div', 'scene-bg', root);
      glows.push([el('div', 'glow glow-a', sbg), el('div', 'glow glow-b', sbg)]);
      el('div', 'grain', sbg);
      css(root, paletteVars(palette));
      if (sc.theme && sc.theme !== 'default') root.classList.add('themed');
      const enter = r3(tr.duration * ENTER_AT[tr.type]);
      const sctx = {
        W, H, box, orient, format: N.format, index: i, where, palette, brand: N.brand, font: N.font,
        enter, duration: dur,
        // `align` is horizontal (left | center); vertical is `valign` (center | top | bottom).
        // align: 'top' | 'bottom' is accepted as a vertical shorthand.
        align: ['left', 'center'].includes(sc.align) ? sc.align : N.align,
        valign: normValign(sc.valign || (['top', 'bottom', 'middle'].includes(sc.align) ? sc.align : null) || N.valign, `scene ${i + 1} (${type})`),
        issue, warn,
        claim: (text, source, field) => addClaim(text, source, `${where} ${field}`),
        image: (src, o) => makeImage(src, Object.assign({ tone: palette.dark ? 'dark' : 'light' }, o, { where: `${where} ${o.field}` })),
        assetUrl,
        lint: [],
        text: (value, field) => {
          if (value == null) return;
          const s = typeof value === 'object' ? value.text : value;
          if (typeof s !== 'string') return;
          allText.push(MP.plainText(s));
          if (MP.isPlaceholderText(s)) issue(`${where} ${field}: placeholder text "${s.replace(/\n/g, ' ')}".`);
          if (MP.parseMarkup(s).unbalanced) warn(`${where} ${field}: odd number of * — accent markup shown literally.`);
          if (typeof value === 'object' && value.source !== undefined) addClaim(MP.plainText(s), value.source, `${where} ${field}`);
        },
        lintText: (e, name, extra) => sctx.lint.push(Object.assign({ el: e, name, kind: 'text' }, extra)),
        lintBlock: (e, name, extra) => sctx.lint.push(Object.assign({ el: e, name, kind: 'block' }, extra)),
      };
      let api;
      try {
        api = builder(sc, sctx, root);
      } catch (e) {
        issue(`${where}: failed to build — ${e.message}`);
        promo.errors.push(`${where}: ${e.stack || e.message}`);
        root.remove();
        return;
      }
      if (sc.source !== undefined && !['stat', 'quote'].includes(type)) {
        addClaim(api.claimText || MP.plainText(sc.headline || sc.caption || ''), sc.source, `${where}`);
      }
      built.push({ type, index: i, where, start, duration: dur, transition: tr, root, sbg, api, sctx, palette, iris: tr.type === 'iris' });
      start += dur;
    });
    promo.duration = r3(start);

    // Wait for fonts + images (placeholders substituted on failure), then fit and lint.
    await loadFonts(N.font, allText.join(' '));
    await Promise.all(pending.slice());
    for (const s of built) {
      try { if (s.api.layout) await s.api.layout(); }
      catch (e) { issue(`${s.where}: layout failed — ${e.message}`); promo.errors.push(e.stack || e.message); }
    }
    await Promise.all(pending.slice());
    await document.fonts.ready;

    promo.timeline = built.map((s) => {
      const settleLocal = Math.min(Math.max(s.api.settle || 0, s.transition.duration + 0.05), s.duration - 1 / 60);
      const mid = s.transition.type !== 'cut' ? s.start + s.transition.duration / 2 : null;
      return {
        index: s.index, type: s.type, start: r3(s.start), duration: s.duration, end: r3(s.start + s.duration),
        transition: s.transition, enter: s.sctx.enter, settle: r3(s.start + settleLocal),
        settleLocal: r3(settleLocal), mid: mid == null ? null : r3(mid),
      };
    });
    built.forEach((s, i) => {
      if ((s.api.settle || 0) > s.duration - 0.25) {
        warn(`${s.where}: entrance animation finishes at ${(s.api.settle || 0).toFixed(2)} s of a ${s.duration} s scene — lengthen the scene or shorten the copy so it can be read.`);
      }
    });

    // ------------------------------------------------------------ seek
    function resetLayer(s) {
      const st = s.root.style;
      // display:none (not visibility) so no child can paint while its scene is off-screen
      st.display = 'none';
      st.visibility = 'visible';
      st.opacity = '1';
      st.transform = 'none';
      st.clipPath = 'none';
      st.zIndex = '';
      s.sbg.style.opacity = s.root.classList.contains('themed') ? '1' : '0';
    }
    function show(s, t) {
      s.root.style.display = '';
      s.api.update(t - s.start);
    }
    function seek(tIn) {
      const t = clamp(Number(tIn) || 0, 0, promo.duration);
      // ambient background drift: pure function of t
      const a = t * 0.35, b = t * 0.27;
      const ga = `translate(${r3(Math.sin(a) * W * 0.06)}px, ${r3(Math.cos(a * 0.8) * H * 0.04)}px)`;
      const gb = `translate(${r3(Math.cos(b) * W * 0.05)}px, ${r3(Math.sin(b * 1.3) * H * 0.05)}px)`;
      for (const g of glows) { g[0].style.transform = ga; g[1].style.transform = gb; }
      wipeA.style.visibility = wipeB.style.visibility = ring.style.visibility = 'hidden';
      built.forEach(resetLayer);
      if (!built.length) return;
      let k = 0;
      for (let i = 0; i < built.length; i++) if (built[i].start <= t + 1e-9) k = i;
      const cur = built[k];
      const tr = cur.transition;
      const prev = k > 0 ? built[k - 1] : null;
      const p = tr.duration > 0 ? prog(t, cur.start, tr.duration) : 1;
      cur.root.style.zIndex = '2';
      if (p < 1 && tr.type !== 'cut') {
        if (prev) { prev.root.style.zIndex = '1'; show(prev, t); }
        applyTransition(tr, p, prev, cur);
        // with wipe, the incoming scene is hidden until the panel covers the frame
        if (!(tr.type === 'wipe' && p < 0.5)) show(cur, t);
        if (tr.type === 'wipe' && p >= 0.5 && prev) prev.root.style.display = 'none';
      } else {
        show(cur, t);
      }
    }
    function applyTransition(tr, p, A, B) {
      const horiz = tr.direction === 'left' || tr.direction === 'right';
      const sign = tr.direction === 'left' || tr.direction === 'up' ? 1 : -1;
      switch (tr.type) {
        case 'fade': {
          // strict dip: the old scene is gone before the new one appears (never text over text)
          if (A) A.root.style.opacity = r3(1 - ease.inOutSine(clamp(p / 0.5)));
          B.root.style.opacity = r3(ease.inOutSine(clamp((p - 0.5) / 0.5)));
          break;
        }
        case 'slide': {
          const e = ease.inOutQuart(p);
          const span = horiz ? W : H;
          const ax = r3(-e * span * sign), bx = r3((1 - e) * span * sign);
          const axis = horiz ? 'X' : 'Y';
          if (A) A.root.style.transform = `translate${axis}(${ax}px)`;
          B.root.style.transform = `translate${axis}(${bx}px)`;
          break;
        }
        case 'zoom': {
          const e1 = ease.inCubic(clamp(p / 0.5));
          const e2 = ease.outCubic(clamp((p - 0.5) / 0.5));
          if (A) { A.root.style.transform = `scale(${r3(1 + 0.14 * e1)})`; A.root.style.opacity = r3(1 - e1); }
          B.root.style.transform = `scale(${r3(0.9 + 0.1 * e2)})`;
          B.root.style.opacity = r3(e2);
          break;
        }
        case 'wipe': {
          // Two skewed colour panels sweep across. The ink panel (B) leads on the way in and
          // trails on the way out; the accent panel (A, on top) covers the whole frame at
          // exactly p = 0.5, which is when the scenes swap.
          const k = H * Math.tan((14 * Math.PI) / 180);
          const PW = W + k + W * 0.12;
          const x0 = -(PW + k / 2) - 8, xc = -(k / 2) - W * 0.06, x1 = W + k / 2 + 8;
          const pos = (q) => (q < 0.5 ? MP.lerp(x0, xc, ease.outCubic(q / 0.5)) : MP.lerp(xc, x1, ease.inCubic((q - 0.5) / 0.5)));
          const lag = 0.08;
          const qB = p < 0.5 - lag ? (0.5 * p) / (0.5 - lag) : p <= 0.5 + lag ? 0.5 : 0.5 + (0.5 * (p - 0.5 - lag)) / (0.5 - lag);
          // `direction` is the way the panels travel (default left: enter from the right,
          // matching slide, where the new scene arrives from the right).
          const toRight = tr.direction === 'right';
          const place = (node, q) => {
            node.style.visibility = q > 0 && q < 1 ? 'visible' : 'hidden';
            node.style.width = r3(PW) + 'px';
            const x = toRight ? pos(q) : W - pos(q) - PW;
            node.style.transform = `translateX(${r3(x)}px) skewX(${toRight ? -14 : 14}deg)`;
          };
          place(wipeB, qB);
          place(wipeA, p);
          break;
        }
        case 'iris': {
          const e = ease.inOutCubic(p);
          const R = Math.hypot(W, H) / 2 + 20;
          const r = r3(R * e);
          B.sbg.style.opacity = '1';
          B.root.style.clipPath = `circle(${r}px at 50% 50%)`;
          if (A) A.root.style.transform = `scale(${r3(1 - 0.05 * e)})`;
          ring.style.visibility = p > 0 && p < 0.98 ? 'visible' : 'hidden';
          ring.style.width = ring.style.height = r3(r * 2) + 'px';
          ring.style.opacity = r3(1 - ease.inCubic(p));
          break;
        }
      }
    }
    /*
     * Capture mode: rebuild the stage's layout tree on every seek. Chrome keeps composited
     * layers and raster tiles between frames, and with transforms/opacity changing that cached
     * state can leak into later frames (measured: stale image content during transitions,
     * off-by-one antialiasing). Toggling display discards it, so each captured frame depends
     * only on t — sequential, backward and sparse (--jobs) seeks give identical pixels.
     */
    function seekCapture(t) {
      seek(t);
      stage.style.display = 'none';
      void stage.offsetHeight;
      stage.style.display = '';
      void stage.offsetHeight;
    }
    promo.seek = CAPTURE ? seekCapture : seek;

    // ------------------------------------------------------------ lint (settled frames)
    function lint() {
      const sr = stage.getBoundingClientRect();
      const sc = sr.width / W || 1;
      const rel = (r) => ({ l: (r.left - sr.left) / sc, t: (r.top - sr.top) / sc, r: (r.right - sr.left) / sc, b: (r.bottom - sr.top) / sc });
      built.forEach((s, i) => {
        const tl = promo.timeline[i];
        seek(tl.settle);
        const rects = [];
        for (const item of s.sctx.lint) {
          const e = item.el;
          if (!e || !e.isConnected || e.offsetParent === null) continue;
          const rr = rel(e.getBoundingClientRect());
          if (rr.r - rr.l < 1 || rr.b - rr.t < 1) continue;
          const name = `${s.where} ${item.name}`;
          if (item.kind === 'text') {
            const ow = e.scrollWidth - e.clientWidth, oh = e.scrollHeight - e.clientHeight;
            const fs = parseFloat(getComputedStyle(e).fontSize) || 16;
            if (ow > 2 + fs * 0.1) issue(`${name}: text overflows its box horizontally by ${Math.round(ow)} px — shorten the copy.`);
            if (item.fixedHeight && oh > 2) issue(`${name}: text overflows its box vertically by ${Math.round(oh)} px — shorten the copy.`);
            // any word outside the frame / box?
            e.querySelectorAll('.w > .wi').forEach((w) => {
              const wr = rel(w.getBoundingClientRect());
              if (wr.r > box.x + box.w + 4 || wr.l < box.x - 4) issue(`${name}: the word "${w.textContent}" is clipped at the safe-zone edge — shorten the copy.`);
            });
          }
          const tol = 2;
          if (rr.l < -tol || rr.t < -tol || rr.r > W + tol || rr.b > H + tol) {
            issue(`${name}: clipped by the frame edge (${edgeDesc(rr, { x: 0, y: 0, w: W, h: H })}).`);
          } else if (!item.allowOutsideSafe && (rr.l < box.x - tol || rr.t < box.y - tol || rr.r > box.x + box.w + tol || rr.b > box.y + box.h + tol)) {
            issue(`${name}: extends outside the safe zone (${edgeDesc(rr, box)}) — shorten the copy or reduce content.`);
          }
          if (item.noOverlap !== false) rects.push({ rr, e, name: item.name });
        }
        for (let a = 0; a < rects.length; a++) {
          for (let b = a + 1; b < rects.length; b++) {
            const A = rects[a], B = rects[b];
            if (A.e.contains(B.e) || B.e.contains(A.e)) continue;
            const ix = Math.min(A.rr.r, B.rr.r) - Math.max(A.rr.l, B.rr.l);
            const iy = Math.min(A.rr.b, B.rr.b) - Math.max(A.rr.t, B.rr.t);
            if (ix > 3 && iy > 3) issue(`${s.where}: ${A.name} overlaps ${B.name} by ${Math.round(Math.min(ix, iy))} px.`);
          }
        }
      });
    }
    function edgeDesc(rr, b) {
      const out = [];
      if (rr.l < b.x) out.push(`left by ${Math.round(b.x - rr.l)} px`);
      if (rr.t < b.y) out.push(`top by ${Math.round(b.y - rr.t)} px`);
      if (rr.r > b.x + b.w) out.push(`right by ${Math.round(rr.r - b.x - b.w)} px`);
      if (rr.b > b.y + b.h) out.push(`bottom by ${Math.round(rr.b - b.y - b.h)} px`);
      return out.join(', ');
    }

    try { lint(); } catch (e) { issue('lint failed: ' + e.message); promo.errors.push(e.stack || e.message); }
    seek(0);
    promo.built = true;
    resolveReady({ issues: promo.issues, warnings: promo.warnings, claims: promo.claims });
    if (!CAPTURE) startPreview(stage);
  }

  // ---------------------------------------------------------------- human preview (not used in capture)
  function startPreview(stage) {
    const ui = document.getElementById('preview-ui');
    const viewport = document.getElementById('viewport');
    ui.hidden = false;
    const W = promo.size.width, H = promo.size.height;
    const fit = () => {
      const availW = window.innerWidth - 48, availH = window.innerHeight - 140;
      const s = Math.min(1, availW / W, availH / H);
      viewport.style.width = W * s + 'px';
      viewport.style.height = H * s + 'px';
      stage.style.transform = `scale(${s})`;
    };
    fit();
    window.addEventListener('resize', fit);
    const btn = ui.querySelector('[data-play]');
    const range = ui.querySelector('input[type=range]');
    const time = ui.querySelector('[data-time]');
    const count = ui.querySelector('[data-issues]');
    const list = ui.querySelector('[data-list]');
    range.max = String(promo.duration);
    const n = promo.issues.length;
    count.textContent = n ? `${n} issue${n > 1 ? 's' : ''}` : 'no issues';
    count.classList.toggle('bad', n > 0);
    list.textContent = '';
    for (const m of promo.issues.concat(promo.warnings.map((w) => 'warning: ' + w))) el('li', null, list).textContent = m;
    count.onclick = () => { list.hidden = !list.hidden; };
    let playing = true, t0 = performance.now(), tAt = 0;
    const setT = (t) => { tAt = t; promo.seek(t); range.value = String(t); time.textContent = t.toFixed(2) + ' / ' + promo.duration.toFixed(2) + ' s'; };
    const loop = (now) => {
      if (playing) setT(((now - t0) / 1000) % promo.duration);
      requestAnimationFrame(loop);
    };
    btn.onclick = () => {
      playing = !playing;
      btn.textContent = playing ? 'Pause' : 'Play';
      if (playing) t0 = performance.now() - tAt * 1000;
    };
    range.oninput = () => { playing = false; btn.textContent = 'Play'; setT(+range.value); };
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); btn.onclick(); }
      if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        playing = false; btn.textContent = 'Play';
        setT(clamp(tAt + (e.code === 'ArrowRight' ? 1 : -1) / 30, 0, promo.duration));
      }
    });
    requestAnimationFrame(loop);
  }

  boot().catch((e) => {
    issue('runtime: ' + e.message);
    promo.errors.push(e.stack || e.message);
    resolveReady({ issues: promo.issues, warnings: promo.warnings, claims: promo.claims });
  });
})();
