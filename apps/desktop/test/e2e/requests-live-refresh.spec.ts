/**
 * ISS-5808 — Electron E2E regression for the Requests view's LIVE refresh.
 *
 * The reported defect only exists in the launched app: the Requests page read
 * the job store once on mount and then showed that snapshot for as long as it
 * stayed open, so a loop that started or ended while someone was watching never
 * changed the card. A mounted renderer test with a mocked `desktopApi` cannot
 * catch that — it proves the component re-reads a mock, not that the real
 * preload → `desktop:list-running-jobs` → JobStore → snapshot-enrichment path
 * reaches the screen (review #4783). Hence this spec.
 *
 * HOW THE STATE CHANGE IS DRIVEN, and why it is this direction:
 *
 * `JobStore` reads `desktop-job-store.json` ONCE in its constructor and serves
 * `listRunning()` from memory, so writing a NEW job to that file mid-test is
 * invisible without a relaunch — and a relaunch re-reads on mount, which is
 * exactly the behavior that was already working. Observing a job APPEAR would
 * therefore prove nothing. Observing one LEAVE does: the spec seeds a job whose
 * `pid` belongs to a real, live child process, then kills that process. On the
 * next poll `enrichJobSnapshot` sees the pid is gone, derives a terminal status,
 * and the row leaves Running Jobs — through the production reconciliation path,
 * with no navigation, no reload, and nothing touched in the renderer.
 *
 * That makes the final assertion a true regression guard: with the poll removed
 * the row stays on screen forever and this spec fails. It cannot pass either
 * way.
 *
 * The live pid is not optional. Boot reconciliation
 * (`job-store-boot-reconciliation.ts`) terminalizes any active job with a null
 * pid to `UNKNOWN` before the first render, so a pid-less seed would show up
 * under Completed Jobs and never reach the card under test.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "../../src/shared/desktop-requests-live-refresh-flag";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

/**
 * Electron-store file name for `JobStore` (`new Store({ name:
 * "desktop-job-store" })`). Pinned as a literal rather than imported:
 * `src/main/jobs/job-store.ts` pulls electron-store and `@closedloop-ai/loops-api`, and
 * a specifier Playwright's ESM loader cannot resolve aborts the WHOLE e2e file
 * at load — same precedent as `db-ahead-banner.spec.ts`.
 */
const JOB_STORE_FILENAME = "desktop-job-store.json";

const SEEDED_TICKET = "ISS-5808";
/** `deriveJobLabel` renders `${COMMAND_LABELS[command]} · ${ticketId}`. */
const SEEDED_JOB_LABEL = `Plan · ${SEEDED_TICKET}`;

/**
 * Comfortably past the view's 5s refresh interval, plus IPC enrichment. Traced
 * live at ~6s locally; 30s leaves headroom without letting the two post-kill
 * assertions eat the whole test budget on a slow CI runner.
 */
const REFRESH_OBSERVATION_TIMEOUT_MS = 30_000;

/**
 * A real, long-lived process whose pid the seeded job can claim. Boot
 * reconciliation and per-read enrichment both call `process.kill(pid, 0)`, so
 * only a genuinely running process keeps the job in the Running list.
 *
 * Uses the Node binary already running the test rather than `sleep` so the spec
 * does not depend on a shell utility being present on the runner.
 */
function spawnLivingProcess(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => undefined, 120000)"],
    { detached: false, stdio: "ignore" }
  );

  // Per test/AGENTS.md: a spawn helper must handle `error`, or a failure to
  // launch hangs the test instead of reporting.
  child.on("error", (error) => {
    throw new Error(
      `failed to spawn the stand-in job process: ${error.message}`
    );
  });
  return child;
}

function seedRunningJob(userDataDir: string, pid: number): void {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(userDataDir, JOB_STORE_FILENAME),
    JSON.stringify(
      {
        activeJobs: [
          {
            command: "PLAN",
            id: "iss-5808-live-refresh-job",
            kind: "SYMPHONY_LOOP",
            loopId: "iss-5808-loop",
            pid,
            startedAt: now,
            status: "RUNNING",
            ticketId: SEEDED_TICKET,
            updatedAt: now,
          },
        ],
        terminalJobs: [],
      },
      null,
      2
    ),
    "utf8"
  );
}

function runningJobRow(page: Page) {
  return page.getByText(SEEDED_JOB_LABEL, { exact: true });
}

/**
 * The Completed Jobs disclosure summary, which carries the count.
 *
 * The job's LABEL cannot be the signal on its own: when the runner dies the job
 * moves from Running Jobs to Completed Jobs, and both cards render the same
 * `deriveJobLabel` text, so its total count stays 1 across the transition
 * whether the view refreshed or not. Traced live before this spec was written —
 * the label count sat at 1 the whole time while the panel correctly flipped
 * underneath it. The empty-state copy plus this count name WHICH card holds it.
 */
function completedJobsSummary(page: Page, count: number) {
  return page.getByText(`Completed Jobs (${count})`, { exact: true });
}

test.describe("Requests view live refresh (ISS-5808)", () => {
  test("drops a running job from the card once its process exits, without a reload", async () => {
    // Generous against the sum of the explicit timeouts below at CI's 15s
    // default expect timeout, so a slow runner fails on an ASSERTION with a
    // named locator rather than on an unattributable test-level timeout.
    test.setTimeout(240_000);

    const child = spawnLivingProcess();
    try {
      const pid = child.pid;
      expect(pid, "the stand-in job process must report a pid").toBeTruthy();

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        userDataPrefix: "desktop-requests-live-refresh-e2e-",
        beforeLaunch: (userDataDir) => {
          // Default-off Labs gate — the live behavior does not exist until it
          // is seeded on, so this call is what puts the spec on the gated path.
          seedDesktopFeatureFlags(userDataDir, {
            [DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY]: true,
          });
          seedRunningJob(userDataDir, pid as number);
        },
      });

      try {
        await gotoNav(page, "requests");
        await expect(
          page.getByRole("heading", { level: 1, name: "Requests" })
        ).toBeVisible({ timeout: 30_000 });

        // The seeded job survived boot reconciliation and reached the card.
        // This is also what stops the assertions below from being vacuous: the
        // job was provably RUNNING, in the running card, before anything moved.
        await expect(runningJobRow(page)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("Running", { exact: true })).toBeVisible();
        await expect(page.getByText("No running jobs")).toHaveCount(0);
        await expect(completedJobsSummary(page, 0)).toBeVisible();

        // The loop ends while the operator is looking at the page — the exact
        // situation the mount-time snapshot could never represent. Killing the
        // pid is what the production reap keys off: the next poll's
        // `enrichJobSnapshot` sees the process is gone and finalizes the job.
        child.kill("SIGKILL");
        // Wait for the real exit so the pid is reaped before the app looks;
        // a zombie still answers `process.kill(pid, 0)` and would read alive.
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        });

        // No reload, no re-navigation, no click: the ONLY thing that can move
        // this job between the two cards is the view re-reading on its own.
        // With the poll removed both assertions fail.
        await expect(page.getByText("No running jobs")).toBeVisible({
          timeout: REFRESH_OBSERVATION_TIMEOUT_MS,
        });
        await expect(completedJobsSummary(page, 1)).toBeVisible({
          timeout: REFRESH_OBSERVATION_TIMEOUT_MS,
        });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
