/*
 * motion-promo — scene library.
 * MIT License, Copyright (c) 2026 motion-promo contributors.
 *
 * A scene builder receives (sceneConfig, ctx, root) and returns
 *   { layout(): void|Promise   — fit text / size frames once fonts and images are ready
 *     update(t): void          — set every animated property for scene-local time t
 *     settle: number           — local time at which the entrance has finished }
 * update() must be a pure function of t: it always writes every property it animates.
 * Layout is relative to ctx.box (the safe content box), so every format works unchanged.
 */
(function () {
  'use strict';
  const MP = window.MotionPromo;
  const { clamp, lerp, prog, ease, r3, el, css } = MP;
  const S = (MP.scenes = {});

  // ---------------------------------------------------------------- shared pieces
  const GAP = { xs: 12, s: 20, m: 32, l: 48, xl: 88 };

  function boxEl(root, ctx, cls) {
    // vertical placement inside the safe box: valign-center (default) | valign-top | valign-bottom
    const b = el('div', 'box ' + (cls || '') + ' valign-' + (ctx.valign || 'center'), root);
    css(b, { left: ctx.box.x + 'px', top: ctx.box.y + 'px', width: ctx.box.w + 'px', height: ctx.box.h + 'px' });
    return b;
  }
  /**
   * Word reveal: each word rises and fades in, staggered. Nothing clips the words, so a glyph is
   * always drawn whole (at worst translucent) — no partial-glyph fragments at any frame — and an
   * unrevealed word is visibility:hidden, so hidden text is never painted at all.
   */
  function revealWords(words, t, start, o) {
    o = o || {};
    const stagger = o.stagger != null ? o.stagger : 0.055;
    const dur = o.dur || 0.75;
    for (let i = 0; i < words.length; i++) {
      const inner = words[i].firstChild;
      const q = prog(t, start + i * stagger, dur);
      const p = ease.outQuint(q);
      if (q <= 0) {
        inner.style.visibility = 'hidden';
        inner.style.opacity = '0';
        inner.style.transform = 'translateY(45%)';
        continue;
      }
      inner.style.visibility = 'visible';
      inner.style.opacity = String(r3(ease.outCubic(clamp(q / 0.55))));
      inner.style.transform = `translateY(${r3((1 - p) * 45)}%) rotate(${r3((1 - p) * 2.5)}deg)`;
    }
    return start + Math.max(0, words.length - 1) * stagger + dur;
  }
  function wordStagger(n, base) {
    return Math.min(base || 0.055, 0.7 / Math.max(1, n));
  }
  /** Fade + rise entrance. Returns end time. */
  function rise(node, t, start, dur, dist, o) {
    o = o || {};
    const p = (o.ease || ease.outQuint)(prog(t, start, dur));
    const op = clamp(prog(t, start, dur * 0.6));
    node.style.opacity = String(r3(op));
    const extra = o.extra ? ' ' + o.extra(p) : '';
    node.style.transform = `translateY(${r3((1 - p) * dist)}px)${extra}`;
    node.style.visibility = op <= 0 ? 'hidden' : 'visible';
    return start + dur;
  }
  function headlineBlock(parent, text, cls) {
    const h = el('div', 'rich ' + (cls || 'headline'), parent);
    const r = MP.renderWords(h, text || '');
    return { el: h, words: r.words };
  }
  /** Fit a word block; report an issue if it cannot reach the floor size. */
  function fit(ctx, block, o, name) {
    block.style.width = o.width + 'px';
    const res = MP.fitText(block, o);
    if (!res.fits) {
      ctx.issue(`${ctx.where} ${name}: copy does not fit even at the minimum size (${o.min} px) — shorten it.`);
    }
    return res;
  }
  /** Fit inline (non-word-split) text by line count and width. */
  function fitInline(ctx, node, o, name) {
    node.style.width = o.width ? o.width + 'px' : '';
    const lh = o.lineHeight || 1.3;
    for (let size = o.max; size >= o.min; size -= 1) {
      node.style.fontSize = size + 'px';
      const lines = Math.round(node.scrollHeight / (size * lh));
      if (lines <= o.maxLines && node.scrollWidth <= (o.width || node.clientWidth) + 2) return size;
    }
    ctx.issue(`${ctx.where} ${name}: copy does not fit in ${o.maxLines} line(s) at the minimum size (${o.min} px) — shorten it.`);
    return o.min;
  }
  /** Narrow a fitted block to its widest line (for side-by-side layouts); keeps the line breaks. */
  function shrinkWrap(block) {
    const before = MP.countLines(block);
    const w0 = block.style.width;
    const left = block.getBoundingClientRect().left;
    let right = 0;
    block.querySelectorAll('.wi').forEach((w) => { right = Math.max(right, w.getBoundingClientRect().right - left); });
    if (!right) return;
    block.style.width = Math.ceil(right + 2) + 'px';
    if (MP.countLines(block) !== before) block.style.width = w0;
  }
  function isLandscape(ctx) { return ctx.orient === 'landscape'; }
  function alignOf(sc, ctx, dflt) {
    // only left | center are horizontal; align: top | bottom is the vertical shorthand (see main.js)
    const a = (['left', 'center'].includes(sc.align) ? sc.align : null) || ctx.align || dflt;
    return a === 'center' ? 'center' : 'left';
  }
  function svgIcon(name) {
    const paths = {
      check: '<path class="draw" d="M6 12.5l4 4 8-9" pathLength="1"/>',
      arrow: '<path d="M5 12h13M13 6l6 6-6 6"/>',
      dot: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
      chevrons: '<path d="M9 6l-6 6 6 6M15 6l6 6-6 6"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
  }
  function textValue(v) { return v && typeof v === 'object' ? v.text : v; }

  // ================================================================ 1. title
  S.title = function (sc, ctx, root) {
    ctx.text(sc.kicker, 'kicker');
    ctx.text(sc.headline, 'headline');
    ctx.text(sc.subline, 'subline');
    const align = alignOf(sc, ctx, 'left');
    const box = boxEl(root, ctx, 'stack align-' + align);
    const inner = el('div', 'title-inner', box);
    // the ambient scale grows away from the anchored edge, so it never leaves the safe box
    inner.style.transformOrigin = `${align === 'center' ? '50%' : '0'} ${ctx.valign === 'top' ? '0' : ctx.valign === 'bottom' ? '100%' : '50%'}`;
    let kicker = null, kbar = null, ktext = null, sub = null;
    if (textValue(sc.kicker)) {
      kicker = el('div', 'kicker', inner);
      kbar = el('span', 'kbar', kicker);
      ktext = el('span', 'ktext', kicker);
      MP.renderInline(ktext, textValue(sc.kicker));
      ctx.lintText(kicker, 'kicker');
    }
    if (!textValue(sc.headline)) ctx.issue(`${ctx.where} headline: missing.`);
    const h = headlineBlock(inner, textValue(sc.headline) || '', 'headline');
    ctx.lintText(h.el, 'headline');
    if (MP.parseMarkup(textValue(sc.headline)).lines.length > 3) ctx.issue(`${ctx.where} headline: more than 3 forced lines.`);
    if (textValue(sc.subline)) {
      sub = el('div', 'subline', inner);
      MP.renderInline(sub, textValue(sc.subline));
      ctx.lintText(sub, 'subline');
    }
    const e = ctx.enter;
    let wordsStart = 0, wordsEnd = 0, subStart = 0, settle = 1;
    const stag = wordStagger(h.words.length, 0.06);
    return {
      layout() {
        const W = ctx.box.w * 0.97;
        let used = 0;
        if (kicker) { kicker.style.maxWidth = W + 'px'; used += kicker.offsetHeight + GAP.m; }
        if (sub) {
          fitInline(ctx, sub, { width: Math.min(W, ctx.box.w * (align === 'center' ? 0.9 : 0.86)), max: isLandscape(ctx) ? 44 : 42, min: 30, maxLines: 3 }, 'subline');
          used += sub.offsetHeight + GAP.m;
        }
        const max = sc.maxSize || Math.round(Math.min(180, ctx.box.w * 0.16, ctx.box.h * 0.22));
        fit(ctx, h.el, { width: W, height: (ctx.box.h - used) * 0.98, max, min: sc.minSize || 56, maxLines: 3 }, 'headline');
        wordsStart = e + (kicker ? 0.22 : 0.06);
        wordsEnd = wordsStart + Math.max(0, h.words.length - 1) * stag + 0.75;
        subStart = wordsEnd - 0.4;
        settle = sub ? subStart + 0.7 : wordsEnd;
        this.settle = settle;
      },
      settle,
      update(t) {
        if (kicker) {
          const pb = ease.outQuart(prog(t, e, 0.5));
          kbar.style.transform = `scaleX(${r3(pb)})`;
          rise(ktext, t, e + 0.12, 0.6, 22);
        }
        revealWords(h.words, t, wordsStart, { stagger: stag, dur: 0.75 });
        if (sub) rise(sub, t, subStart, 0.7, 26);
        // slow ambient push so the hold never feels frozen
        const drift = ease.outCubic(prog(t, e, ctx.duration + 1));
        inner.style.transform = `scale(${r3(1 + 0.015 * drift)})`;
      },
    };
  };

  // ================================================================ 2. device
  const DEVICE = {
    phone: { aspect: 9.35 / 19.5, ph: { w: 1170, h: 2532 }, label: 'App screenshot (portrait)' },
    browser: { aspect: 1.6, ph: { w: 1440, h: 900 }, label: 'Website screenshot' },
    laptop: { aspect: 1.6, ph: { w: 1440, h: 900 }, label: 'Website screenshot' },
  };
  S.device = function (sc, ctx, root) {
    let frame = sc.frame || 'phone';
    if (!DEVICE[frame]) { ctx.issue(`${ctx.where} frame: "${frame}" is not phone | browser | laptop.`); frame = 'phone'; }
    ctx.text(sc.caption, 'caption');
    const D = DEVICE[frame];
    const row = isLandscape(ctx) || (ctx.orient === 'square' && frame === 'phone');
    const align = alignOf(sc, ctx, row ? 'left' : 'center');
    const box = boxEl(root, ctx, (row ? 'split' : 'stack') + ' align-' + align);
    let cap = null;
    if (textValue(sc.caption)) {
      cap = headlineBlock(box, textValue(sc.caption), 'headline caption');
      ctx.lintText(cap.el, 'caption');
    }
    const area = el('div', 'device-area', box);
    const dev = el('div', 'device device-' + frame, area);
    let screen, bar = null, base = null;
    if (frame === 'phone') {
      screen = el('div', 'screen', dev);
    } else {
      const lid = frame === 'laptop' ? el('div', 'lid', dev) : dev;
      bar = el('div', 'bar', lid);
      const dots = el('div', 'dots', bar);
      el('i', null, dots); el('i', null, dots); el('i', null, dots);
      const url = el('div', 'url', bar);
      url.textContent = String(sc.url || ctx.brand.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '') || ' ';
      screen = el('div', 'screen', lid);
      if (frame === 'laptop') base = el('div', 'base', dev);
    }
    const shot = ctx.image(sc.image, { field: 'image', label: sc.imageLabel || D.label, cls: 'shot', phSize: D.ph });
    screen.appendChild(shot.img);
    if (frame === 'phone') el('div', 'island', screen);
    let tap = null, tapDot = null, tapRing = null;
    if (sc.tap && typeof sc.tap === 'object') {
      tap = el('div', 'tap', screen);
      tapRing = el('div', 'tap-ring', tap);
      tapDot = el('div', 'tap-dot', tap);
    }
    ctx.lintBlock(dev, 'device');

    const e = ctx.enter;
    const L = { scale: 1, scrollMax: 0, cover: false, offX: 0, scrollStart: 0, scrollEnd: 0, devStart: e + 0.08, capStart: e, settle: 1, tapAt: 0 };
    let capStag = 0.05;
    return {
      layout() {
        let areaW, areaH;
        if (row) {
          const capW = cap ? Math.round(ctx.box.w * (frame === 'phone' ? 0.5 : 0.4)) : 0;
          if (cap) { fit(ctx, cap.el, { width: capW, height: ctx.box.h * 0.8, max: sc.captionSize || (isLandscape(ctx) ? 104 : 76), min: 44, maxLines: 4 }, 'caption'); shrinkWrap(cap.el); }
          areaW = ctx.box.w - (cap ? capW + GAP.xl : 0);
          areaH = ctx.box.h;
        } else {
          if (cap) fit(ctx, cap.el, { width: ctx.box.w, height: ctx.box.h * 0.22, max: sc.captionSize || 84, min: 44, maxLines: 2 }, 'caption');
          areaW = ctx.box.w;
          areaH = ctx.box.h - (cap ? cap.el.offsetHeight + GAP.l : 0);
        }
        area.style.width = areaW + 'px';
        area.style.height = areaH + 'px';
        // leave room for the gentle float and the entrance overshoot
        const aw = areaW - 8, ah = areaH - 24;
        let dw, dh, sw, sh;
        if (frame === 'phone') {
          dh = Math.min(ah, aw / D.aspect);
          dw = dh * D.aspect;
          const bez = dw * 0.034;
          sw = dw - 2 * bez; sh = dh - 2 * bez;
          css(dev, { width: r3(dw) + 'px', height: r3(dh) + 'px', padding: r3(bez) + 'px', borderRadius: r3(dw * 0.155) + 'px' });
          css(screen, { borderRadius: r3(dw * 0.155 - bez) + 'px' });
        } else {
          const nat = shot.w && shot.h ? shot.w / shot.h : 1.6;
          // window shape follows the frame so the device fills portrait formats; the page scrolls inside
          const baseAspect = sc.screenAspect || (isLandscape(ctx) ? 1.6 : ctx.orient === 'square' ? 1.35 : 1.15);
          const screenAspect = nat > baseAspect ? Math.min(nat, 2.2) : baseAspect;
          const baseH = frame === 'laptop' ? 0.045 : 0;
          const lidScale = frame === 'laptop' ? 1 / 1.14 : 1;
          const barRatio = 0.062;
          // total height = lidW*(barRatio + 1/aspect) + baseH*fullW
          const hPerW = lidScale * (barRatio + 1 / screenAspect) + baseH;
          const fullW = Math.min(aw, ah / hPerW);
          const lidW = fullW * lidScale;
          sw = lidW; sh = lidW / screenAspect;
          dw = fullW; dh = fullW * hPerW;
          const barH = lidW * barRatio;
          css(dev, { width: r3(dw) + 'px', height: r3(dh) + 'px' });
          if (frame === 'laptop') css(dev.querySelector('.lid'), { width: r3(lidW) + 'px', borderRadius: r3(lidW * 0.02) + 'px' });
          else css(dev, { borderRadius: r3(lidW * 0.022) + 'px' });
          css(bar, { height: r3(barH) + 'px', '--bar-h': r3(barH) + 'px' });
          if (base) css(base, { height: r3(fullW * baseH) + 'px' });
        }
        css(screen, { width: r3(sw) + 'px', height: r3(sh) + 'px' });
        if (row) area.style.width = r3(Math.min(areaW, dw + 16)) + 'px';
        // image placement: fit width and scroll, or cover when the shot is wider than the screen
        const nw = shot.w || 1, nh = shot.h || 1;
        const dispH = sw * (nh / nw);
        if (dispH >= sh) {
          L.cover = false; L.scale = sw / nw;
          css(shot.img, { width: r3(sw) + 'px', height: r3(dispH) + 'px', left: '0px' });
          let maxScroll = dispH - sh;
          if (sc.scroll === false) maxScroll = 0;
          else if (typeof sc.scroll === 'number') maxScroll = Math.min(maxScroll, sc.scroll * L.scale);
          else maxScroll = Math.min(maxScroll, sh * 2.2);
          L.scrollMax = Math.max(0, maxScroll);
        } else {
          L.cover = true; L.scale = sh / nh;
          const w = nw * L.scale;
          L.offX = (w - sw) / 2;
          css(shot.img, { width: r3(w) + 'px', height: r3(sh) + 'px', left: r3(-L.offX) + 'px' });
          L.scrollMax = 0;
        }
        capStag = cap ? wordStagger(cap.words.length, 0.05) : 0;
        const capEnd = cap ? L.capStart + (cap.words.length - 1) * capStag + 0.7 : e;
        L.devStart = e + (cap ? 0.18 : 0.05);
        const devEnd = L.devStart + 0.95;
        L.settle = Math.max(capEnd, devEnd);
        L.scrollStart = L.settle + 0.2;
        L.scrollEnd = Math.max(L.scrollStart + 0.6, ctx.duration - 0.45);
        if (L.scrollMax > 0 && L.scrollEnd - L.scrollStart < 0.8) {
          ctx.warn(`${ctx.where}: scene is short for scrolling the screenshot; scroll will be quick.`);
        }
        if (tap) {
          const at = sc.tap.at != null ? +sc.tap.at : L.scrollMax > 0 ? Math.min(L.scrollEnd + 0.15, ctx.duration - 0.35) : Math.min(L.settle + 0.35, ctx.duration - 0.35);
          L.tapAt = at;
          const sy = this.scrollAt(at);
          const px = sc.tap.x * L.scale - (L.cover ? L.offX : 0);
          const py = sc.tap.y * L.scale - sy;
          if (!(px >= 0 && px <= sw && py >= 0 && py <= sh)) {
            ctx.issue(`${ctx.where} tap: point (${sc.tap.x}, ${sc.tap.y}) is not on the visible screen at ${at.toFixed(2)} s.`);
          }
          const size = Math.max(36, sw * 0.12);
          css(tap, { '--tap': r3(size) + 'px' });
        }
        this.settle = L.settle;
      },
      scrollAt(t) {
        if (L.scrollMax <= 0) return 0;
        return L.scrollMax * ease.inOutCubic(prog(t, L.scrollStart, L.scrollEnd - L.scrollStart));
      },
      settle: 1,
      update(t) {
        if (cap) revealWords(cap.words, t, L.capStart, { stagger: capStag, dur: 0.7 });
        const p = prog(t, L.devStart, 0.95);
        const py = ease.outQuint(p), ps = ease.outBack(p, 1.1);
        const float = Math.sin(Math.max(0, t - L.devStart) * 1.3) * 5 * ease.outCubic(prog(t, L.devStart + 0.6, 0.8));
        dev.style.opacity = String(r3(clamp(p / 0.3)));
        dev.style.visibility = p <= 0 ? 'hidden' : 'visible';
        dev.style.transform = `translateY(${r3((1 - py) * 110 + float)}px) scale(${r3(0.9 + 0.1 * ps)}) rotateX(${r3((1 - py) * 16)}deg)`;
        const sy = this.scrollAt(t);
        shot.img.style.transform = `translateY(${r3(-sy)}px)`;
        if (tap) {
          const x = sc.tap.x * L.scale - (L.cover ? L.offX : 0);
          const y = sc.tap.y * L.scale - sy;
          tap.style.transform = `translate(${r3(x)}px, ${r3(y)}px)`;
          const appear = ease.outBack(prog(t, L.tapAt - 0.3, 0.3), 1.8);
          const press = 1 - 0.18 * Math.sin(Math.PI * prog(t, L.tapAt, 0.22));
          tapDot.style.transform = `translate(-50%, -50%) scale(${r3(appear * press)})`;
          tapDot.style.opacity = String(r3(clamp(appear)));
          const rp = prog(t, L.tapAt, 0.75);
          tapRing.style.opacity = String(r3(rp > 0 && rp < 1 ? 0.7 * (1 - ease.outCubic(rp)) : 0));
          tapRing.style.transform = `translate(-50%, -50%) scale(${r3(1 + 2.2 * ease.outCubic(rp))})`;
        }
      },
    };
  };

  // ================================================================ 3. compare
  function parseAspect(a) {
    if (typeof a === 'number' && a > 0) return a;
    if (typeof a === 'string') {
      const m = a.match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/);
      if (m) return +m[1] / +m[2];
    }
    return null;
  }
  S.compare = function (sc, ctx, root) {
    ctx.text(sc.headline, 'headline');
    const fromLabel = sc.fromLabel != null ? sc.fromLabel : 'Input';
    const toLabel = sc.toLabel != null ? sc.toLabel : 'Output';
    ctx.text(fromLabel, 'fromLabel');
    ctx.text(toLabel, 'toLabel');
    const row = isLandscape(ctx) && !!textValue(sc.headline);
    const align = alignOf(sc, ctx, row ? 'left' : 'center');
    const box = boxEl(root, ctx, (row ? 'split' : 'stack') + ' align-' + align);
    let head = null;
    if (textValue(sc.headline)) { head = headlineBlock(box, textValue(sc.headline), 'headline caption'); ctx.lintText(head.el, 'headline'); }
    const area = el('div', 'compare-area', box);
    const card = el('div', 'cmp-card', area);
    const ph = isLandscape(ctx) ? { w: 1500, h: 1000 } : { w: 1000, h: 1250 };
    const A = ctx.image(sc.from, { field: 'from', label: sc.fromImageLabel || 'Input image', cls: 'cmp-img', phSize: ph });
    const B = ctx.image(sc.to, { field: 'to', label: sc.toImageLabel || 'Output image', cls: 'cmp-img cmp-to', phSize: ph });
    card.appendChild(A.img);
    card.appendChild(B.img);
    const la = el('div', 'chip cmp-label from', card); MP.renderInline(la, fromLabel);
    const lb = el('div', 'chip cmp-label to', card); MP.renderInline(lb, toLabel);
    const div = el('div', 'cmp-divider', card);
    const knob = el('div', 'cmp-knob', div);
    knob.innerHTML = svgIcon('chevrons');
    ctx.lintBlock(card, 'image card');
    const split = clamp(sc.split != null ? +sc.split : 0.5, 0.1, 0.9);
    const e = ctx.enter;
    const L = { cardStart: e + 0.08, sweepStart: 0, sweepEnd: 0, settle: 1, hStag: 0.05 };
    return {
      layout() {
        let aw, ah;
        if (row) {
          const hw = Math.round(ctx.box.w * 0.38);
          fit(ctx, head.el, { width: hw, height: ctx.box.h * 0.8, max: 100, min: 44, maxLines: 4 }, 'headline');
          shrinkWrap(head.el);
          aw = ctx.box.w - hw - GAP.xl; ah = ctx.box.h;
        } else {
          if (head) fit(ctx, head.el, { width: ctx.box.w, height: ctx.box.h * 0.22, max: 84, min: 44, maxLines: 2 }, 'headline');
          aw = ctx.box.w; ah = ctx.box.h - (head ? head.el.offsetHeight + GAP.l : 0);
        }
        css(area, { width: aw + 'px', height: ah + 'px' });
        const natA = A.ok && A.w ? A.w / A.h : null, natB = B.ok && B.w ? B.w / B.h : null;
        const nat = natB || natA;
        const range = isLandscape(ctx) ? [1.2, 1.9] : ctx.orient === 'square' ? [0.85, 1.3] : [0.72, 1.0];
        let aspect = parseAspect(sc.aspect) || (nat ? clamp(nat, range[0], range[1]) : isLandscape(ctx) ? 1.5 : ctx.orient === 'square' ? 1.1 : 0.8);
        aspect = clamp(aspect, 0.5, 2.2);
        const cw = Math.min(aw - 8, (ah - 28) * aspect);
        css(card, { width: r3(cw) + 'px', height: r3(cw / aspect) + 'px', borderRadius: r3(Math.max(18, cw * 0.035)) + 'px' });
        if (row) area.style.width = r3(cw + 8) + 'px';
        if (head) L.hStag = wordStagger(head.words.length, 0.05);
        const headEnd = head ? e + (head.words.length - 1) * L.hStag + 0.7 : e;
        L.cardStart = e + (head ? 0.16 : 0.04);
        L.sweepStart = L.cardStart + 0.45;
        L.sweepEnd = L.sweepStart + 1.05;
        L.settle = Math.max(headEnd, L.sweepEnd + 0.05);
        this.settle = L.settle;
      },
      settle: 1,
      update(t) {
        if (head) revealWords(head.words, t, e, { stagger: L.hStag, dur: 0.7 });
        rise(card, t, L.cardStart, 0.8, 70, { extra: (p) => `scale(${r3(0.94 + 0.06 * p)})` });
        const sp = ease.inOutCubic(prog(t, L.sweepStart, L.sweepEnd - L.sweepStart));
        const pos = lerp(1, split, sp); // fraction from the left where "to" begins
        B.img.style.clipPath = `inset(0 0 0 ${r3(pos * 100)}%)`;
        div.style.left = r3(pos * 100) + '%';
        const dv = clamp(prog(t, L.sweepStart - 0.1, 0.3));
        div.style.opacity = String(r3(pos < 0.995 ? dv : 0));
        knob.style.transform = `translate(-50%, -50%) scale(${r3(0.6 + 0.4 * ease.outBack(dv, 1.6))})`;
        const k = 1 + 0.05 * ease.inOutSine(prog(t, L.cardStart, ctx.duration + 0.8));
        A.img.style.transform = B.img.style.transform = `scale(${r3(k)})`;
        la.style.opacity = String(r3(clamp(prog(t, L.cardStart + 0.3, 0.4)) * clamp((pos - 0.18) / 0.12)));
        lb.style.opacity = String(r3(clamp((0.86 - pos) / 0.12)));
      },
    };
  };

  // ================================================================ 4. mosaic
  function gridShape(count, aw, ah) {
    let best = null;
    const target = aw > ah * 1.3 ? 1.15 : 1.0;
    for (let c = 2; c <= 7; c++) {
      const r = Math.ceil(count / c);
      if (r < 1 || r > 7) continue;
      const cellA = aw / c / (ah / r);
      const score = Math.abs(Math.log(cellA / target)) + 0.22 * (c * r - count);
      if (!best || score < best.score) best = { c, r, score };
    }
    return best;
  }
  /** Assign image indices to cells so equal images are not horizontal/vertical neighbours. */
  function assignCells(n, cols, rows) {
    const out = [];
    const used = new Array(n).fill(0);
    for (let i = 0; i < cols * rows; i++) {
      const c = i % cols;
      const avoid = new Set();
      if (c > 0) avoid.add(out[i - 1]);
      if (i >= cols) avoid.add(out[i - cols]);
      if (i >= cols && c > 0) avoid.add(out[i - cols - 1]);
      if (i >= cols && c < cols - 1) avoid.add(out[i - cols + 1]);
      const order = [...Array(n).keys()].sort((a, b) => used[a] - used[b] || a - b);
      let pick = order.find((k) => !avoid.has(k));
      if (pick === undefined) pick = order.find((k) => k !== out[i - 1] && k !== out[i - cols]);
      if (pick === undefined) pick = order[0];
      out.push(pick);
      used[pick]++;
    }
    return out;
  }
  S.mosaic = function (sc, ctx, root) {
    ctx.text(sc.headline, 'headline');
    const srcs = (Array.isArray(sc.images) ? sc.images : []).filter((s) => typeof s === 'string' && s.trim());
    let count = sc.count != null ? Math.round(+sc.count) : null;
    if (count != null && (count < 6 || count > 20)) {
      ctx.issue(`${ctx.where} count: must be 6–20 (got ${sc.count}).`);
      count = clamp(count, 6, 20);
    }
    const align = alignOf(sc, ctx, 'center');
    const box = boxEl(root, ctx, 'stack align-' + align);
    let head = null;
    if (textValue(sc.headline)) { head = headlineBlock(box, textValue(sc.headline), 'headline caption'); ctx.lintText(head.el, 'headline'); }
    const area = el('div', 'mosaic-area', box);
    const grid = el('div', 'mosaic-grid', area);
    ctx.lintBlock(grid, 'grid');
    if (!srcs.length) ctx.issue(`${ctx.where} images: none set — placeholder cells shown.`);
    const infos = srcs.map((s, i) => ctx.image(s, { field: `images[${i}]`, label: 'Image', deferPlaceholder: true, phSize: { w: 800, h: 800 } }));
    const cells = [];
    const e = ctx.enter;
    const L = { settle: 1, hStag: 0.05, gridStart: e };
    return {
      async layout() {
        if (head) {
          fit(ctx, head.el, { width: ctx.box.w, height: ctx.box.h * 0.24, max: sc.headlineSize || (isLandscape(ctx) ? 96 : 88), min: 44, maxLines: 2 }, 'headline');
          L.hStag = wordStagger(head.words.length, 0.05);
        }
        const aw = ctx.box.w, ah = ctx.box.h - (head ? head.el.offsetHeight + GAP.l : 0);
        css(area, { width: aw + 'px', height: ah + 'px' });
        const want = count || (isLandscape(ctx) ? 12 : ctx.orient === 'square' ? 9 : 12);
        const shape = gridShape(want, aw, ah);
        const gap = Math.round(Math.min(aw, ah) * 0.018) + 6;
        const cellW = (aw - gap * (shape.c - 1)) / shape.c;
        const cellH = Math.min((ah - 16 - gap * (shape.r - 1)) / shape.r, cellW * 1.25);
        const gw = cellW * shape.c + gap * (shape.c - 1), gh = cellH * shape.r + gap * (shape.r - 1);
        css(grid, { width: r3(gw) + 'px', height: r3(gh) + 'px', gridTemplateColumns: `repeat(${shape.c}, 1fr)`, gridTemplateRows: `repeat(${shape.r}, 1fr)`, gap: gap + 'px' });
        const real = infos.filter((i) => i.ok);
        const n = shape.c * shape.r;
        const assign = real.length ? assignCells(real.length, shape.c, shape.r) : null;
        const waits = [];
        const cx = (shape.c - 1) / 2, cy = (shape.r - 1) / 2;
        for (let i = 0; i < n; i++) {
          const cell = el('div', 'cell', grid);
          const img = el('img', 'cell-img', cell);
          img.decoding = 'sync';
          img.alt = '';
          if (assign) img.src = real[assign[i]].img.src;
          else { img.src = MP.placeholderImage(`[Image ${i + 1}]`, 600, 600 * (cellH / cellW), ctx.palette.dark ? 'dark' : 'light'); img.classList.add('is-placeholder'); }
          waits.push(img.decode().catch(() => {}));
          const c = i % shape.c, r = Math.floor(i / shape.c);
          const d = Math.hypot((c - cx) * 1.0, (r - cy) * 1.15) + (c + r) * 0.04;
          cells.push({ cell, img, d });
          css(cell, { borderRadius: r3(Math.max(10, Math.min(cellW, cellH) * 0.075)) + 'px' });
        }
        await Promise.all(waits);
        const maxD = Math.max(...cells.map((c) => c.d)) || 1;
        L.gridStart = e + (head ? 0.2 : 0.04);
        cells.forEach((c) => (c.delay = L.gridStart + (c.d / maxD) * 0.6));
        const headEnd = head ? e + (head.words.length - 1) * L.hStag + 0.7 : e;
        L.settle = Math.max(headEnd, L.gridStart + 0.6 + 0.65);
        this.settle = L.settle;
      },
      settle: 1,
      update(t) {
        if (head) revealWords(head.words, t, e, { stagger: L.hStag, dur: 0.7 });
        for (const c of cells) {
          const p = prog(t, c.delay, 0.65);
          const s = ease.outBack(p, 1.35);
          c.cell.style.opacity = String(r3(clamp(p / 0.35)));
          c.cell.style.visibility = p <= 0 ? 'hidden' : 'visible';
          c.cell.style.transform = `translateY(${r3((1 - ease.outQuint(p)) * 36)}px) scale(${r3(0.8 + 0.2 * s)})`;
          const kb = ease.outCubic(prog(t, c.delay, 2.4));
          c.img.style.transform = `scale(${r3(1.14 - 0.14 * kb)})`;
        }
      },
    };
  };

  // ================================================================ 5. features
  S.features = function (sc, ctx, root) {
    ctx.text(sc.headline, 'headline');
    const items = Array.isArray(sc.items) ? sc.items.slice() : [];
    if (items.length < 2 || items.length > 4) ctx.issue(`${ctx.where} items: use 2–4 benefit lines (got ${items.length}).`);
    const list = items.slice(0, 4);
    list.forEach((it, i) => ctx.text(it, `items[${i}]`));
    const row = isLandscape(ctx) && !!textValue(sc.headline);
    const align = alignOf(sc, ctx, 'left');
    const box = boxEl(root, ctx, (row ? 'split' : 'stack') + ' align-' + align);
    let head = null;
    if (textValue(sc.headline)) { head = headlineBlock(box, textValue(sc.headline), 'headline caption'); ctx.lintText(head.el, 'headline'); }
    const ul = el('div', 'feat-list', box);
    const mark = sc.marks || 'check';
    const rows = list.map((it, i) => {
      const r = el('div', 'feat', ul);
      const icon = el('div', 'feat-icon', r);
      if (mark === 'number') { icon.classList.add('num'); icon.textContent = String(i + 1); }
      else icon.innerHTML = svgIcon(mark === 'dot' ? 'dot' : 'check');
      const tx = el('div', 'feat-text', r);
      MP.renderInline(tx, textValue(it) || '');
      ctx.lintText(tx, `item ${i + 1}`, { noOverlap: false });
      ctx.lintBlock(r, `item ${i + 1} card`);
      return { r, icon, tx, path: icon.querySelector('.draw') };
    });
    const e = ctx.enter;
    const L = { settle: 1, hStag: 0.05, itemsStart: e };
    return {
      layout() {
        let listW = ctx.box.w, availH = ctx.box.h;
        if (row) {
          const hw = Math.round(ctx.box.w * 0.4);
          fit(ctx, head.el, { width: hw, height: ctx.box.h * 0.8, max: 104, min: 48, maxLines: 4 }, 'headline');
          shrinkWrap(head.el);
          listW = Math.min(ctx.box.w - hw - GAP.xl, 1000);
        } else if (head) {
          fit(ctx, head.el, { width: ctx.box.w, height: ctx.box.h * 0.3, max: sc.headlineSize || 108, min: 48, maxLines: 3 }, 'headline');
          availH -= head.el.offsetHeight + GAP.l;
        }
        ul.style.width = listW + 'px';
        let size = sc.textSize || 54;
        const min = 30;
        for (; size >= min; size -= 1) {
          ul.style.setProperty('--fs', size + 'px');
          const tooTall = ul.offsetHeight > availH - 8;
          const tooManyLines = rows.some((x) => x.tx.scrollHeight > size * 1.28 * 2 + 2);
          if (!tooTall && !tooManyLines) break;
        }
        if (size < min) {
          ul.style.setProperty('--fs', min + 'px');
          ctx.issue(`${ctx.where} items: benefit lines do not fit (max 2 lines each) at the minimum size — shorten them.`);
        }
        if (head) L.hStag = wordStagger(head.words.length, 0.05);
        const headEnd = head ? e + (head.words.length - 1) * L.hStag + 0.7 : e;
        L.itemsStart = e + (head ? 0.4 : 0.08);
        L.settle = Math.max(headEnd, L.itemsStart + (rows.length - 1) * 0.16 + 0.8);
        this.settle = L.settle;
      },
      settle: 1,
      update(t) {
        if (head) revealWords(head.words, t, e, { stagger: L.hStag, dur: 0.7 });
        rows.forEach((x, i) => {
          const s = L.itemsStart + i * 0.16;
          const p = ease.outQuint(prog(t, s, 0.75));
          x.r.style.opacity = String(r3(clamp(prog(t, s, 0.4))));
          x.r.style.visibility = t < s ? 'hidden' : 'visible';
          x.r.style.transform = `translateX(${r3((1 - p) * -48)}px)`;
          const ip = ease.outBack(prog(t, s + 0.1, 0.5), 2);
          x.icon.style.transform = `scale(${r3(0.4 + 0.6 * ip)})`;
          if (x.path) x.path.style.strokeDashoffset = String(r3(1 - ease.outCubic(prog(t, s + 0.22, 0.45))));
        });
      },
    };
  };

  // ================================================================ 6. stat
  S.stat = function (sc, ctx, root) {
    ctx.text(sc.kicker, 'kicker');
    ctx.text(sc.value, 'value');
    ctx.text(sc.label, 'label');
    ctx.text(sc.footnote, 'footnote');
    const value = String(sc.value == null ? '' : sc.value);
    if (!value) ctx.issue(`${ctx.where} value: missing.`);
    ctx.claim(`${value} ${MP.plainText(sc.label || '')}`.trim(), sc.source, 'value');
    const num = MP.parseNumber(value);
    const align = alignOf(sc, ctx, 'center');
    const box = boxEl(root, ctx, 'stack align-' + align);
    let kicker = null;
    if (sc.kicker) { kicker = el('div', 'kicker solo', box); MP.renderInline(kicker, sc.kicker); ctx.lintText(kicker, 'kicker'); }
    const numEl = el('div', 'stat-num', box);
    numEl.textContent = value;
    const rule = el('div', 'stat-rule', box);
    const label = el('div', 'stat-label', box);
    MP.renderInline(label, sc.label || '');
    let foot = null;
    if (sc.footnote) { foot = el('div', 'footnote', box); MP.renderInline(foot, sc.footnote); ctx.lintText(foot, 'footnote'); }
    ctx.lintText(numEl, 'value');
    ctx.lintText(label, 'label');
    const e = ctx.enter;
    const L = { settle: 1, countEnd: e + 1.4 };
    return {
      layout() {
        numEl.textContent = value;
        const lab = fitInline(ctx, label, { width: ctx.box.w * 0.9, max: 50, min: 32, maxLines: 2 }, 'label');
        void lab;
        let used = label.offsetHeight + GAP.l + 24 + (kicker ? kicker.offsetHeight + GAP.l : 0) + (foot ? foot.offsetHeight + GAP.m : 0);
        const maxH = (ctx.box.h - used) / 0.95;
        let size = Math.round(Math.min(sc.maxSize || 340, maxH, ctx.box.w * 0.4));
        for (; size >= 96; size -= 2) {
          numEl.style.fontSize = size + 'px';
          if (numEl.scrollWidth <= ctx.box.w * 0.96) break;
        }
        if (size < 96) ctx.issue(`${ctx.where} value: "${value}" is too long to fit — shorten it.`);
        numEl.style.minWidth = numEl.scrollWidth + 'px';
        L.countEnd = e + 0.1 + 1.3;
        L.settle = Math.max(L.countEnd, e + 0.9 + 0.7);
        this.settle = L.settle;
      },
      settle: 1,
      update(t) {
        if (kicker) rise(kicker, t, e, 0.6, 20);
        rise(numEl, t, e + 0.05, 0.7, 40);
        if (num) {
          const p = ease.outExpo(prog(t, e + 0.1, 1.3));
          numEl.textContent = MP.formatNumber(num.value * p, num);
        }
        rule.style.transform = `scaleX(${r3(ease.outQuart(prog(t, e + 0.5, 0.8)))})`;
        rise(label, t, e + 0.7, 0.7, 24);
        if (foot) rise(foot, t, e + 0.95, 0.6, 16);
      },
    };
  };

  // ================================================================ 7. quote
  S.quote = function (sc, ctx, root) {
    ctx.text(sc.text, 'text');
    ctx.text(sc.author, 'author');
    ctx.text(sc.role, 'role');
    if (!sc.text) ctx.issue(`${ctx.where} text: missing.`);
    if (!sc.author) ctx.issue(`${ctx.where} author: missing — a quote needs a real, attributable person or organisation.`);
    ctx.claim(`“${MP.plainText(sc.text || '')}” — ${sc.author || '?'}`, sc.source, 'text');
    const align = alignOf(sc, ctx, 'left');
    const box = boxEl(root, ctx, 'stack align-' + align);
    const mark = el('div', 'q-mark', box);
    mark.textContent = '“';
    const q = headlineBlock(box, sc.text || '', 'q-text');
    ctx.lintText(q.el, 'text');
    const attr = el('div', 'q-attr', box);
    let av = null;
    if (sc.avatar) {
      av = ctx.image(sc.avatar, { field: 'avatar', label: 'Photo', cls: 'q-avatar', phSize: { w: 400, h: 400 } });
      attr.appendChild(av.img);
    }
    const who = el('div', 'q-who', attr);
    const name = el('div', 'q-name', who); MP.renderInline(name, sc.author || '');
    let role = null;
    if (sc.role) { role = el('div', 'q-role', who); MP.renderInline(role, sc.role); }
    ctx.lintText(attr, 'attribution');
    const e = ctx.enter;
    const L = { settle: 1, stag: 0.03, qStart: e + 0.25 };
    return {
      layout() {
        const used = attr.offsetHeight + GAP.l + 150;
        const max = sc.maxSize || (isLandscape(ctx) ? 72 : 68);
        fit(ctx, q.el, { width: ctx.box.w * 0.96, height: ctx.box.h - used, max, min: 34, maxLines: 8 }, 'text');
        L.stag = Math.min(0.035, 1.1 / Math.max(1, q.words.length));
        const qEnd = L.qStart + (q.words.length - 1) * L.stag + 0.6;
        L.settle = qEnd + 0.5;
        this.settle = L.settle;
      },
      settle: 1,
      update(t) {
        const pm = ease.outBack(prog(t, e, 0.7), 1.5);
        mark.style.opacity = String(r3(clamp(prog(t, e, 0.3))));
        mark.style.transform = `scale(${r3(0.5 + 0.5 * pm)})`;
        revealWords(q.words, t, L.qStart, { stagger: L.stag, dur: 0.6 });
        rise(attr, t, L.settle - 0.55, 0.6, 20);
      },
    };
  };

  // ================================================================ 8. cta
  S.cta = function (sc, ctx, root) {
    ctx.text(sc.headline, 'headline');
    const btnText = sc.button != null ? sc.button : '[Button label]';
    ctx.text(btnText, 'button');
    const urlText = String(sc.url || ctx.brand.url || '[yourdomain.com]').replace(/^https?:\/\//, '').replace(/\/$/, '');
    ctx.text(urlText, 'url');
    let offer = null;
    if (sc.offer != null && sc.offer !== '') {
      const o = typeof sc.offer === 'object' ? sc.offer : { text: sc.offer, source: sc.offerSource };
      offer = o;
      ctx.text(o.text, 'offer');
      ctx.claim(MP.plainText(o.text || ''), o.source, 'offer');
    }
    const box = boxEl(root, ctx, 'stack align-center cta-stack');
    const logoSrc = sc.logo || (ctx.palette.dark ? ctx.brand.logoOnDark || ctx.brand.logo : ctx.brand.logo);
    const recolor = ctx.palette.dark && !sc.logo && !ctx.brand.logoOnDark && !!ctx.brand.logo;
    const logoWrap = el('div', 'cta-logo', box);
    // No logo file but brand.wordmark: true -> typeset the brand name (never invent a logo image).
    const useWordmark = !logoSrc && ctx.brand.wordmark === true && ctx.brand.name && !MP.isPlaceholderText(ctx.brand.name);
    let logo = null;
    if (useWordmark) {
      const wm = el('div', 'wordmark', logoWrap);
      wm.textContent = ctx.brand.name;
      ctx.lintText(wm, 'wordmark');
    } else {
      logo = ctx.image(logoSrc, { field: 'logo', label: 'Logo', cls: 'logo-img' + (recolor ? ' recolor' : ''), phSize: { w: 900, h: 300 } });
      logoWrap.appendChild(logo.img);
    }
    ctx.lintBlock(logoWrap, 'logo');
    let head = null;
    if (textValue(sc.headline)) { head = headlineBlock(box, textValue(sc.headline), 'headline cta-head'); ctx.lintText(head.el, 'headline'); }
    let chip = null;
    if (offer) { chip = el('div', 'chip offer', box); MP.renderInline(chip, offer.text || ''); ctx.lintText(chip, 'offer'); }
    const btn = el('div', 'cta-btn', box);
    const label = el('span', 'cta-label', btn);
    MP.renderInline(label, btnText);
    const arrow = el('span', 'cta-arrow', btn);
    arrow.innerHTML = svgIcon('arrow');
    const shine = el('span', 'cta-shine', btn);
    ctx.lintBlock(btn, 'button');
    const url = el('div', 'cta-url', box);
    url.textContent = urlText;
    ctx.lintText(url, 'url');
    const e = ctx.enter;
    const L = { settle: 1, hStag: 0.05, hStart: e + 0.2, chipStart: 0, btnStart: 0, urlStart: 0 };
    return {
      layout() {
        let logoH;
        if (logo) {
          const lw = logo.w || 3, lh = logo.h || 1;
          const maxLH = isLandscape(ctx) ? 100 : 110, maxLW = ctx.box.w * 0.56;
          const k = Math.min(maxLH / lh, maxLW / lw);
          css(logo.img, { width: r3(lw * k) + 'px', height: r3(lh * k) + 'px' });
          logoH = lh * k;
        } else {
          const wm = logoWrap.firstChild;
          fitInline(ctx, wm, { width: ctx.box.w * 0.8, max: 64, min: 30, maxLines: 1, lineHeight: 1.1 }, 'wordmark');
          logoH = wm.offsetHeight;
        }
        const btnH = btn.offsetHeight, urlH = url.offsetHeight, chipH = chip ? chip.offsetHeight + GAP.m : 0;
        const used = logoH + GAP.l + GAP.l + chipH + btnH + GAP.m + urlH + 16;
        if (head) {
          fit(ctx, head.el, { width: ctx.box.w, height: (ctx.box.h - used) * 0.98, max: sc.maxSize || Math.round(Math.min(136, ctx.box.w * 0.14)), min: 52, maxLines: 3 }, 'headline');
          L.hStag = wordStagger(head.words.length, 0.055);
        }
        const hEnd = head ? L.hStart + (head.words.length - 1) * L.hStag + 0.75 : e + 0.3;
        L.chipStart = hEnd - 0.35;
        L.btnStart = hEnd - (chip ? 0.15 : 0.3);
        L.urlStart = L.btnStart + 0.3;
        L.settle = L.urlStart + 0.6;
        this.settle = L.settle;
      },
      settle: 1,
      update(t) {
        rise(logoWrap, t, e, 0.7, 20, { extra: (p) => `scale(${r3(0.92 + 0.08 * p)})` });
        if (head) revealWords(head.words, t, L.hStart, { stagger: L.hStag, dur: 0.75 });
        if (chip) rise(chip, t, L.chipStart, 0.6, 18);
        const bp = prog(t, L.btnStart, 0.7);
        const pulseT = t - L.settle;
        const pulse = pulseT > 0 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * pulseT) / 1.8) : 0;
        btn.style.opacity = String(r3(clamp(bp / 0.3)));
        btn.style.visibility = bp <= 0 ? 'hidden' : 'visible';
        btn.style.transform = `scale(${r3((0.7 + 0.3 * ease.outBack(bp, 1.7)) * (1 + 0.025 * pulse))})`;
        const cyc = pulseT > 0 ? (pulseT % 2.2) / 0.9 : -1;
        shine.style.transform = `translateX(${r3(cyc >= 0 && cyc <= 1 ? lerp(-140, 260, ease.inOutCubic(cyc)) : -140)}%) skewX(-20deg)`;
        arrow.style.transform = `translateX(${r3(4 * pulse)}px)`;
        rise(url, t, L.urlStart, 0.6, 14);
      },
    };
  };
})();
