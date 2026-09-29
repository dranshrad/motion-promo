# Provenance

motion-promo was written as a clean-room implementation.

- **Only input:** a functional specification (`CLEANROOM-SPEC.md`) describing what the tool must do.
  It contained no source code, markup or styles from any existing implementation. One short
  brand-voice rule in it echoed an existing tool's wording. An overlap check found that
  sentence in the first draft of `SKILL.md`, and it was reworded before release.
- **No access to other implementations:** the code, page, styles, configs, tests and documentation
  in this directory were written without reading, listing, searching or running any other
  implementation of a similar tool, and without looking at other agent skills' code.
- **Allowed references:** general public documentation only (Web platform / CSS / Web Animations
  concepts, the Playwright API, ffmpeg/ffprobe options, the WCAG contrast formula, the Agent Skills
  file format).
- **Third-party runtime dependency:** `playwright-core` (Apache-2.0), installed from npm. ffmpeg and
  the browser are system tools and are not redistributed.
- **Test fixtures** are generated at test time with ffmpeg's `lavfi` sources; no third-party images
  are included. The visual review during development used images fetched from
  a website owned by the person who commissioned this build, with permission; none of them ship
  in this directory.

All files in this directory are released under the MIT License (see `LICENSE`).

## Later maintenance
After the clean-room build, the commissioning side made changes that are unrelated to any other
implementation:
- `install-all-users.sh` and the `--all-users` switch in `install.sh`
- the shared-browser lookup (`.browser-path`) in `scripts/lib/common.mjs`
- `README.md` and the CI workflow
- small wording edits
