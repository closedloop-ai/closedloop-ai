/**
 * E2E regression (ISS-4716): the import splash's sync footnote tells the truth,
 * proven through the LAUNCHED app.
 *
 * The renderer suites cover the derivation, the poll hook, and the flag gate in
 * isolation, but none of them launches Electron and flows a real
 * `TranscriptSyncService` snapshot through `getStatusSnapshot` → the
 * runtime-info IPC → the mounted splash. This spec closes that gap (the
 * launched-app regression `apps/desktop/AGENTS.md` requires for a UI bug fix,
 * including its visual dimension — the footer's icon and tone change with it).
 *
 * Would fail before the fix: the footer was a hardcoded text node reading
 * "Computed on this device · 0 bytes uploaded" in every phase and under every
 * sync tier, so it rendered that string here too.
 *
 * WHY THE EXPECTED LABEL IS "Transcript upload isn't connected":
 * the seed below persists a coherent `full` Data & Sync config, so the real
 * transcript-sync service IS constructed and the real `getStatusSnapshot()` runs
 * (exercising the tier gate, `storeReady`, and the reader-pool status census).
 * An E2E profile has no first-party auth, and that single fact drives two
 * things: `OrgSyncPolicyStore` never leaves its `Unknown` init, and
 * `isOnline()` (`getComputeTargetId() !== null && hasDesktopSessionAuth()`) is
 * false.
 *
 * ISS-5348 changed which of those wins. The gate now reports `Unresolved`
 * rather than a settled denial, and `Unresolved` is deliberately checked BELOW
 * `!online` — `Unknown` has no timeout, so a profile like this one would
 * otherwise hold a skeleton forever. So the settled, true `NotConnected` is
 * what renders. That is the correct target: reaching it proves the real service
 * ran (it requires `enabled`, a non-denied gate, and `storeReady: true`),
 * whereas the synthetic null-service fallback would land on `Disabled` and
 * prove nothing about the main-process work. Do NOT "fix" this toward
 * `Enabled`.
 *
 * NO FLAG IS INVOLVED (ISS-5348). There is no key to seed and none to pin: this
 * spec now proves that a DEFAULT install renders the honest footer. The copy is
 * still pinned as a LITERAL rather than imported from
 * `renderer/components/import-splash/sync-footnote-state`, because importing a
 * renderer/`src` module from a spec aborts the whole Electron run under
 * Playwright's Node loader (see the same note in `db-ahead-banner.spec.ts`).
 * That literal has no compile-time tie to the label map, so it is a genuine
 * duplicate: if `SYNC_FOOTNOTE_LABELS[NotConnected]` is reworded, this spec
 * fails on the rendered text and must be updated with it. The registry-drift
 * safety net that used to back this note went away with the flag.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktopApp,
  seedDesktopSyncSettings,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

const LEGACY_FOOTER_COPY = "Computed on this device · 0 bytes uploaded";
const EXPECTED_FOOTER_COPY = "Transcript upload isn't connected";

// Enough sessions that the import is still in flight when the assertion runs —
// the splash is only visible while importing (plus a short settle bridge), and
// the footnote polls only while it is visible.
const SEEDED_SESSION_COUNT = 40;

test("ISS-4716: the import splash reports real sync state instead of a hardcoded byte count", async () => {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "honest-sync-footer-claude-")
  );
  seedClaudeTranscripts(
    claudeHome,
    Array.from({ length: SEEDED_SESSION_COUNT }, (_, index) => ({
      sessionId: `honest-sync-${index}`,
      slug: `honest-sync-${index}`,
    })),
    "honest-sync-footer-project"
  );

  const { page, cleanup } = await launchDesktopApp({
    userDataPrefix: "desktop-honest-sync-footer-e2e-",
    env: { CLAUDE_HOME: claudeHome },
    beforeLaunch: (userDataDir) => {
      // ISS-5348: no flag is seeded. The honest footer ships unconditionally, so
      // this now proves a DEFAULT install renders it — the assertion the suite
      // never had while this shipped behind a default-off Labs flag.
      // One coherent config. `dataSyncLevel` must be present or the settings
      // migration treats the profile as legacy and re-derives (and overwrites)
      // these booleans from `cloudConnectionEnabled: false`.
      seedDesktopSyncSettings(userDataDir, {
        dataSyncLevel: "full",
        cloudConnectionEnabled: true,
        cloudCommandsPaused: false,
        transcriptSyncEnabled: true,
        syncObservabilityTier: "full",
      });
    },
  });

  try {
    const banner = page.getByTestId("first-launch-import-banner");
    await expect(banner).toBeVisible({ timeout: 60_000 });

    // Positive assertion first: the footer must actually say something derived.
    // Asserting only the absence of the old string would pass vacuously on a
    // splash that never rendered.
    await expect(banner.getByText(EXPECTED_FOOTER_COPY)).toBeVisible({
      timeout: 60_000,
    });

    // ...and the hardcoded claim is gone.
    await expect(banner).not.toContainText(LEGACY_FOOTER_COPY);
    await expect(banner).not.toContainText("0 bytes");
  } finally {
    await cleanup();
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});
