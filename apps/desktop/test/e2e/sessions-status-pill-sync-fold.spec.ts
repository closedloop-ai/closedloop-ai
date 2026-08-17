/**
 * ISS-4848 (Electron twin): the Sessions Status-cell sync-state fold on the
 * DESKTOP adapter, driven seed-to-render through the real SQLite store and the
 * renderer's `SessionsView` -> `SyncedSessionsTable`, with the Labs flag ON. The
 * web twin is `e2e/sessions-status-pill-sync-fold.spec.ts`; both mount the same
 * shared table (`packages/app`), so wongk's cross-surface rule (PR #4202) wants a
 * real-surface regression on each adapter.
 *
 * SCOPE, stated honestly, because wongk asked (PR #4474) why this spec does not
 * simply seed a `syncing` disposition. Seeding one changes nothing: the gate is
 * not the seed, it is the compute target, and on this profile there isn't one.
 * The chain, so it can be re-verified rather than taken on trust:
 *
 *   1. `test/e2e/helpers/desktop-app.ts` `seedE2eDesktopSettings` persists
 *      `cloudConnectionEnabled: false` for EVERY spec, deliberately — "these
 *      Electron flows assert renderer and local database behavior and should not
 *      depend on external Socket.IO handshakes".
 *   2. `src/main/app.ts` `onlineComputeTargetId()` returns the target id only
 *      when `this.cloudStatus.state === "online"`, i.e. only after that
 *      handshake. Offline it is `null`.
 *   3. `src/main/dashboard/rebuild-sync-compute-target.ts`
 *      `buildSharedAgentSessionsListOptions` passes that value straight through
 *      as `computeTargetId`, and `resolveRebuildSyncComputeTargetId` honors a
 *      wired-but-null getter as null rather than falling back to a stale id.
 *   4. `src/main/session/local-transcript-cloud-sync.ts`
 *      `loadLocalTranscriptDispositions` returns an EMPTY map when
 *      `computeTargetId` is falsy, so no row on this profile can carry a
 *      `transcriptDisposition` no matter what the SQLite seed contains. The
 *      outbox lane (`shared-agent-sessions-api.ts` `loadPendingOutboxIdSet`)
 *      short-circuits on the same value.
 *
 * Reaching the uploading branch here therefore means bringing a cloud
 * handshake into the Electron harness, which is the one thing the launch helper
 * exists to keep out. So this twin pins the half that IS reachable and does not
 * claim the other, and the uploading branch is driven on the desktop adapter by
 * `src/renderer/feature-flags/__tests__/desktop-feature-flag-provider.test.tsx`,
 * which mounts the real `SyncedSessionsTable` under the real
 * `DesktopFeatureFlagProvider` against a packaged build (`isPackaged: true`)
 * with only the persisted Labs value flipped.
 *
 * So this twin pins the half that IS reachable, and it is NOT vacuous. With the
 * fold flag ON:
 *   - every seeded row renders its TRUE run status, and
 *   - NO row renders the "Syncing" pill, because none of them is uploading.
 * Drop the `isSessionRowUploading` guard from `session-status-fold.ts` — the most
 * likely way this fold goes wrong — and every Active desktop row would light up
 * "Syncing" and this spec fails. It also proves the desktop adapter actually
 * mounts the flag-aware path (a Labs flag whose renderer throws or blanks the
 * list would fail here too).
 *
 * ISS-5036 extends that reachable half rather than pretending to reach further.
 * The consolidation turned the fold from ADDITIVE (an extra "Syncing" pill beside
 * "Active") into a THROB on the existing pill (ISS-5279 — no replacement, no
 * dot), so the invariant this harness CAN prove got stronger and is now pinned in
 * both directions:
 *   - a non-uploading Active row still says "Active" IN THE STATUS CELL and does
 *     NOT pulse, and
 *   - it grows no liveness dot, because ISS-5279 removed that dot outright.
 * Both are reachable here precisely BECAUSE nothing is uploading: pulse (or paint
 * a dot) on every Active row rather than on genuinely-uploading ones and every
 * desktop row lights up, failing this spec. That is the load-bearing half of "a
 * stopped pulse means finished" — an animation that fires on rows with nothing in
 * flight would mean nothing when it stops. What stays unreachable — a genuinely
 * uploading row pulsing — is covered by the web e2e twin and by the desktop
 * renderer unit test
 * (`src/renderer/feature-flags/__tests__/desktop-feature-flag-provider.test.tsx`),
 * which drives the desktop adapter with a synthetic uploading row. No assertion
 * here claims coverage this profile cannot actually produce.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * ISS-5279: the row's OWN Status pill, marked when it carries a sync
 * presentation. There is no separate "Syncing" badge any more — that was the
 * duplicate. On this profile nothing uploads, so no row may carry the mark.
 */
// Pinned as a literal, not imported: Playwright's Node loader cannot resolve
// the workspace subpath (same constraint as the status literals above). The
// canonical value is `SESSION_STATUS_SYNC_BADGE_TEST_ID` in
// `packages/app/agents/lib/session-sync-presentation.ts`; the vitest suites
// import it, so a rename there goes red before it reaches here.
const STATUS_BADGE_TEST_ID = "session-status-badge-sync";
/**
 * ISS-5279 deleted this dot; the spec still names it so the assertion that it is
 * GONE reads as a deliberate check rather than an omission.
 */
const LIVENESS_DOT_TEST_ID = "session-liveness-dot";
const ACTIVE_NAME = "iss-4848 active session";
const FAILED_NAME = "iss-4848 failed session";

const SEEDED: SessionListSeed[] = [
  { sessionId: "iss-4848-active", name: ACTIVE_NAME, status: "active" },
  { sessionId: "iss-4848-failed", name: FAILED_NAME, status: "error" },
];

test.describe("Sessions Status-cell sync-state fold (ISS-4848 / ISS-5279)", () => {
  test("flag ON: rows keep their true run status, and no non-uploading row is painted Syncing or given a liveness dot", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sync-fold-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts, inflating the
    // seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sync-fold-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sync-fold-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — the fold ships unconditionally (ISS-5366), so nothing to seed.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");

        // Widen to "All time" so the seeded corpus is in range regardless of the
        // run clock. `:visible` scopes to the mounted Sessions toolbar.
        await page.locator('[aria-label="All time"]:visible').click();

        // The corpus rendered — without this the negative assertion below would
        // pass vacuously against a never-rendered list.
        await expect(page.getByRole("link", { name: ACTIVE_NAME })).toBeVisible(
          {
            timeout: 30_000,
          }
        );
        await expect(page.getByRole("link", { name: FAILED_NAME })).toBeVisible(
          {
            timeout: 30_000,
          }
        );

        // Each row shows its OWN true run status. wongk: asserting the two
        // labels page-wide passed even if the statuses were swapped between the
        // rows, so scope each assertion to the row that owns the session link.
        // "Failed" is the ISS-4586 label for the canonical `error` value.
        const activeRow = rowForSession(page, ACTIVE_NAME);
        const failedRow = rowForSession(page, FAILED_NAME);
        await expect(
          activeRow.getByText("Active", { exact: true })
        ).toBeVisible();
        await expect(
          activeRow.getByText("Failed", { exact: true })
        ).toHaveCount(0);
        await expect(
          failedRow.getByText("Failed", { exact: true })
        ).toBeVisible();
        await expect(
          failedRow.getByText("Active", { exact: true })
        ).toHaveCount(0);

        // With the flag ON but no row actually uploading, NO Status pill carries
        // a sync presentation — so nothing pulses. This is the guard assertion:
        // widen the fold past its `isSessionRowUploading` gate and every Active
        // row lights up here. It is also the load-bearing half of "a stopped
        // pulse means finished": a pulse on a row with nothing in flight would
        // make the animation meaningless.
        await expect(page.getByTestId(STATUS_BADGE_TEST_ID)).toHaveCount(0);

        // ISS-5279: and no liveness dot anywhere. The dot existed only to carry
        // the run state a NARROWED pill stopped stating; the pill keeps its
        // lifecycle word now, so the dot is gone from both surfaces.
        await expect(page.getByTestId(LIVENESS_DOT_TEST_ID)).toHaveCount(0);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * The grid row that owns a given session link. The shared `GridTable` renders
 * each row as a `role="row"` container, so scoping from the row keeps a status
 * assertion tied to the session it is about rather than to whatever the page
 * happens to contain (wongk).
 */
function rowForSession(page: Page, sessionName: string): Locator {
  return page.getByRole("row").filter({
    has: page.getByRole("link", { name: sessionName }),
  });
}
