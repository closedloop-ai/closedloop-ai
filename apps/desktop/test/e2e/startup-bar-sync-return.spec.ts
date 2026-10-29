import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
/**
 * ISS-11668 expected behavior 5b, through a LAUNCHED Electron app: once parsing
 * is done, the startup bar comes back for a sync after the sync election, and
 * leaves when its counter reaches 100%.
 *
 * WHY A LAUNCHED APP (ISS-10537; `apps/desktop/test/AGENTS.md` → "Coverage must
 * reach the real boundary"). The renderer suite feeds `useStartupReadiness`
 * mocked runtime statuses and a hand-set `syncElected`. This drives the chain
 * the reader depends on instead: the real session restore deciding the
 * organization, the real consent record deciding the election, and the
 * `cloudSync` sample travelling main → runtime-status IPC → preload → the
 * shared poller → the host → the bar.
 *
 * WHAT IS SUBSTITUTED. Only the `cloudSync` sample, by the preload
 * `cloud-read-readiness-preload.cjs` installs: `identified` is true only while
 * the cloud socket is up with a compute target, which no fixture stands up. The
 * cloud connection is left OFF for the same reason. A socket that cannot reach a
 * relay reports itself degraded, which is the bar's NeedsAttention stage, not
 * the sync under test; off is not a warning (`getCloudWarning`, ISS-4715).
 *
 * WHY TRANSCRIPTS STAY OUTSTANDING. The readiness snapshot has the transcript
 * lane still owing uploads for the whole run. Ruling 11 says the bar leaves at
 * 100% while transcripts keep uploading in the background, so with every lane
 * drained a bar that still waited for transcripts would pass this spec too.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level.ts";
import { z } from "zod";
import type { CloudReadReadinessSnapshot } from "../../src/shared/cloud-read-readiness-contract.js";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import {
  SyncLaneDrainState,
  SyncLaneId,
} from "../../src/shared/sync-burndown-contract.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import { pushCloudSyncProgress } from "./helpers/cloud-sync-progress-control";
import {
  drainedCloudReadReadiness,
  type E2eCloudSyncProgress,
  gotoNav,
  identifiedCloudSyncProgress,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  readStartupBarFrames,
  recordStartupBarFrames,
} from "./helpers/startup-bar-frames";

const PROFILE_ID = "iss-11668-startup-bar-sync-profile";
/**
 * The bar's default label, which ISS-11668 ruling 10 makes the sync stage's
 * label too. Re-typed rather than imported: a TSX module pulled through the
 * Playwright spec loader can abort the whole suite at load time
 * (`test/AGENTS.md` → "Import hazard"). Pinned against the component's
 * `DEFAULT_LABEL` by
 * `packages/app/onboarding/components/__tests__/onboarding-analysis-banner.test.tsx`.
 */
const PROTOTYPE_LABEL = "Analyzing session records";
/** Sessions the lane has delivered, out of the sync's total. */
const DELIVERED_SESSIONS = 3;
const IN_FLIGHT_TOTAL_SESSIONS = 10;
const SYNC_COUNTER = `${DELIVERED_SESSIONS} / ${IN_FLIGHT_TOTAL_SESSIONS}`;
const FINISHED_SYNC_COUNTER = `${IN_FLIGHT_TOTAL_SESSIONS} / ${IN_FLIGHT_TOTAL_SESSIONS}`;
/**
 * Sessions on disk. Their finished parse has a counter of its own, which the
 * sync's exit must never fall back to (ruling 15).
 */
const PARSED_SESSIONS = 4;
/** Transcripts the archive lane still owes while the session lane finishes. */
const TRANSCRIPTS_STILL_UPLOADING = 40;
const SYNC_PERCENT = String(
  (DELIVERED_SESSIONS / IN_FLIGHT_TOTAL_SESSIONS) * 100
);

const AUTH_BUDGET_MS = 30_000;
const PARSE_BUDGET_MS = 120_000;
const STEP_BUDGET_MS = 30_000;

const runtimeIngestSchema = z.object({
  ingest: z.object({ complete: z.boolean() }).nullish(),
});

test("ISS-11668: the startup bar returns for a sync after the sync election and leaves at 100%", async () => {
  test.setTimeout(300_000);

  // A small corpus: parsing finishes quickly, so the only work the bar can come
  // back for is the sync this spec starts.
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11668-claude-")
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-11668-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-11668-udd-"));
  const server = await startAuthenticatedBranchCloudServer();
  const env = {
    CLAUDE_HOME: claudeHome,
    CL_AUTH_API_ORIGIN: server.origin,
    CODEX_HOME: codexHome,
  };

  seedClaudeTranscripts(
    claudeHome,
    Array.from({ length: PARSED_SESSIONS }, (_unused, index) => ({
      sessionId: `iss-11668-sync-${index}`,
      slug: `iss-11668-sync-${index}`,
      userText: `Seeded session ${index}`,
    }))
  );

  try {
    await initializeDesktopProfileSchema(userDataDir);
    await waitForBranchesSchema(userDataDir);

    const { app, page, pageErrors, cleanup } =
      await launchAuthenticatedDesktopApp({
        seedDashboardStorage: true,
        sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
        beforeLaunch: (launchUserDataDir) => {
          seedDesktopSettings(launchUserDataDir, {
            activeConfigId: PROFILE_ID,
            apiOrigin: server.origin,
            cloudConnectionEnabled: false,
            dataSyncLevel: DataSyncLevel.Redacted,
            cloudCommandsPaused: false,
            transcriptSyncEnabled: false,
            savedConfigs: [
              {
                apiOrigin: server.origin,
                gatewayId: AUTHENTICATED_GATEWAY_ID,
                id: PROFILE_ID,
                name: "ISS-11668 Startup Bar Sync E2E",
                relayOrigin: "http://127.0.0.1:9",
                webAppOrigin: "http://127.0.0.1:3000",
              },
            ],
          });
        },
        cloudReadReadiness: transcriptsStillUploading(),
        cloudSyncProgress: notSyncingYetSample(),
        env,
        userDataDir,
      });

    try {
      // Signed in to the organization the launcher's consent seed elected sync
      // for. Asserted first, so a restore that never landed fails here.
      await expect
        .poll(
          () => page.evaluate(() => window.desktopApi.getDesktopAuthState()),
          { timeout: AUTH_BUDGET_MS }
        )
        .toMatchObject({
          organizationId: AUTHENTICATED_ORGANIZATION_ID,
          status: DesktopAuthStatus.Authenticated,
        });

      await gotoNav(page, "dashboard");

      // Parsing is done and no sync has started, so no bar.
      await expect
        .poll(() => readIngestComplete(page), {
          timeout: PARSE_BUDGET_MS,
        })
        .toBe(true);
      const bar = page.getByRole("progressbar");
      await expect(bar).toHaveCount(0, { timeout: STEP_BUDGET_MS });

      // A sync starts: the bar comes back, saying what the prototype says
      // (ruling 10) over the sync's own counter.
      await recordStartupBarFrames(page);
      await pushCloudSyncProgress(app, syncingSample());
      await expect(bar).toHaveCount(1, { timeout: STEP_BUDGET_MS });
      await expect(
        page.getByRole("status").filter({ hasText: PROTOTYPE_LABEL })
      ).toBeVisible();
      await expect(page.getByText(SYNC_COUNTER, { exact: true })).toBeVisible();
      await expect(bar).toHaveAttribute("aria-valuenow", SYNC_PERCENT);

      // The counter reaches 100% and the session lane is caught up: the bar
      // leaves while transcripts are still uploading (ruling 11).
      await pushCloudSyncProgress(app, finishedSample());
      await expect(bar).toHaveCount(0, { timeout: STEP_BUDGET_MS });

      // Every frame from the sync's start through its exit stated the sync's
      // own counter, and it slid out on the finished one (ruling 15), never on
      // the parse's. Frames before the sync's first belong to the parse bar,
      // which the 1 s renderer poll can still be finishing when this starts.
      const recorded = await readStartupBarFrames(page);
      const syncStart = recorded.findIndex(
        (frame) => frame.counter === SYNC_COUNTER
      );
      expect(syncStart).toBeGreaterThanOrEqual(0);
      const frames = recorded.slice(syncStart);
      for (const frame of frames) {
        expect([SYNC_COUNTER, FINISHED_SYNC_COUNTER]).toContain(frame.counter);
      }
      const exitFrames = frames.filter((frame) => frame.exiting);
      expect(exitFrames.length).toBeGreaterThan(0);
      for (const frame of exitFrames) {
        expect(frame.counter).toBe(FINISHED_SYNC_COUNTER);
      }
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    for (const dir of [claudeHome, codexHome, userDataDir]) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }
});

/** The session lane mid-sync: 3 of 10 sessions delivered. */
function syncingSample(): E2eCloudSyncProgress {
  return {
    ...identifiedCloudSyncProgress(),
    backfilling: true,
    caughtUp: false,
    deliveredSessions: DELIVERED_SESSIONS,
    inFlightTotalSessions: IN_FLIGHT_TOTAL_SESSIONS,
    pendingBackfillSessions: IN_FLIGHT_TOTAL_SESSIONS - DELIVERED_SESSIONS,
  };
}

/** The same sync, every session delivered and the lane caught up. */
function finishedSample(): E2eCloudSyncProgress {
  return {
    ...identifiedCloudSyncProgress(),
    deliveredSessions: IN_FLIGHT_TOTAL_SESSIONS,
    inFlightTotalSessions: IN_FLIGHT_TOTAL_SESSIONS,
  };
}

/** Whether the real collector reports this launch's parsing as complete. */
async function readIngestComplete(page: Page): Promise<boolean> {
  const status = runtimeIngestSchema.parse(
    await page.evaluate(() => {
      const { desktopApi } = window as typeof window & {
        desktopApi: { getRuntimeStatus: () => Promise<unknown> };
      };
      return desktopApi.getRuntimeStatus();
    })
  );
  return status.ingest?.complete === true;
}

/** Every lane drained except the transcript archive, which still owes uploads. */
function transcriptsStillUploading(): CloudReadReadinessSnapshot {
  const drained = drainedCloudReadReadiness();
  return {
    ...drained,
    lanes: drained.lanes.map((lane) =>
      lane.lane === SyncLaneId.TranscriptArchive
        ? {
            ...lane,
            itemsRemaining: TRANSCRIPTS_STILL_UPLOADING,
            state: SyncLaneDrainState.Draining,
          }
        : lane
    ),
  };
}

/** Before the sync starts: the session lane has no cloud identity yet. */
function notSyncingYetSample(): E2eCloudSyncProgress {
  return { ...identifiedCloudSyncProgress(), identified: false };
}
