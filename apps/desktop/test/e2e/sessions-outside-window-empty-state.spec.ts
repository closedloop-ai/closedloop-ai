/**
 * ISS-11913: a machine whose sessions all predate the default 7d window.
 *
 * The onboarding run behind this ticket had 36 analyzed sessions, all older
 * than seven days, and Sessions opened on the default 7d range saying "No
 * sessions yet". This seeds one finished session from 20 days ago — inside the
 * 90-day retention sweep, outside the default window — straight into the store
 * (the `sessions-list-dbseed` recipe: launch to migrate, seed while the app is
 * down, relaunch), and drives the empty state a reader actually meets.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import { gotoNavSettled, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const OLDER_SESSION_NAME = "Older than the default window";

const DATE_RANGE_EMPTY_COPY =
  "No sessions were active in the selected date range.";

// Mirror of `MY_TASKS_RECENCY_SHOW_ALL_LABEL`
// (`@repo/app/my-tasks/lib/my-tasks-recency-window`): renderer modules resolve
// only through the renderer's vite alias, not this spec's Node runtime (see the
// note atop `sessions-list-dbseed.spec.ts`).
const SHOW_ALL_TIME = "Show all time";

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("Sessions outside the default window (ISS-11913)", () => {
  test("offers Show all time, and widening shows the older session", async () => {
    test.setTimeout(180_000);
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY_MS).toISOString();

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-outside-window-claude-")
    );
    // Isolated like CLAUDE_HOME, so the boot collectors ingest nothing and the
    // seeded row is the whole corpus.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-outside-window-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-outside-window-udd-")
    );

    try {
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

      await seedSessionsList(userDataDir, [
        {
          at: twentyDaysAgo,
          lastActivityAt: twentyDaysAgo,
          name: OLDER_SESSION_NAME,
          sessionId: "iss11913-older-session",
          status: SESSION_STATUS.INACTIVE,
        },
      ]);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        const sessions = await gotoNavSettled(page, "sessions");

        await expect(sessions.getByText(DATE_RANGE_EMPTY_COPY)).toBeVisible({
          timeout: 30_000,
        });

        await sessions
          .getByRole("button", { exact: true, name: SHOW_ALL_TIME })
          .click();
        await expect(
          sessions.getByRole("link", { name: OLDER_SESSION_NAME })
        ).toBeVisible({ timeout: 30_000 });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
