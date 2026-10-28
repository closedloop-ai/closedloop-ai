import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import type { DesktopApi } from "../../../src/renderer/types/desktop-api";

/** How long, and how often, to re-ask the main process to park or resume the backfill. */
const PAUSE_ATTEMPTS = 24;
const PAUSE_INTERVAL_MS = 250;

/**
 * Park or resume the first-launch backfill the way the import banner does.
 *
 * `first-launch-import-banner.tsx` calls this same preload method, and the main
 * handler forwards it to `CollectorManager.pauseImport()`, whose gate parks the
 * pass loop BETWEEN sources — after the scan has opened the pass, so the byte
 * ledger is populated and its remainder simply stops draining.
 */
export async function setImportPaused(
  page: Pick<Page, "evaluate">,
  paused: boolean,
  options: {
    acknowledgeParked?: boolean;
    observeReport?: (report: unknown) => void;
  } = {}
): Promise<void> {
  if (options.acknowledgeParked === true) {
    await requestImportPauseUntilParked(
      () =>
        page.evaluate(async (shouldPause) => {
          const api: Partial<DesktopApi> | undefined = window.desktopApi;
          if (
            api?.setAgentMonitorImportPaused === undefined ||
            api.getRuntimeStatus === undefined
          ) {
            return null;
          }
          await api.setAgentMonitorImportPaused(shouldPause);
          return api.getRuntimeStatus();
        }, paused),
      // timeout: 0 keeps the test deadline, minus Playwright's 250ms margin.
      // Outside a test context it adds no deadline; requests are still capped at 24.
      (probe) =>
        expect
          .poll(probe, { intervals: [PAUSE_INTERVAL_MS], timeout: 0 })
          .toBe(true),
      paused,
      options.observeReport
    );
    return;
  }
  await page.evaluate(
    async ([attempts, intervalMs, shouldPause]) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        // Re-read the bridge on every attempt: the preload object can be absent
        // on the first tick, and capturing it once would retry a hole.
        const api = (
          window as unknown as {
            desktopApi?: {
              setAgentMonitorImportPaused?: (paused: boolean) => Promise<void>;
            };
          }
        ).desktopApi;
        await api?.setAgentMonitorImportPaused?.(shouldPause);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    [PAUSE_ATTEMPTS, PAUSE_INTERVAL_MS, paused] as const
  );
}

const importPauseReportSchema = z
  .object({
    ingest: z.object({ importParked: z.boolean() }).nullable(),
  })
  .nullable();

/**
 * Wait for actual gate waiters, rather than the requested pause flag. Callers
 * that pause before consent opens must retain the original request-only path.
 * The request cap includes IPC work; the caller keeps its enclosing deadline
 * rather than imposing a shorter wall-clock budget on those requests.
 */
export async function requestImportPauseUntilParked(
  request: () => Promise<unknown>,
  poll: (probe: () => Promise<boolean>) => Promise<void>,
  paused: boolean,
  observeReport?: (report: unknown) => void
): Promise<void> {
  let attempts = 0;
  await poll(async () => {
    attempts += 1;
    const rawReport = await request();
    observeReport?.(rawReport);
    const report = importPauseReportSchema.parse(rawReport);
    if (report?.ingest?.importParked === paused) {
      return true;
    }
    if (attempts === PAUSE_ATTEMPTS) {
      throw new Error(
        `Import did not acknowledge ${paused ? "pause" : "resume"} after ${PAUSE_ATTEMPTS} requests`
      );
    }
    return false;
  });
}
