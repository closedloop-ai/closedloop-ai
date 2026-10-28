#!/usr/bin/env bash
# ISS-10407 — the Electron half of e2e-test.yml's `List the PR's changed
# Playwright specs` step, with the same contract and the same fail-closed arms,
# over `apps/desktop/test/e2e/`.
#
# Run by e2e-test.yml's `List the PR's changed Electron specs` step and by
# `pnpm test:lanes` (ISS-10615), so the two cannot select differently. Reads
# DESKTOP_SPEC_FILES (dorny's shell-escaped `desktop_e2e_specs_files`) and
# EVENT_NAME; writes `desktop_e2e_changed_specs=` to $GITHUB_OUTPUT.
#
# It emits BASENAMES, not paths, because that is what the selector greps
# on: Playwright matches `grep` against a test's title path, which begins
# with the spec's path relative to `testDir`, so the directory prefix is
# not part of what a narrowed run can select. `test/e2e-selection.ts` holds
# the matching rule and re-validates every entry against
# `^[A-Za-z0-9._-]+\.spec\.ts$`, so a name that gets past this shell still
# cannot reach Playwright as a live regex metacharacter.
#
# The arms, and why each one empties the list rather than dropping one
# entry: a non-empty list is what trades the full suite away, so any entry
# this step cannot vouch for has to put the whole run back.
#   - `*/*/*/*/*` — anything below `apps/desktop/test/e2e/`, i.e. a
#     helper, fixture, or page object. Bash `case` patterns are not
#     pathname expansion (`*` matches `/`), so this arm has to come FIRST
#     or the spec arm below would happily accept `helpers/thing.spec.ts`.
#   - the character arm, for the same reason the browser step has one.
#   - `-f` and `! -L`, because dorny reports a DELETED or renamed-away
#     path exactly as it reports an edited one, and a symlink is not in
#     the file universe `testDir` walks.
set -euo pipefail
selected=""
for path in ${DESKTOP_SPEC_FILES:-}; do
  # ISS-9871 (PRD-574 L2): a merge group runs the smoke subset plus
  # every changed top-level spec, and nothing widens it, because the
  # full suite runs post-merge (desktop-e2e-validation.yml). A path the
  # union cannot name is skipped here rather than emptying the list.
  if [ "${EVENT_NAME:-}" = "merge_group" ]; then
    case "${path}" in
      apps/desktop/test/e2e/*/* | apps/desktop/test/e2e/*[!A-Za-z0-9._-]*) ;;
      apps/desktop/test/e2e/?*.spec.ts)
        if [ -f "${path}" ] && [ ! -L "${path}" ]; then
          selected="${selected:+${selected} }${path##*/}"
        fi
        ;;
    esac
    continue
  fi
  case "${path}" in
    apps/desktop/test/e2e/*/*) selected=""; break ;;
    apps/desktop/test/e2e/*[!A-Za-z0-9._-]*) selected=""; break ;;
    apps/desktop/test/e2e/?*.spec.ts)
      if [ ! -f "${path}" ] || [ -L "${path}" ]; then selected=""; break; fi
      selected="${selected:+${selected} }${path##*/}"
      ;;
    *) selected=""; break ;;
  esac
done
echo "desktop_e2e_changed_specs=${selected}" >> "$GITHUB_OUTPUT"
if [ -n "${selected}" ]; then
  echo "desktop-e2e: running the smoke subset plus the specs this change touched — ${selected}"
else
  echo "desktop-e2e: no narrowable changed-spec list — either nothing under apps/desktop/test/e2e/ changed, or something the subset cannot stand in for did (a helper, fixture, page object, playwright.config.ts, or a spec name outside [A-Za-z0-9._-]). The smoke tag below decides which of those two this is."
fi
