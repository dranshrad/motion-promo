# motion-promo

An agent skill that turns a product's landing page and real assets into a short motion-graphics
video ad: 6–30 s MP4s for Meta feed (4:5), Stories, Reels and TikTok (9:16), square (1:1) and
16:9. Every frame is rendered deterministically, so output is identical on any machine.

It works with any agent that loads [Agent Skills](https://agentskills.io)-format folders
(`SKILL.md` + frontmatter), such as Claude Code, Codex and other compatible CLIs. The agent reads
`SKILL.md`; you just ask for "a 15-second Reels ad for our pricing page".

## What it does
- **Scenes:** ads are built from 8 scenes: title, device (phone, browser or laptop with a
  scrolling screenshot), compare, mosaic, features, stat, quote and CTA.
- **Transitions:** 6 kinds (cut, fade, slide, wipe, iris, zoom).
- **Layout:** positions are calculated from the frame, with platform safe zones for 9:16. One
  config renders in every format, and `--config` renders A/B variants.
- **Honest by construction:**
  - Unfilled copy is written in `[brackets]`, and unset images render as obvious placeholders.
  - A final render is refused while any placeholder remains, and drafts are stamped DRAFT.
  - Numbers, quotes and offers need a `source`, and are checked against the text fetched from
    the landing page.
- **Brand-aware:** the fetcher pulls real images, page facts, colours and fonts from your own
  site. Text colours are adjusted automatically to reach WCAG 4.5:1 contrast.
- **Deterministic rendering:** a pure-function animation engine, with no animation library.
  Seeking to any time gives the exact frame, and `--jobs N` output is byte-identical to
  single-job output.
- **Small footprint:** Node ≥ 18, ffmpeg, a Chromium-family browser and one npm package
  (`playwright-core`). No Python.

## Install
```sh
git clone https://github.com/dranshrad/motion-promo.git && cd motion-promo
./install.sh                                                  # you: ~/.claude/skills + ~/.agents/skills
./install.sh --target /path/to/skills                         # any other agent's skill folder
sudo bash install.sh --all-users --with-chromium --with-deps  # every account on a server
```
Details, headless servers and offline fonts are in [INSTALL.md](INSTALL.md). Run
`node scripts/doctor.mjs` any time to check the setup.

## Use it by hand
```sh
node scripts/init.mjs my-ad                          # starter config + assets/ + preview.html
node scripts/fetch.mjs --url https://your-site.com --out my-ad/assets/fetched
node scripts/render.mjs my-ad --stills auto          # contact sheet for review
node scripts/render.mjs my-ad --format 9:16          # final MP4 (refused while placeholders remain)
```
Config and scene reference: [references/scenes.md](references/scenes.md).

## Tests
`cd scripts && npm test` runs the automated suite: determinism, render gates, failure paths,
fetcher parsing, odd paths and a full encode. CI runs it on macOS and on a Linux all-users
install.

## Licence and provenance
MIT; see [LICENSE](LICENSE). This is a clean-room implementation written from a functional
specification. See [PROVENANCE.md](PROVENANCE.md).
