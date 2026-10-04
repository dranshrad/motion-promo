---
name: motion-promo
description: Use when the user asks for a short video ad, promo clip, motion-graphics teaser, launch video, product reel, or social video (Meta feed 4:5, Stories/Reels/TikTok 9:16, square 1:1, 16:9) made from their product, landing page, app screenshots or brand assets, rendered to MP4.
---

# motion-promo

Turns a product's landing page and real assets into a 6–30 s motion-graphics ad (default 15 s),
rendered frame-by-frame to an H.264 MP4 that is identical on any machine. You edit one config
file; a fixed page animates it; a renderer screenshots every frame and encodes it.

Paths below are relative to **the directory containing this file** (call it `SKILL_DIR`).
Requirements: Node ≥ 18, ffmpeg + ffprobe, Chrome/Chromium. Check with `node SKILL_DIR/scripts/doctor.mjs`.

## Principles (non-negotiable)

1. **Claims match the destination page.** Read the page the ad links to before writing copy. Every
   number, price, rating, offer or quote must appear there (or in a document the user gives you).
   If the user insists on copy that contradicts the page, comply, but say so once, plainly.
2. **Real assets only.** Use images the user supplied or fetched from their own or authorised site.
   Never invent customers, reviews, ratings, results, people, logos or numbers. A blank is better than
   a guess: leave a claim out rather than approximate it.
3. **Sensitive categories.** Meta and TikTok restrict before/after imagery and copy that asserts a
   viewer's personal attributes (health, weight loss, cosmetic, medical, financial, and similar). In
   those categories keep the neutral `Input → Output` compare labels, avoid "you"-attribute copy
   ("Tired of your acne?"), and tell the user to check the platform's current policy.
4. **Match the brand.** Their colours, font, logo and tone. Write plainly and calmly by default;
   add emphatic punctuation or emoji only where the brand's own site does.
5. **Never overwrite a delivered file.** Output names are versioned: `<brand>-<topic>-<format>-vN.mp4`.
6. **Drafts are for review only.** `--draft` burns a DRAFT mark into every frame. Never deliver one.

## Workflow checklist

1. **Research.** Get the destination URL and goal (install, sign-up, purchase), the audience, the
   placements (4:5 / 9:16 / 1:1 / 16:9), the length, and any must-say or must-not-say lines.
2. **Assets + facts.** Only for sites the user owns or is authorised to use:
   `node SKILL_DIR/scripts/fetch.mjs --url <URL> --out <project>/assets/fetched`
   This writes images, `screenshot-desktop.png` / `screenshot-mobile.png`, `manifest.json`
   (provenance), `facts.txt` (title, headings, text with numbers) and `brand.json` (colour, font and
   logo hints). Read `facts.txt`. Confirm colours, font and logo with the user.
3. **Storyboard.** 4–7 scenes, one idea each: hook (title) → proof (device / compare / mosaic) →
   benefits (features) → optional stat or quote (only with a source) → CTA. Hook in the first second.
   Say the storyboard back to the user in one line per scene before building.
4. **Config.** `node SKILL_DIR/scripts/init.mjs <project>` creates `promo.config.js`, `assets/`
   and `preview.html`. Edit only `promo.config.js` (field reference: `references/scenes.md`).
   Every `[bracketed]` string and unset image is a placeholder and blocks the final render.
5. **Stills review loop.** `node SKILL_DIR/scripts/render.mjs <project> --stills auto`
   Read the printed issues, warnings and claims, then **look at `stills/contact-sheet.png`** (a settled
   and a mid-transition frame per scene). Fix and re-run until the checklist below is clean. Repeat
   for every format you deliver (`--format 9:16`, …).
6. **Final render.** `node SKILL_DIR/scripts/render.mjs <project>` (add `--format`, `--audio`).
   It refuses while issues remain or a claim lacks a source, then verifies the MP4 with ffprobe.
7. **Deliver + report.** Give the file path(s), the claims-to-verify list with sources, any facts-check
   warnings, what you could not verify, and anything left for the user (music rights, policy check).

## Commands

| Task | Command |
|---|---|
| Check setup | `node SKILL_DIR/scripts/doctor.mjs` |
| New project | `node SKILL_DIR/scripts/init.mjs ./promo` |
| Fetch assets/facts | `node SKILL_DIR/scripts/fetch.mjs --url https://site --out ./promo/assets/fetched` |
| Review stills | `node SKILL_DIR/scripts/render.mjs ./promo --stills auto` |
| Specific times | `node SKILL_DIR/scripts/render.mjs ./promo --stills 0.5,3.2,9` |
| Other format | `… --format 9:16` (4:5, 9:16, 1:1, 16:9) |
| Review video | `node SKILL_DIR/scripts/render.mjs ./promo --draft` |
| Final video | `node SKILL_DIR/scripts/render.mjs ./promo` |
| A/B hook variant | `… --config ./promo/hook-b.js` (a second config file) |
| With music | `… --audio ./track.mp3` (trimmed to length, 0.6 s fade-out) |
| Exact name | `… --out ./out/acme-launch-9x16-v1.mp4` (`--auto-version`, `--force`) |
| Faster | `… --jobs 4` (parallel browser pages; output is byte-identical) |

Exit codes: 0 ok · 1 render failed · 2 environment/usage · 3 refused (issues or unsourced claims).
Preview in a browser: open `<project>/preview.html` (plays and loops; scrub bar; issue list).

## Review checklist (look at every contact sheet)

- Hook readable within the first second; one idea per scene; nothing important in the last 0.2 s.
- No overlaps, clipped or cut-off words, stray fragments, text touching edges, or awkward empty areas.
- 9:16: headline, CTA and key content sit inside the safe zone (default top 260 px, bottom 420 px,
  sides 120 px) — platform UI covers the rest.
- Accent words (`*word*`) are the one or two words that matter, not decoration.
- Contrast looks strong on every surface (the page enforces ≥ 4.5:1; check the warnings).
- Screenshots are current and legible at phone size; tap point lands on a real control.
- Every claim in "Claims to verify" is on the destination page; facts-check warnings resolved.
- Copy reads with sound off and stays plain and calm unless the brand's own voice is louder.
- Brand: correct logo (logoOnDark on dark surfaces), colours, font actually loaded (no font warning).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ffmpeg not found` | `brew install ffmpeg` / `sudo apt-get install -y ffmpeg`, or `MOTION_PROMO_FFMPEG=/path` |
| `no Chromium-family browser found` | install Chrome, or `cd SKILL_DIR/scripts && npx playwright-core install chromium`, or `MOTION_PROMO_BROWSER=/path` |
| Browser fails to launch on Linux | `sudo npx playwright-core install-deps chromium` (or `install.sh --with-deps`) |
| `font "X" did not load` | no network or wrong URL; use `font.files` with local `.woff2` files (see INSTALL.md) |
| `copy does not fit even at the minimum size` | shorten the copy; don't lower `minSize` below readability |
| `extends outside the safe zone` / `overlaps` | shorten copy, fewer items, or a longer scene; re-check stills |
| `image … failed to load` | path is relative to the config file; check spelling; placeholders never ship |
| `final render refused` | fix listed issues / add `source` to claims; `--draft` for a review copy |
| `output exists` | never overwrite: `--auto-version`, a new `--out`, or `--force` only if the user says so |
| `entrance animation finishes at …` | lengthen that scene (≈ 2.5–3.5 s) or cut words |
| `ffmpeg stopped during encoding` | disk space / ffmpeg build; run the doctor |
| `page script error` | syntax error in the config (the message names the line) |
