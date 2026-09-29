#!/usr/bin/env bash
# motion-promo installer. MIT License, Copyright (c) 2026 motion-promo contributors.
#
# Copies this skill (without node_modules) into agent skill directories, installs npm deps
# with `npm ci`, and runs the doctor.
#
#   ./install.sh                      # into whichever of ~/.claude/skills and ~/.agents/skills exist
#   ./install.sh --target DIR         # into DIR/motion-promo (repeatable)
#   ./install.sh --with-chromium      # also download Playwright's Chromium (no Chrome needed)
#   ./install.sh --with-deps          # Linux: install Chromium's system libraries (needs root)
#   ./install.sh --no-doctor          # skip the final check
#   sudo ./install.sh --all-users [--with-chromium] [--with-deps]   # every account (see install-all-users.sh)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --all-users hands everything else to install-all-users.sh (per-account --target makes no sense there).
for a in "$@"; do
  if [ "$a" = "--all-users" ]; then
    pass=(); skip=0
    for b in "$@"; do
      if [ $skip -eq 1 ]; then skip=0; continue; fi
      case "$b" in
        --all-users) ;;
        --target) skip=1; echo "note: --target is ignored with --all-users" >&2 ;;
        --target=*) echo "note: --target is ignored with --all-users" >&2 ;;
        *) pass+=("$b") ;;
      esac
    done
    exec bash "$SRC/install-all-users.sh" ${pass[@]+"${pass[@]}"}
  fi
done
NAME="motion-promo"
TARGETS=()
WITH_CHROMIUM=0
WITH_DEPS=0
RUN_DOCTOR=1

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || { echo "--target needs a directory" >&2; exit 2; }; TARGETS+=("$2"); shift 2 ;;
    --target=*) TARGETS+=("${1#--target=}"); shift ;;
    --with-chromium) WITH_CHROMIUM=1; shift ;;
    --with-deps) WITH_DEPS=1; shift ;;
    --no-doctor) RUN_DOCTOR=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node >= 18 first (https://nodejs.org)." >&2; exit 2; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "ERROR: Node $(node -v) is too old; need >= 18." >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found." >&2; exit 2; }

if [ ${#TARGETS[@]} -eq 0 ]; then
  for d in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    [ -d "$d" ] && TARGETS+=("$d")
  done
  if [ ${#TARGETS[@]} -eq 0 ]; then
    echo "No skill directory found (~/.claude/skills or ~/.agents/skills). Pass --target DIR." >&2
    exit 2
  fi
fi

copy_skill() {
  local dest="$1"
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude 'node_modules' --exclude '.DS_Store' "$SRC/" "$dest/"
  else
    # portable fallback: clear old files (keep node_modules), then copy everything except node_modules
    find "$dest" -mindepth 1 -maxdepth 1 ! -name scripts -exec rm -rf {} +
    [ -d "$dest/scripts" ] && find "$dest/scripts" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    (cd "$SRC" && find . -path ./scripts/node_modules -prune -o -type f -print) | while IFS= read -r f; do
      mkdir -p "$dest/$(dirname "$f")"
      cp -p "$SRC/$f" "$dest/$f"
    done
  fi
}

for base in "${TARGETS[@]}"; do
  dest="$base/$NAME"
  if [ "$(cd "$SRC" && pwd -P)" = "$(mkdir -p "$dest" && cd "$dest" && pwd -P)" ]; then
    echo "== $dest is the source itself; installing in place"
  else
    echo "== installing into $dest"
    copy_skill "$dest"
  fi
  (cd "$dest/scripts" && npm ci --no-audit --no-fund --loglevel=error)
  if [ "$WITH_CHROMIUM" -eq 1 ]; then
    (cd "$dest/scripts" && npx --no-install playwright-core install chromium)
  fi
  if [ "$WITH_DEPS" -eq 1 ]; then
    if [ "$(uname -s)" != "Linux" ]; then
      echo "   --with-deps only applies to Linux; skipped."
    elif [ "$(id -u)" -ne 0 ]; then
      echo "ERROR: --with-deps needs root (run with sudo)." >&2; exit 2
    else
      (cd "$dest/scripts" && npx --no-install playwright-core install-deps chromium)
    fi
  fi
  chmod +x "$dest/install.sh" "$dest"/scripts/*.mjs 2>/dev/null || true
  if [ "$RUN_DOCTOR" -eq 1 ]; then
    node "$dest/scripts/doctor.mjs" || echo "   doctor reported problems above — follow the fix lines."
  fi
  echo "   done: $dest"
done
