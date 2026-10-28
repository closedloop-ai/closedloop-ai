/**
 * ISS-7593 regression, driven through the LAUNCHED app: pressing Pause on
 * Diagnostics -> Gateway Logs must stop the answer the operator is already
 * waiting on, not just the next 3s tick.
 *
 * Before the fix, `load` was rebuilt whenever `paused` changed, so toggling
 * Pause tore the effect down and cleared the interval — but a `getLogs()`
 * already in flight still ran its `setEntries`, and the rows the operator
 * paused to read were replaced underneath them a moment later. The renderer
 * test covers the same guard against a stubbed `window.desktopApi`; this one
 * proves it across the real IPC hop, the real preload bridge, and the real
 * Pause/Resume controls, which is where the effect teardown actually happens.
 *
 * The read has to still be unanswered when Pause is pressed, and a real
 * `desktop:get-logs` answers in well under a frame, so `logsReadGate` parks it
 * — see `helpers/logs-read-gate-preload.cjs` for what that substitutes and
 * what it leaves as the real thing.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type E2eLogEntry,
  holdLogsReads,
  pendingLogsReads,
  releaseLogsReads,
  setLogsPayload,
} from "./helpers/logs-read-gate";

const DIAGNOSTICS_HEADING = "Diagnostics";
const GATEWAY_LOGS_TAB = "Gateway Logs";
const VISIBLE_TIMEOUT_MS = 20_000;

const BEFORE_PAUSE = "e2e row present before the operator paused";
const ARRIVED_AFTER_PAUSE = "e2e row that must never land after a pause";
const AFTER_RESUME = "e2e row read after the operator resumed";

/** Records whether `needle` was EVER in the document, not just at the end. */
const WATCH_KEY = "__clE2eSawPausedRow";

function logRow(message: string): E2eLogEntry {
  return {
    level: "info",
    message,
    tag: "gateway",
    timestamp: "2026-08-23T12:00:00.000Z",
  };
}

test.describe("Diagnostics gateway logs — Pause (ISS-7593)", () => {
  test("drops a log read already in flight instead of committing it after Pause", async () => {
    const launched = await launchDesktopApp({
      logsReadGate: true,
      userDataPrefix: "desktop-logs-pause-e2e-",
    });
    const { app, page, cleanup, pageErrors } = launched;

    try {
      await setLogsPayload(app, [logRow(BEFORE_PAUSE)]);

      await gotoNav(page, "diagnostics");
      await expect(
        page.getByRole("heading", { name: DIAGNOSTICS_HEADING })
      ).toBeVisible({ timeout: VISIBLE_TIMEOUT_MS });
      await page.getByRole("tab", { name: GATEWAY_LOGS_TAB }).click();
      // Diagnostics has its OWN Refresh beside the log panel's, so every
      // control here is addressed through the Gateway Logs tabpanel.
      const logs = page.getByRole("tabpanel", { name: GATEWAY_LOGS_TAB });
      await expect(logs.getByText(BEFORE_PAUSE)).toBeVisible({
        timeout: VISIBLE_TIMEOUT_MS,
      });

      // A commit that lands and is then replaced is still the bug, and the
      // final DOM cannot tell the difference — the log list is rewritten whole
      // on every read. Watch for the row instead of sampling for it.
      await page.evaluate(
        ({ key, needle }) => {
          const watched = globalThis as unknown as Record<string, boolean>;
          watched[key] = document.body.innerText.includes(needle);
          new MutationObserver(() => {
            if (document.body.innerText.includes(needle)) {
              watched[key] = true;
            }
          }).observe(document.body, {
            characterData: true,
            childList: true,
            subtree: true,
          });
        },
        { key: WATCH_KEY, needle: ARRIVED_AFTER_PAUSE }
      );

      // Start the read the operator is waiting on, then stop waiting for it.
      await holdLogsReads(app);
      await logs.getByRole("button", { name: "Refresh" }).click();
      await expect
        .poll(() => pendingLogsReads(app), {
          message: "a log read is parked, so Pause lands mid-read",
          timeout: VISIBLE_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);

      await logs.getByRole("button", { name: "Pause" }).click();
      const answered = await releaseLogsReads(app, [
        logRow(ARRIVED_AFTER_PAUSE),
      ]);
      expect(answered, "the parked read was answered").toBeGreaterThan(0);

      // The anchor: Resume issues a fresh read that DOES commit. Its arrival is
      // strictly after the parked read resolved, so by the time this is visible
      // the dropped answer has had its whole chance to render.
      await setLogsPayload(app, [logRow(AFTER_RESUME)]);
      await logs.getByRole("button", { name: "Resume" }).click();
      await expect(logs.getByText(AFTER_RESUME)).toBeVisible({
        timeout: VISIBLE_TIMEOUT_MS,
      });

      const sawPausedRow = await page.evaluate(
        (key) => (globalThis as unknown as Record<string, boolean>)[key],
        WATCH_KEY
      );
      expect(
        sawPausedRow,
        "the answer the operator paused never reached the log"
      ).toBe(false);
      expect(pageErrors, "no renderer errors").toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
