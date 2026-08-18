/**
 * E2E test (ISS-4573, ISS-4444 follow-up): the "N transcripts couldn't be read"
 * caveat on the Sessions summary card survives the REAL boundary —
 * `CollectorManager` → runtime-status IPC → preload → `SessionsView` →
 * `SessionsSummaryCards`. The pre-existing component render tests inject the
 * runtime-status/`couldNotImportCount` at each end; this proves the whole chain by
 * driving a genuine quarantine through the launched app's utility-process parse
 * boundary.
 *
 * How the quarantine is tripped fast (test-only, E2E-launch-env-gated): the
 * `CLOSEDLOOP_E2E_PARSE_QUARANTINE=1` launch env arms the parse-quarantine seam
 * (`e2e-parse-quarantine-seam.ts`) — it tightens the manager's per-source parse
 * deadline to ~2s and drops the quarantine threshold to 1, and makes the seeded
 * POISON transcript's worker parse never settle. So the poison source wedges once,
 * is dead-lettered, and is quarantined on the first pass — `quarantinedCount` → 1
 * — while the seeded HEALTHY transcript imports normally so the cards settle on
 * real values (the caveat only renders on a settled, non-errored Sessions card). A
 * production launch never sets the env, so none of this affects a real run.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: pnpm -C apps/desktop test:e2e (with an isolated CODEX_HOME)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_PARSE_QUARANTINE_ENV } from "../../src/main/collectors/engine/e2e-parse-quarantine-seam.js";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedClaudeTranscripts,
  seedPoisonClaudeTranscript,
} from "./helpers/seed";

const HEALTHY_SESSION_ID = "quarantine-caveat-healthy-session";
const HEALTHY_SLUG = "quarantine-caveat-healthy";
// The settled Sessions card's caveat copy, count-agnostic. Matches the
// singular/plural forms `resolveSessionsCardDetail` renders in
// `sessions-summary-cards.tsx` ("1 transcript couldn't be read" /
// "N transcripts couldn't be read"). PR #4085 review (wongk / stage): the seam's
// tightened 2s deadline is manager-wide, so on a busy CI runner a second real
// source could also cross it and push the count past 1 — asserting the
// count-agnostic caveat (not the exact "1" string) keeps the test honest about the
// chain it proves (a nonzero quarantined count surfaced the caveat) without going
// red on plural copy. The other collectors are also disabled below to keep the
// seeded poison the only expected quarantine candidate.
const CAVEAT_PATTERN = /\d+ transcripts? couldn't be read/;
// The always-available cards' skeleton-wait captions; asserting neither remains lets
// us prove the loading state CLEARED before the caveat is checked.
const IMPORTING_CAPTION = "Importing your history";
// PR #4085 review (wongk): give this import-heavy launch spec an explicit timeout
// like the nearby Sessions E2Es — the ~46s local run plus CI startup/import variance
// leaves almost no headroom under Playwright's 60s default before the 45s caveat wait.
const SPEC_TIMEOUT_MS = 120_000;

test.describe("Sessions quarantine caveat", () => {
  test("surfaces the 'transcripts couldn't be read' caveat through the real import boundary", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-quarantine-caveat-claude-")
    );
    // A healthy transcript so the boot import writes real sessions and the cards
    // settle on real values, plus a poison one the worker wedges → quarantine.
    seedClaudeTranscripts(claudeHome, [
      {
        sessionId: HEALTHY_SESSION_ID,
        slug: HEALTHY_SLUG,
        userText: "Healthy transcript for the quarantine-caveat E2E.",
        assistantText: "Imported normally alongside the poison transcript.",
      },
    ]);
    seedPoisonClaudeTranscript(claudeHome);

    // Isolate CODEX_HOME to a fresh dir so the manager-wide 2s parse deadline
    // cannot quarantine the operator's real Codex history (also the AGENTS.md
    // Electron-E2E isolation requirement), and disable the toggleable cursor/copilot
    // collectors so the seeded poison transcript is the only expected quarantine
    // candidate. Keeps the quarantine attributable to our seed on a busy runner.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-quarantine-caveat-codex-")
    );

    const { page, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-quarantine-caveat-e2e-",
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          collectCursorEnabled: false,
          collectCopilotEnabled: false,
        });
      },
      env: {
        CLAUDE_HOME: claudeHome,
        CODEX_HOME: codexHome,
        // Arm the test-only parse-quarantine seam so the poison transcript trips
        // quarantine within the e2e budget.
        [E2E_PARSE_QUARANTINE_ENV]: "1",
      },
    });

    try {
      await gotoNav(page, "sessions");

      // (a) The always-available loading state CLEARS: the "Importing your history"
      // wait caption must not persist — the cards settle on real values (the caveat
      // is only rendered on a settled, non-loading Sessions card). Auto-retrying
      // assertion (no fixed sleep).
      await expect(page.getByText(IMPORTING_CAPTION)).toHaveCount(0, {
        timeout: 30_000,
      });

      // (b) The caveat RENDERS on the Sessions summary card once the poison
      // transcript is quarantined and its count crosses the runtime-status boundary.
      await expect(page.getByText(CAVEAT_PATTERN).first()).toBeVisible({
        timeout: 45_000,
      });
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
