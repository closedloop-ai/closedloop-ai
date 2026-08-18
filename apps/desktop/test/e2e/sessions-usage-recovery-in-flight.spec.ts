/**
 * ISS-4561 (wongk review, PR #4764): the Sessions summary strip must keep saying
 * "recovering" while the LAST transient-usage recovery refetch is still in flight,
 * and only dash to unavailable once that read has come back empty-handed.
 *
 * The defect this guards: `useUsageTransientRecovery` counted an attempt when its
 * refetch was DISPATCHED, so the counter hit `MAX_TRANSIENT_QUERY_RETRIES` the
 * instant the final refetch was fired and `usageRecoveryExhausted` went true about a
 * read that had not returned yet. The cards dashed to "unavailable" over a recovery
 * still in progress — "recovering" and "recovered nothing" are different facts.
 *
 * Driven through the LAUNCHED app, per `apps/desktop/AGENTS.md` ("UI bug fix ⇒
 * regression e2e"): the real Electron shell, the real `pageData` IPC handler and its
 * real list read, the real preload bridge and local data source, the real react-query
 * cache and its desktop poll defaults, the real hook, and the real mounted
 * `SessionsSummaryCards`. Two inputs the harness cannot otherwise produce are supplied
 * by `helpers/sessions-page-data-gate-preload.cjs`: the usage half's transient FAILURE
 * (in production a forked db-host child restarting mid-backfill — a lifecycle race no
 * spec can schedule) and the TIMING of the response, so the final attempt can be held
 * in flight while the strip is read. There is no HTTP on this path, so `page.route`
 * intercepts nothing; the IPC response boundary is its local analogue.
 *
 * The three beats:
 *   1. drive the usage read to failure until the final recovery attempt is dispatched;
 *   2. hold that attempt PENDING — the strip must still be recovering, NOT unavailable;
 *   3. let it settle, still failing — the strip dashes to the honest unavailable state.
 *
 * Beat 2 is the regression. Beat 3 also VALIDATES beat 2: it can only pass if the read
 * held at beat 2 really was the recovery's final attempt, since releasing anything else
 * leaves the recovery unexhausted and the cards never dash.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  armSessionsUsageFailure,
  MAX_TRANSIENT_RECOVERY_ATTEMPTS,
  readGateDispatchCount,
  readGateSettledCount,
  releaseHeldPageDataReads,
  waitForHeldRecoveryAttempt,
} from "./helpers/sessions-page-data-gate";
import {
  CARD_DESCRIPTION_SELECTOR,
  CARD_SELECTOR,
  CARD_TITLE_SELECTOR,
  MOUNT_TIMEOUT_MS,
  STRIP_SELECTOR,
} from "./helpers/summary-strip";

/**
 * The seeded row proves the LIST half rendered while the usage half is recovering —
 * the exact shape of the reported bug (the table is fine; only the cards are waiting).
 * Dated at seed time, so it sorts to the top of the first page and this spec never
 * depends on how many sessions the boot collectors found (the operator's real
 * `~/.copilot` history is NOT isolated by the harness, so corpus SIZE is not a stable
 * anchor here — the strip's own state is).
 */
const SEEDED_SESSION_NAME = "iss-4561 usage recovery session";

/** `SESSIONS_METRIC_CARD_LABEL` — the first card in the strip. */
const SESSIONS_CARD_LABEL = "Sessions";

/** `KPI_NO_VALUE` (`@repo/app/shared/lib/format-utils`) — the honest unavailable dash. */
const KPI_NO_VALUE = "—";

test.describe("Sessions usage recovery in flight (ISS-4561)", () => {
  test("the summary strip stays recovering until the final usage refetch settles", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-usage-recovery");
    const env = { CLAUDE_HOME: dirs.claudeHome, CODEX_HOME: dirs.codexHome };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      // The app must be DOWN to seed: a running app does not observe another
      // process's writes to its own store.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        await waitForBranchesSchema(dirs.userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(dirs.userDataDir, [
        { sessionId: "iss-4561-usage-recovery", name: SEEDED_SESSION_NAME },
      ]);

      // Launch 2 — the same store, with the pageData gate installed. Every
      // response is held until this spec releases it, and the usage half comes
      // back transiently failed.
      const app = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        sessionsPageDataGate: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        await gotoNav(app.page, "sessions");

        // The strip and the Sessions card, scoped to the visible view (keep-alive
        // views stay mounted-but-hidden and render the same markup).
        const strip = app.page
          .locator(STRIP_SELECTOR)
          .locator("visible=true")
          .first();
        const sessionsCard = strip.locator(CARD_SELECTOR).first();
        const sessionsCardValue = sessionsCard.locator(CARD_TITLE_SELECTOR);

        // The app boots with the gate inert, so the strip settles on REAL totals
        // off the seeded store first — the state the reported bug starts from.
        await app.page.locator('[aria-label="All time"]:visible').click();
        await expect(
          app.page.getByRole("link", { name: SEEDED_SESSION_NAME, exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // Non-vacuity: the card this spec reads its verdict off is the Sessions
        // card, not whichever tile happens to be first.
        await expect(
          sessionsCard.locator(CARD_DESCRIPTION_SELECTOR)
        ).toContainText(SESSIONS_CARD_LABEL);
        await expect(sessionsCardValue).not.toHaveText(KPI_NO_VALUE);

        // Beat 1a — the usage half starts failing transiently. Exactly one response
        // carries that through (a held one would never reach the renderer and the
        // hook would never start); every response after it is held.
        const openedAt = await armSessionsUsageFailure(app.app);
        await expect
          .poll(() => readGateSettledCount(app.app), {
            timeout: MOUNT_TIMEOUT_MS,
          })
          .toBeGreaterThanOrEqual(openedAt);
        // The list keeps rendering while the cards hold — the exact shape of the
        // reported failure, and the reason this is not simply a loading state.
        await expect(
          app.page.getByRole("link", { name: SEEDED_SESSION_NAME, exact: true })
        ).toBeVisible();
        await expect(strip).toHaveAttribute("aria-busy", "true");

        // Beat 1b — run the recovery down to its LAST attempt: let every earlier
        // attempt settle (still failing), so the counter reaches one below the cap.
        let dispatched = await readGateDispatchCount(app.app);
        for (
          let attempt = 1;
          attempt < MAX_TRANSIENT_RECOVERY_ATTEMPTS;
          attempt += 1
        ) {
          dispatched = await waitForHeldRecoveryAttempt(app.app, dispatched);
          await releaseHeldPageDataReads(app.app);
        }

        // Beat 2 — the FINAL attempt is dispatched and HELD in flight. This is the
        // regression: with the attempt counted at dispatch, the counter has already
        // reached the cap here and the cards dash about a read still in progress.
        await waitForHeldRecoveryAttempt(app.app, dispatched);
        await expect(strip).toHaveAttribute("aria-busy", "true");
        await expect(sessionsCardValue).not.toHaveText(KPI_NO_VALUE);

        // Beat 3 — the final attempt settles, still failing. NOW the recovery is
        // genuinely exhausted, and the honest dash is the correct render. Passing
        // this also proves the read held at beat 2 was the final attempt: releasing
        // anything else would leave the recovery unexhausted and the cards busy.
        expect(await releaseHeldPageDataReads(app.app)).toBeGreaterThanOrEqual(
          1
        );
        await expect(sessionsCardValue).toHaveText(KPI_NO_VALUE, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(strip).not.toHaveAttribute("aria-busy", "true");

        expect(app.pageErrors).toEqual([]);
      } finally {
        await app.cleanup();
      }
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});
