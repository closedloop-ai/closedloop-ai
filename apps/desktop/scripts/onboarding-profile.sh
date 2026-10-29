#!/usr/bin/env bash
#
# Launch Closedloop Desktop on a throwaway profile to exercise the first-run
# onboarding flow without touching your real profile or your real agent history.
#
# A fresh Electron --user-data-dir is a first run by definition: localStorage
# lives inside it, so cl-desktop-dashboard-onboarded -- the one key that decides
# first run -- starts unset, and the app opens on the Dashboard with the guided
# onboarding welcome modal over it (ISS-10855). Nothing needs seeding for that.
#
# WHICH HALF OF THE WALK A FRESH PROFILE ACTUALLY BUYS YOU. Walk the modal as a
# GUEST and every run is a genuine first run: that key and the guest run's
# position are localStorage, inside this directory. SIGN IN from the modal and
# the run you land on is SERVER-owned -- `onboardingAttempt` is
# `@@unique([userId, organizationId])` (packages/database/prisma/schema.prisma),
# so it belongs to your account, not to the profile you launched on, and a
# second walk resumes wherever your account left off however fresh this
# directory is. That arm is reset on the server, not here.
#
# The profile is not the only thing that has to be isolated. The boot collectors
# resolve their harness homes under $HOME unless pinned, so an unpinned launch
# reads your real ~/.claude, ~/.codex, Cursor and Copilot history into this
# throwaway store (ISS-7731/ISS-7697) -- and the onboarding walk includes the
# sync-consent step on a profile that has never consented, so answering it would
# then hand the sync lanes a green light to upload that history under a brand
# new installation id. Deleting the profile does not recall those rows. This
# script pins the same collector homes the E2E harness pins, so there is nothing
# real in the store to send; hook/statusline toggles during the walk land in
# those temp homes too, not in your real ~/.claude/settings.json.
#
# Usage (flags pass straight through `just`, with no `--` separator):
#   just desktop-onboarding               # fresh profile, removed on exit
#   just desktop-onboarding --build       # rebuild apps/desktop first (slow)
#   just desktop-onboarding --keep        # keep the profile, print its path
#   just desktop-onboarding-reuse DIR     # relaunch a profile --keep left behind
#
# or run apps/desktop/scripts/onboarding-profile.sh directly with the same flags.
#
set -euo pipefail

DO_BUILD=0
KEEP=0
REUSE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --build) DO_BUILD=1 ;;
    --keep) KEEP=1 ;;
    --reuse)
      shift
      [ $# -gt 0 ] || { echo "--reuse needs a directory" >&2; exit 2; }
      REUSE="$1"
      KEEP=1
      ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Resolve the repo root from the CURRENT DIRECTORY, not from this script's own
# location, so the checkout that gets built and launched is always the one you
# are standing in -- even when you reach another checkout's copy by path.
#
# Anchoring to $BASH_SOURCE got that wrong silently and totally: a clean build
# of the wrong branch, an app that launches happily, and the feature under test
# simply absent. It cost a full test cycle on ISS-5489 exactly that way.
if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fi
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
MAIN_JS="$DESKTOP_DIR/dist/main/index.js"
echo "==> repo root: $REPO_ROOT"
echo "    branch:    $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(not a git checkout)')"

if [ "$DO_BUILD" -eq 1 ]; then
  echo "==> building apps/desktop (this is slow)"
  pnpm -C "$DESKTOP_DIR" build
fi

if [ ! -f "$MAIN_JS" ]; then
  echo "error: $MAIN_JS not found -- run with --build first." >&2
  exit 1
fi

# Source maps embed the SOURCE text, so a marker found only in a .map proves
# nothing about what the build actually runs.
build_has() {
  grep -rql --exclude='*.map' -- "$1" "$2" 2>/dev/null
}

# Existence is NOT freshness, and a stale dist/ fails in two different ways.
#
# ISS-8955 first, because it is the one that destroys data. A main process built
# before that fix treats an EMPTY --user-data-dir as a legacy-migration target
# and renames your INSTALLED profile into it -- and this script then removes
# that directory on exit. `skipped-user-data-redirected` is the result the guard
# returns, so its presence in the built main is a direct answer to "will this
# build leave my real profile alone?".
REDIRECT_GUARD_MARKER="skipped-user-data-redirected"
if ! build_has "$REDIRECT_GUARD_MARKER" "$DESKTOP_DIR/dist/main"; then
  echo "error: the built main process predates the profile-redirect guard (ISS-8955)." >&2
  echo "       $DESKTOP_DIR/dist/main has no '$REDIRECT_GUARD_MARKER'." >&2
  echo "       Launching it on an empty profile would MOVE YOUR REAL PROFILE into the" >&2
  echo "       throwaway directory. Refusing." >&2
  echo >&2
  echo "       Rebuild:  $0 --build" >&2
  exit 1
fi

# The marker above only proves the bundle is NEWER than the fix it names. A
# dist/ built on any later commit passes it too, so after a branch switch the
# recipe happily validates an OLD onboarding build while claiming a stale dist
# is refused. The commit itself is in the bundle: `pnpm prebuild` bakes
# `BUILD_COMMIT_HASH` from `git rev-parse HEAD` (scripts/write-build-info-lib.mjs),
# so the direct question is whether HEAD's sha appears in the built main at all.
if HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"; then
  if ! build_has "$HEAD_SHA" "$DESKTOP_DIR/dist/main"; then
    BUILT_SHA="$(grep -rhoE --exclude='*.map' 'BUILD_COMMIT_HASH ?= ?"[0-9a-f]{40}"' "$DESKTOP_DIR/dist/main" | grep -oE '[0-9a-f]{40}' | head -1 || true)"
    echo "error: $DESKTOP_DIR/dist was not built from the checked-out commit." >&2
    echo "       HEAD:  $HEAD_SHA" >&2
    echo "       built: ${BUILT_SHA:-unknown}" >&2
    echo "       Whatever you walk would be that other build's onboarding." >&2
    echo >&2
    echo "       Rebuild:  $0 --build" >&2
    exit 1
  fi
else
  echo "warning: not a git checkout -- cannot check dist/ against HEAD." >&2
fi

# ISS-7731: a throwaway --user-data-dir isolates localStorage and this run's
# SQLite store, but NOT the collector homes. Each of these variables is the
# highest-precedence input to its collector's resolver, so an unset one falls
# all the way back to os.homedir() and the boot collectors import the operator's
# real history -- that is how a real Copilot session reached a seeded population
# (ISS-7697). The E2E harness pins the same set for the same reason
# (test/helpers/isolated-harness-homes.ts).
#
# This list must equal HARNESS_HOME_ENV_KEYS in that module. A ninth collector
# home added there and missed here silently falls back to $HOME, which is the
# whole leak, so the agreement is pinned by
# test/onboarding-profile-harness-homes.test.ts.
HARNESS_HOME_KEYS="
CLAUDE_HOME
CLAUDE_DESKTOP_SESSIONS_HOME
CODEX_HOME
CURSOR_HOME
COPILOT_HOME
COPILOT_VSCODE_STORAGE_DIR
OPENCODE_DATA_DIR
OPENCODE_CONFIG_DIR
"

HARNESS_HOMES="$(mktemp -d -t cl-onboarding-homes-XXXXXX)"
PROFILE=""
# The harness homes are ALWAYS this run's to remove; --keep applies to the
# profile only. Installed before the profile exists so a failure between here
# and there cannot leak them.
cleanup() {
  rm -rf "$HARNESS_HOMES"
  if [ "$KEEP" -eq 0 ] && [ -n "$PROFILE" ]; then
    echo
    echo "==> removing $PROFILE"
    rm -rf "$PROFILE"
  fi
}
trap cleanup EXIT

for key in $HARNESS_HOME_KEYS; do
  mkdir -p "$HARNESS_HOMES/$key"
  export "$key=$HARNESS_HOMES/$key"
done
echo "==> collector homes pinned under: $HARNESS_HOMES"

# Written into every profile this script creates, and required by --reuse.
PROFILE_MARKER=".cl-onboarding-profile"

if [ -n "$REUSE" ]; then
  PROFILE="$REUSE"
  [ -d "$PROFILE" ] || { echo "error: no such profile: $PROFILE" >&2; exit 1; }
  # --reuse takes a path, and the damaging reading of that path is the INSTALLED
  # profile: relaunching that spends the real first-run state this whole script
  # exists to protect. Only a directory a --keep run left behind is eligible.
  if [ ! -f "$PROFILE/$PROFILE_MARKER" ]; then
    echo "error: $PROFILE has no $PROFILE_MARKER, so this script did not create it." >&2
    echo "       --reuse only relaunches a profile left behind by --keep. Pointing it" >&2
    echo "       at your installed profile would spend its real first-run state." >&2
    echo "       Refusing." >&2
    exit 1
  fi
  echo "==> reusing profile: $PROFILE"
  echo "    (a returning install -- the guided run resumes where the last walk left it, and stays closed if that walk finished)"
else
  PROFILE="$(mktemp -d -t cl-onboarding-XXXXXX)"
  printf 'created by apps/desktop/scripts/onboarding-profile.sh\n' > "$PROFILE/$PROFILE_MARKER"
  echo "==> fresh profile: $PROFILE"
fi

if [ "$KEEP" -eq 1 ]; then
  echo "==> profile kept on exit. Re-enter it with:"
  echo "    $0 --reuse $PROFILE"
fi

# Invoke the electron binary DIRECTLY, exactly as the E2E harness does.
#
# `pnpm -C apps/desktop start -- --user-data-dir=X` does NOT work: pnpm forwards
# a literal `--` ahead of the argument, and Chromium treats `--` as
# end-of-switches, so --user-data-dir is demoted to a positional arg and
# silently ignored. The app then launches against the REAL profile
# (~/Library/Application Support/Closedloop) and every first-run affordance is
# already spent there -- which looks identical to "the welcome modal did not arm".
ELECTRON_BIN="$DESKTOP_DIR/node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "error: $ELECTRON_BIN not found -- run pnpm install." >&2
  exit 1
fi

# --user-data-dir moves userData and nothing else. The agent hook listener
# (4820) and the OTLP receiver (4318) each bind ONE fixed port with no fallback
# and fail SOFT on EADDRINUSE (src/main/lifecycle/loopback-port-isolation.ts),
# so without this the throwaway instance either runs with agent capture quietly
# off for the whole walk (your real Desktop is already up and holds the ports)
# or WINS 4820 -- which is the port the hook commands in your real
# ~/.claude/settings.json post to, so your genuine agent traffic lands in the
# disposable store and leaves with it. The E2E harness passes it on every launch
# (`e2eAppLaunchArgs`); it is an app-level argument, so it follows MAIN_JS.
EPHEMERAL_PORTS_ARG="--e2e-ephemeral-loopback-ports"

# A per-profile boot record. `resolveMainLogDirectory` keeps a REDIRECTED
# instance's main log inside its own userData (ISS-4916) and every boot logs one
# `profile=redirected` line, so a new one here is proof that the switch took AND
# that this directory is the profile it took to. A file COUNT could not say that
# for `--reuse`: a clean relaunch updates existing files without adding any, so
# the documented reuse path failed while doing exactly the right thing.
BOOT_MARKER="profile=redirected"
MAIN_LOG="$PROFILE/logs/main.log"

boot_count() {
  [ -f "$MAIN_LOG" ] || { echo 0; return 0; }
  grep -c -- "$BOOT_MARKER" "$MAIN_LOG" || true
}

BOOTS_BEFORE="$(boot_count)"

echo "==> launching"
echo "    $ELECTRON_BIN $MAIN_JS --user-data-dir=$PROFILE $EPHEMERAL_PORTS_ARG"
LAUNCH_RC=0
CLOSEDLOOP_DISABLE_AUTO_UPDATE=1 \
  "$ELECTRON_BIN" "$MAIN_JS" --user-data-dir="$PROFILE" "$EPHEMERAL_PORTS_ARG" || LAUNCH_RC=$?

# Before the profile check: a boot that dies early can still have written files
# into the profile, so swallowing this left the command green after a crash.
if [ "$LAUNCH_RC" -ne 0 ]; then
  echo >&2
  echo "error: the app exited $LAUNCH_RC -- the walk did not finish cleanly." >&2
  exit "$LAUNCH_RC"
fi

BOOTS_AFTER="$(boot_count)"
if [ "$BOOTS_AFTER" -le "$BOOTS_BEFORE" ]; then
  echo >&2
  echo "WARNING: no new '$BOOT_MARKER' boot line in $MAIN_LOG." >&2
  echo "         Electron did NOT boot against this profile. Whatever you just saw" >&2
  echo "         was your REAL profile. Do not trust it." >&2
  exit 1
fi
