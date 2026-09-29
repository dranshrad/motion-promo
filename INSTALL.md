# Installing motion-promo

Runtime needs: **Node ≥ 18**, **ffmpeg + ffprobe** (with libx264), and a **Chromium-family
browser** (installed Google Chrome, Chromium, Edge — or Playwright's downloadable Chromium).
The only npm dependency is `playwright-core` (used to drive the browser; it bundles no browser).
No Python, no animation library.

## Desktop (macOS / Linux / Windows with WSL)

```sh
# 1. system tools
brew install node ffmpeg            # macOS (Homebrew); Chrome from google.com/chrome
# or: sudo apt-get install -y nodejs npm ffmpeg   (Debian/Ubuntu, see below for the browser)

# 2. install the skill into your agent's skill directories
./install.sh                        # → ~/.claude/skills/motion-promo and/or ~/.agents/skills/motion-promo
./install.sh --target /path/to/skills   # any other directory (repeatable)
```

`install.sh` copies the skill (without `node_modules`), runs `npm ci` in `scripts/`, then runs the
doctor. Without a skills directory it asks for `--target`.

Check any time:

```sh
node ~/.claude/skills/motion-promo/scripts/doctor.mjs
```

Each failing check prints a `fix:` line; the exit code is non-zero when anything fails.

## Headless Linux server (Debian / Ubuntu example)

```sh
sudo apt-get update
sudo apt-get install -y nodejs npm ffmpeg fonts-dejavu-core fontconfig
# Node from the distro may be old; check `node -v` (>= 18). If older, install Node 20 LTS from
# nodesource or your preferred source.

# browser: either Google Chrome …
#   (download the .deb from google.com/chrome and `sudo apt-get install ./google-chrome-stable_current_amd64.deb`)
# … or Playwright's Chromium plus its system libraries:
sudo ./install.sh --target /opt/skills --with-chromium --with-deps
```

- `--with-chromium` downloads Playwright's Chromium into the user cache (`~/.cache/ms-playwright`).
  Run the installer as the user who will render (use `sudo` only together with `--with-deps`, or run
  `--with-deps` once as root and `--with-chromium` as the render user).
- `--with-deps` installs Chromium's shared libraries via `npx playwright-core install-deps chromium`
  (Linux only, needs root).
- Running as root: the renderer adds `--no-sandbox` automatically when uid is 0.
- Rendering is CPU-only (software raster, `--disable-gpu`) — no GPU or display needed, and frames
  match between laptops and servers more closely.
- Override discovery with `MOTION_PROMO_BROWSER=/path/to/chrome`, `MOTION_PROMO_FFMPEG=/path/to/ffmpeg`,
  `MOTION_PROMO_FFPROBE=/path/to/ffprobe`. Extra Chrome flags: `MOTION_PROMO_BROWSER_ARGS="--flag …"`.

## Every user on a machine (shared server)

```sh
sudo bash install.sh --all-users --with-chromium --with-deps   # same as: sudo bash install-all-users.sh …
```

- **Shared copy:** one copy goes in `/opt/motion-promo` (change it with `--prefix`). The npm
  packages, and the Playwright Chromium if you use `--with-chromium`, are downloaded **once**
  there.
- **Per-account copies:** every account gets a real `~/.claude/skills/motion-promo` and
  `~/.agents/skills/motion-promo`, owned by that account. This covers human accounts (UID ≥ 1000
  on Linux, ≥ 501 on macOS, excluding `nologin`/`false` shells) and `root`. Each copy's
  `scripts/node_modules` links to the shared packages, and a `.browser-path` file points at the
  shared Chromium.
- **Future accounts:** on Linux the skill also goes into `/etc/skel`, so accounts created later
  get it automatically.
- **Safety:** missing folders are created with private permissions, and existing folders are
  never re-permissioned. A `motion-promo` folder that is not this skill is skipped, never
  overwritten.
- **Per-account check:** the doctor runs as each account and a summary table is printed.
- **Updating:** re-run the same command to update every account.
- **Other options:** `--users "alice bob"`, `--no-root`, `--no-skel`, `--dry-run`.
- **Removing:** `sudo bash install-all-users.sh --uninstall` removes only folders whose
  `SKILL.md` is this skill.

This exact flow is exercised on every push by the `all-users-linux` CI job. That job runs
Ubuntu with Chrome removed, creates two accounts, runs the command above, has every account
(and root) render a still, checks that a later account inherits the skill from `/etc/skel`,
runs the full test suite, then uninstalls.

## Offline fonts

Servers without internet cannot load Google Fonts; the render then falls back to the system font
and prints a warning. Ship the font files next to the config instead:

```text
promo/
  promo.config.js
  fonts/Inter-Variable.woff2
  fonts/Fraunces-Variable.woff2
```

```js
font: {
  family: 'Inter',
  files: [{ src: 'fonts/Inter-Variable.woff2', weight: '100 900' }],
  display: { family: 'Fraunces', files: [{ src: 'fonts/Fraunces-Variable.woff2', weight: '100 900' }], weight: 500 },
},
```

Paths are relative to the config file. Static fonts work too: one entry per weight
(`{ src: 'fonts/Inter-Bold.woff2', weight: 700 }`). Check the licence of any font you bundle.
The renderer launches Chrome with `--allow-file-access-from-files` so local font files load from
`file://`; when previewing `preview.html` in your everyday browser, local fonts may be blocked —
that affects only the preview, not renders.

For identical output on every machine, prefer `font.files` over system fonts: system font
versions differ between machines.

## Tests

```sh
cd scripts && npm test      # no network needed; generates test images with ffmpeg lavfi
```

## Uninstall

```sh
rm -rf ~/.claude/skills/motion-promo ~/.agents/skills/motion-promo   # or your --target dirs
rm -rf ~/.cache/ms-playwright          # only if you used --with-chromium and nothing else needs it
```

Projects you created (config, assets, `out/`, `stills/`) live wherever you created them and are not
touched by uninstalling.
