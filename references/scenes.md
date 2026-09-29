# motion-promo — config and scene reference

The config is a script that assigns one global:

```js
window.PROMO_CONFIG = { format: '4:5', brand: {…}, colors: {…}, font: {…}, scenes: [ … ] };
```

It is a `.js` file (not JSON) because `fetch()` of local JSON fails on `file://` in Chrome.
Image and font paths are **relative to the config file**; write plain paths (spaces, `#`, `%`
and non-ASCII are fine — do not URL-encode). Absolute paths and `https://` URLs also work.

## Copy markup (every text field)

| Markup | Effect |
|---|---|
| `*word*` / `*several words*` | accent colour (contrast-corrected). Punctuation right after the closing `*` works: `*today*.` |
| `\n` (newline in the string) | forced line break |
| `\*` | a literal asterisk |
| `[anything]` | placeholder — reported as an issue, blocks the final render |

An odd number of `*` is shown literally with a warning.

## Global fields

| Field | Default | Notes |
|---|---|---|
| `format` | `'4:5'` | `'4:5'` 1080×1350 · `'9:16'` 1080×1920 · `'1:1'` 1080×1080 · `'16:9'` 1920×1080. `--format` overrides. |
| `size` | — | `{width, height}` for a custom frame (both even; odd is rejected). Ignored when `--format` is given. |
| `topic` | `'promo'` | used in the output name `<brand>-<topic>-<format>-vN.mp4` |
| `fps` | `30` | renderer default; `--fps` overrides |
| `align` | per scene | default horizontal alignment for all scenes: `'left'` or `'center'` |
| `valign` | `'center'` | default vertical placement for all scenes within the safe area: `'center'` · `'top'` · `'bottom'` |
| `brand.name` | — | used in file names and for `wordmark` |
| `brand.logo` | — | logo for light surfaces (SVG or PNG with transparency preferred) |
| `brand.logoOnDark` | — | logo for dark surfaces; if absent the logo is recoloured white there |
| `brand.wordmark` | `false` | `true` + no logo file → the brand name is typeset in the display font on the CTA. Use only when the brand really has no logo; never draw one. |
| `brand.url` | — | shown on the CTA and in the browser frame's address bar |
| `colors.background` / `text` / `accent` | required | any CSS colour |
| `colors.surface`, `colors.muted` | derived | card and secondary-text colours; derived from the three above when absent |
| `font.family` | `'Inter'` | body family |
| `font.url` | — | stylesheet URL (e.g. Google Fonts `…&display=block`) |
| `font.files` | — | local files `[{ src: 'fonts/X.woff2', weight: '100 900', style: 'normal' }]` — use on offline servers |
| `font.weights` | `{body:400, strong:600, headline:700}` | |
| `font.tracking` | `-0.03` | headline letter-spacing in em |
| `font.fallback` | system sans stack | |
| `font.display` | — | optional headline family: `{ family, url | files, weight, tracking }` (e.g. a serif display face) |
| `safeZone` | per format | px insets `{top, right, bottom, left}`; or per format `{ '9:16': {…}, '4:5': {…} }` |
| `scenes` | required | ordered array; total duration = sum of scene durations |

A font that fails to load is a **warning** (frames fall back to the fallback stack) — check for it.

### Safe-zone defaults (px)

| Format | top | right | bottom | left | Why |
|---|---|---|---|---|---|
| 9:16 | 260 | 120 | 420 | 120 | Stories/Reels/TikTok overlay the top (profile, progress) and bottom (caption, CTA, sound) bands, and TikTok's action rail sits on the right |
| 4:5 | 96 | 88 | 96 | 88 | margin only (no platform overlay in feed) |
| 1:1 | 84 | 84 | 84 | 84 | margin only |
| 16:9 | 84 | 128 | 84 | 128 | margin only |

Backgrounds and colour wipes are full-bleed; text, CTA, devices, cards and grids stay inside.
Platform UI changes — if the user has a current spec, set `safeZone` to it.

## Colour and contrast

Text colour is chosen automatically to reach **≥ 4.5:1 (WCAG)** on every surface text is placed on:
body text on the background, accent words, muted lines, text on cards, the button label on the
accent colour, chips. If the brand's own `text` colour fails it is adjusted and a warning is printed.

## Scene fields common to all types

| Field | Notes |
|---|---|
| `type` | `title` · `device` · `compare` · `mosaic` · `features` · `stat` · `quote` · `cta` |
| `duration` | seconds (0–30). Aim for 2–3.5 s; the renderer warns when a scene is too short for its entrance |
| `transition` | how this scene enters: a name or `{ type, duration, direction }` (below). First scene defaults to `cut`, others to `fade` |
| `theme` | `'default'` · `'accent'` (accent-coloured surface) · `'inverse'` (text colour as background) |
| `align` | horizontal: `'left'` or `'center'` (title, features and quote default to left; others centre). `'top'` / `'bottom'` are accepted as a shorthand for `valign` |
| `valign` | vertical placement of the scene's content **within the safe area** (not the raw frame): `'center'` (default) · `'top'` · `'bottom'`. Applies to every scene; in side-by-side layouts (16:9, square device) it aligns both columns. Invalid values are reported as an issue |
| `source` | on any scene: marks its main copy as a claim to verify |

### Transitions

| Type | Default length | What it does |
|---|---|---|
| `cut` | 0 | hard cut |
| `fade` | 0.45 s | dip cross-fade (out, then in — no text over text) |
| `slide` (alias `push`) | 0.55 s | both scenes move together; `direction: 'left' \| 'right' \| 'up' \| 'down'` |
| `wipe` | 0.75 s | two skewed colour panels (text + accent colour) sweep across; `direction: 'left' \| 'right'` |
| `iris` | 0.7 s | new scene grows from the centre in a circle with an accent ring |
| `zoom` | 0.5 s | old scene scales up and fades, new scene settles in |

Transition length is capped at 60 % of either neighbouring scene. The incoming scene's own entrance
starts part-way through the transition.

## 1. `title` — kinetic headline

| Field | Notes |
|---|---|
| `headline` | required; 1–3 lines. Auto-fits: largest size that fits the safe box in ≤ 3 lines |
| `kicker` | small uppercase line above, with an accent rule |
| `subline` | one sentence below, muted, ≤ 3 lines |
| `maxSize`, `minSize` | headline px bounds (defaults ≈ 16 % of box width, floor 56). Below the floor → issue |

Tip: a short title in a tall 9:16 frame can read as floating; `valign: 'bottom'` (lower-third, editorial) or `'top'` anchors it, and
the title's slow ambient scale then grows away from the anchored edge.

Words rise and fade in, staggered. Nothing clips them, so every glyph is always drawn whole (no
partial-glyph fragments at any frame), and an unrevealed word is `visibility: hidden`.

## 2. `device` — phone, browser or laptop showing a screenshot

| Field | Notes |
|---|---|
| `frame` | `'phone'` (default) · `'browser'` · `'laptop'` |
| `image` | screenshot (`screenshot-mobile.png` from the fetcher is 1170 px wide). Taller than the screen → scrolls during the scene |
| `scroll` | `'auto'` (default, up to 2.2 screen heights) · `false` · a number of screenshot px |
| `caption` | headline above the device (beside it in 16:9 and square phone layouts) |
| `captionSize` | caption max px |
| `url` | text in the browser address bar (defaults to `brand.url`) |
| `tap` | `{ x, y, at }` — tap indicator at screenshot-pixel coordinates; `at` = scene seconds (default: after the scroll). Off-screen → issue |
| `imageLabel` | label on the placeholder card while `image` is unset |

## 3. `compare` — from → to with an animated divider

| Field | Notes |
|---|---|
| `from`, `to` | the two images (same framing works best) |
| `fromLabel`, `toLabel` | default **`'Input'` / `'Output'`** — keep these neutral in health, cosmetic, weight-loss, financial and similar categories (see SKILL.md policy) |
| `headline` | optional, above (beside in 16:9) |
| `split` | final divider position 0.1–0.9 (default 0.5) |
| `aspect` | card aspect, e.g. `'4:5'`, `'1:1'`, `1.5`; default follows the image, clamped to suit the format |

## 4. `mosaic` — image grid assembling into view

| Field | Notes |
|---|---|
| `images` | 1+ real images. Fewer than cells → real images repeat, avoiding identical neighbours; placeholders are never mixed in while at least one real image loads |
| `count` | cells, 6–20 (rounded up to fill a full grid); default 12 (9 for 1:1) |
| `headline`, `headlineSize` | optional, above the grid |

## 5. `features` — 2–4 benefit lines with marks

| Field | Notes |
|---|---|
| `items` | 2–4 strings, or `{ text, source }` to mark a line as a claim. ≤ 2 lines each |
| `headline`, `headlineSize` | optional |
| `marks` | `'check'` (default) · `'number'` · `'dot'` |
| `textSize` | max px for item text (default 54; shrinks to fit) |

## 6. `stat` — one number that counts up (claim)

| Field | Notes |
|---|---|
| `value` | e.g. `'12,400+'`, `'4.9'`, `'$2.5M'`, `'38%'` — prefix/suffix and grouping are kept while counting |
| `label` | what the number is |
| `source` | **required** — where the number is published (URL or document) |
| `kicker`, `footnote` | optional small lines (footnote is shown on screen, e.g. a date or basis) |

Not in the starter on purpose: add it only with a real, published number.

## 7. `quote` — testimonial (claim)

| Field | Notes |
|---|---|
| `text` | the exact quote |
| `author` | the real person or organisation (required) |
| `role` | optional title / company |
| `avatar` | optional real photo (with permission) |
| `source` | **required** — where the quote is published or the permission record |

Never write or paraphrase a testimonial. Not in the starter on purpose.

## 8. `cta` — logo, headline, button, URL

| Field | Notes |
|---|---|
| `headline` | required in practice; ≤ 3 lines |
| `button` | button label (default placeholder `[Button label]`) |
| `url` | footer line (defaults to `brand.url`) |
| `logo` | overrides `brand.logo` for this scene |
| `offer` | optional chip `{ text, source }` — **source required**; only a real, current offer |

## Claims

Claim-bearing fields: `stat`, `quote`, `cta.offer`, any `{ text, source }` item, and any scene with a
`source`. Every render prints **Claims to verify** (text + source). A final render is refused while a
claim has no source. When `assets/fetched/facts.txt` exists (or `--facts FILE`), every number in a
claim is looked up in it; misses are printed as warnings (formatting can differ, so they don't block).

## Example (stat + quote, sourced)

```js
{ type: 'stat', duration: 2.6, value: '12,400', label: 'teams use it every week',
  source: 'https://example.com/customers (checked 2026-09-29)' },
{ type: 'quote', duration: 3.4, text: 'We shipped the *first week*.', author: 'A. Customer', role: 'CTO, Example Co',
  source: 'https://example.com/case-studies/example-co' },
```
