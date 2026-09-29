#!/usr/bin/env bash
# motion-promo: install for EVERY user account on this machine (run as root).
# MIT License, Copyright (c) 2026 motion-promo contributors.
#
# Layout: one shared copy in PREFIX (npm packages + optional Playwright Chromium, downloaded once),
# plus a real skill folder in each account's ~/.claude/skills and ~/.agents/skills whose
# scripts/node_modules links to the shared packages. New accounts get it via /etc/skel (Linux).
#
#   sudo bash install-all-users.sh                          # all human accounts + root + /etc/skel
#   sudo bash install-all-users.sh --with-chromium --with-deps   # headless server without Chrome
#   sudo bash install-all-users.sh --users "alice bob"      # only these accounts
#   sudo bash install-all-users.sh --uninstall              # remove per-user copies, skel and PREFIX
# Options: --prefix DIR (default /opt/motion-promo) · --no-root · --no-skel · --no-doctor · --dry-run
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="motion-promo"
PREFIX="/opt/motion-promo"
WITH_CHROMIUM=0; WITH_DEPS=0; INCLUDE_ROOT=1; SKEL=1; RUN_DOCTOR=1; DRY=0; UNINSTALL=0; ONLY_USERS=""
OS="$(uname -s)"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --with-chromium) WITH_CHROMIUM=1; shift ;;
    --with-deps) WITH_DEPS=1; shift ;;
    --users) ONLY_USERS="${2:?--users needs a list}"; shift 2 ;;
    --no-root) INCLUDE_ROOT=0; shift ;;
    --no-skel) SKEL=0; shift ;;
    --no-doctor) RUN_DOCTOR=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Test hooks (used by the test suite / CI, never needed in normal use):
#   MOTION_PROMO_USERS_FILE  file of "user home" lines instead of the system account list
#   MOTION_PROMO_NO_ROOT_OK=1  allow running without root (ownership changes are skipped)
IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
if [ $IS_ROOT -eq 0 ] && [ "${MOTION_PROMO_NO_ROOT_OK:-0}" != 1 ]; then
  echo "ERROR: installing for every user needs root. Re-run with sudo." >&2; exit 2
fi
run() { if [ $DRY -eq 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }

# ---------------------------------------------------------------- accounts
list_accounts() {
  if [ -n "${MOTION_PROMO_USERS_FILE:-}" ]; then cat "$MOTION_PROMO_USERS_FILE"; return; fi
  if [ "$OS" = "Darwin" ]; then
    dscl . list /Users UniqueID | awk '$2 >= 501 {print $1}' | while read -r u; do
      echo "$u $(dscl . read "/Users/$u" NFSHomeDirectory | awk '{print $2}')"
    done
  else
    getent passwd | awk -F: '$3 >= 1000 && $3 < 65534 && $7 !~ /(nologin|false)$/ {print $1" "$6}'
  fi
  if [ $INCLUDE_ROOT -eq 1 ]; then
    if [ "$OS" = "Darwin" ]; then echo "root /var/root"; else echo "root $(getent passwd root | cut -d: -f6)"; fi
  fi
}
ACCOUNTS=()
while read -r u h; do
  [ -n "$u" ] && [ -n "$h" ] || continue
  if [ -n "$ONLY_USERS" ] && ! printf ' %s ' $ONLY_USERS | grep -q " $u "; then continue; fi
  [ -d "$h" ] || { echo "   skip $u: home $h does not exist"; continue; }
  ACCOUNTS+=("$u:$h")
done < <(list_accounts)

is_ours() { [ -f "$1/SKILL.md" ] && grep -q "^name: $NAME\$" "$1/SKILL.md"; }

# ---------------------------------------------------------------- uninstall
if [ $UNINSTALL -eq 1 ]; then
  for a in "${ACCOUNTS[@]}"; do
    h="${a#*:}"
    for d in "$h/.claude/skills/$NAME" "$h/.agents/skills/$NAME"; do
      if is_ours "$d"; then echo "== remove $d"; run rm -rf "$d"; fi
    done
  done
  for d in "/etc/skel/.claude/skills/$NAME" "/etc/skel/.agents/skills/$NAME" "$PREFIX"; do
    if is_ours "$d"; then echo "== remove $d"; run rm -rf "$d"; fi
  done
  echo "Uninstalled."; exit 0
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node >= 18 first." >&2; exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "ERROR: Node $(node -v) is too old; need >= 18." >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found." >&2; exit 2; }

copy_skill() {  # copy skill files (never node_modules / browsers) from $1 to $2
  local from="$1" dest="$2"
  run mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    run rsync -a --delete --exclude 'node_modules' --exclude 'browsers' --exclude '.browser-path' \
      --exclude '.git' --exclude '.github' --exclude '.DS_Store' "$from/" "$dest/"
  else
    (cd "$from" && tar --exclude='./scripts/node_modules' --exclude='./browsers' --exclude='./.browser-path' \
      --exclude='./.git' --exclude='./.github' -cf - .) | { [ $DRY -eq 1 ] || (cd "$dest" && tar -xf -); }
  fi
}

# ---------------------------------------------------------------- shared copy
echo "== shared copy: $PREFIX"
if [ "$(cd "$SRC" && pwd -P)" != "$( (mkdir -p "$PREFIX" && cd "$PREFIX" && pwd -P) )" ]; then
  copy_skill "$SRC" "$PREFIX"
fi
run bash -c "cd '$PREFIX/scripts' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"
if [ $WITH_DEPS -eq 1 ]; then
  if [ "$OS" != "Linux" ]; then echo "   --with-deps only applies to Linux; skipped."
  else run bash -c "cd '$PREFIX/scripts' && npx --no-install playwright-core install-deps chromium"; fi
fi
if [ $WITH_CHROMIUM -eq 1 ]; then
  run bash -c "cd '$PREFIX/scripts' && PLAYWRIGHT_BROWSERS_PATH='$PREFIX/browsers' npx --no-install playwright-core install chromium"
  if [ $DRY -eq 0 ]; then
    (cd "$PREFIX/scripts" && PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers" \
      node -e "process.stdout.write(require('playwright-core').chromium.executablePath())") > "$PREFIX/.browser-path"
    echo "   shared Chromium: $(cat "$PREFIX/.browser-path")"
  fi
fi
run chmod -R a+rX "$PREFIX"

# ---------------------------------------------------------------- one account
install_into() {  # $1 user (or "" for skel), $2 home
  local user="$1" home="$2" grp="" base dest
  [ -n "$user" ] && grp="$(id -gn "$user" 2>/dev/null || echo "$user")"
  for base in ".claude/skills" ".agents/skills"; do
    dest="$home/$base/$NAME"
    # Create only the missing parents, owned by the account; never chmod an existing directory.
    local top="$home/${base%%/*}"
    for d in "$top" "$home/$base"; do
      if [ ! -d "$d" ]; then
        run mkdir -p "$d"; [ "$d" = "$top" ] && run chmod 700 "$d"
        [ -n "$user" ] && [ $IS_ROOT -eq 1 ] && run chown "$user:$grp" "$d"
      fi
    done
    if [ -e "$dest" ] && ! is_ours "$dest"; then echo "   skip $dest: exists and is not $NAME"; continue; fi
    copy_skill "$PREFIX" "$dest"
    [ -f "$PREFIX/.browser-path" ] && run cp "$PREFIX/.browser-path" "$dest/.browser-path"
    # Link to the shared npm packages unless the account has its own real node_modules.
    if [ ! -e "$dest/scripts/node_modules" ] || [ -L "$dest/scripts/node_modules" ]; then
      run ln -sfn "$PREFIX/scripts/node_modules" "$dest/scripts/node_modules"
    fi
    [ -n "$user" ] && [ $IS_ROOT -eq 1 ] && run chown -hR "$user:$grp" "$dest"
    echo "   $dest"
  done
}

RESULTS=()
for a in "${ACCOUNTS[@]}"; do
  u="${a%%:*}"; h="${a#*:}"
  echo "== account $u ($h)"
  install_into "$u" "$h"
  status="installed"
  if [ $RUN_DOCTOR -eq 1 ] && [ $DRY -eq 0 ]; then
    doc=""
    for d in "$h/.claude/skills/$NAME" "$h/.agents/skills/$NAME"; do
      is_ours "$d" && { doc="$d/scripts/doctor.mjs"; break; }
    done
    if [ -z "$doc" ]; then RESULTS+=("$u|not installed (skill folders taken by something else)"); continue; fi
    # Run as the account with a clean login-style environment: variables inherited from the
    # installing session (TMPDIR, XDG_RUNTIME_DIR, ...) point at places the account cannot write.
    clean=(env -i HOME="$h" USER="$u" LOGNAME="$u" SHELL=/bin/sh PATH="$PATH" LANG="${LANG:-C.UTF-8}")
    if [ $IS_ROOT -eq 1 ] && [ "$u" != "root" ]; then
      if command -v runuser >/dev/null 2>&1; then cmd=(runuser -u "$u" -- "${clean[@]}" node "$doc")
      else cmd=(sudo -u "$u" "${clean[@]}" node "$doc"); fi
    else cmd=("${clean[@]}" node "$doc"); fi
    if "${cmd[@]}" >/tmp/motion-promo-doctor.$$ 2>&1; then status="doctor ok"
    else status="doctor FAILED — output above"; tail -15 /tmp/motion-promo-doctor.$$ | sed 's/^/     /'; fi
    rm -f /tmp/motion-promo-doctor.$$
  fi
  RESULTS+=("$u|$status")
done

if [ $SKEL -eq 1 ] && [ "$OS" = "Linux" ] && [ -z "${MOTION_PROMO_USERS_FILE:-}" ]; then
  echo "== /etc/skel (accounts created later)"
  install_into "" "/etc/skel"
fi

echo; echo "Summary"
for r in "${RESULTS[@]}"; do printf '  %-20s %s\n' "${r%%|*}" "${r#*|}"; done
echo "Shared copy: $PREFIX   (re-run this script to update every account)"
