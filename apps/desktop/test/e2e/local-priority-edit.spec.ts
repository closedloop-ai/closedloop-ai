/**
 * E2E (ISS-10332 / PLN-2086 Milestone 3): a priority edit in LOCAL mode travels
 * the whole chain — cell editor → local data source `updatePriority` → preload
 * bridge → `desktop:db:*` IPC → db-host store op → SQLite — and the list reads
 * it back.
 *
 * The unit suites fake the store-op dispatch, which is how a build whose every
 * local priority write failed passed all of them. This drives the launched app
 * instead, for both surfaces that mount the editor over the local store:
 *   1. a seeded row renders its stored priority in the Priority cell,
 *   2. the real `ArtifactPriorityEditor` menu sets a new one,
 *   3. the row re-renders it and the store holds it, and
 *   4. after a renderer reload (no query cache survives it) the row still
 *      renders it, read back from SQLite.
 *
 * The launch is signed out, so both surfaces read the local store. Rows are
 * seeded with the app DOWN, the same way `sessions-list-dbseed.spec.ts` and
 * `branches-no-pr-artifact.spec.ts` seed theirs.
 *
 * Labels come from `@closedloop-ai/design-system/lib/priority-order`, the map the cell
 * mark and the menu both render. The `@repo/app` modules that wrap it for the
 * editor (`priority-constants`, `artifact-field-menus`) are not imported here:
 * they reach extension-less `@repo/*` subpaths that resolve only through the
 * renderer's vite alias, so the trigger's accessible name is not asserted.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRIORITY_LABELS } from "@closedloop-ai/design-system/lib/priority-order.ts";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Priority } from "@repo/api/src/types/common.ts";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  openSeedClient,
} from "./helpers/desktop-seed-core";
import {
  seedNoPullRequestBranch,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEEDED_PRIORITY = Priority.Low;
const EDITED_PRIORITY = Priority.High;

const SESSION_SEED = {
  sessionId: "iss-10332-local-priority-session",
  name: "iss-10332 local priority session",
} as const;

const BRANCH_SEED = {
  repoFullName: "acme/priority-local",
  branchName: "iss-10332-local-priority-branch",
  sessionId: "iss-10332-local-priority-branch-session",
} as const;

/** `ArtifactPriority`'s documented hook: every painted priority sits in one. */
const PRIORITY_MARK_SELECTOR = '[data-slot="artifact-priority"]';
const WRITE_SETTLE_TIMEOUT_MS = 15_000;

test.describe("Local priority edit (ISS-10332, launched Desktop)", () => {
  test("Sessions: a local row's priority edit reaches SQLite and survives a reload", async () => {
    test.setTimeout(180_000);
    await withSeededLocalStore(
      "sessions",
      async (userDataDir) => {
        await seedSessionsList(userDataDir, [SESSION_SEED]);
        await runSql(
          userDataDir,
          "UPDATE sessions SET priority = ? WHERE id = ?",
          [SEEDED_PRIORITY, SESSION_SEED.sessionId]
        );
      },
      async (page, userDataDir) => {
        await gotoNav(page, "sessions");
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
        const row = () =>
          visibleRowWith(
            page,
            page.getByRole("link", { name: SESSION_SEED.name, exact: true })
          );

        await editPriorityAndReadBack(page, row, () =>
          readSingleValue(
            userDataDir,
            "SELECT priority AS value FROM sessions WHERE id = ?",
            [SESSION_SEED.sessionId]
          )
        );
      }
    );
  });

  test("Branches: a local row's priority edit reaches SQLite and survives a reload", async () => {
    test.setTimeout(180_000);
    await withSeededLocalStore(
      "branches",
      async (userDataDir) => {
        await seedNoPullRequestBranch(userDataDir, {
          ...BRANCH_SEED,
          activityAt: new Date().toISOString(),
        });
        await runSql(
          userDataDir,
          "UPDATE artifacts SET priority = ? WHERE kind = 'branch' AND branch_name = ?",
          [SEEDED_PRIORITY, BRANCH_SEED.branchName]
        );
      },
      async (page, userDataDir) => {
        await gotoNav(page, "branches");
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
        const row = () =>
          visibleRowWith(
            page,
            page
              .locator('a[href^="#/branches/"]')
              .filter({ hasText: BRANCH_SEED.branchName })
          );

        await editPriorityAndReadBack(page, row, () =>
          readSingleValue(
            userDataDir,
            "SELECT priority AS value FROM artifacts WHERE kind = 'branch' AND branch_name = ?",
            [BRANCH_SEED.branchName]
          )
        );
      }
    );
  });
});

/**
 * Launch once to migrate the store, seed with the app down, relaunch signed out
 * (so the local data sources are the ones mounted), and hand the page over.
 */
async function withSeededLocalStore(
  prefix: string,
  seed: (userDataDir: string) => Promise<void>,
  drive: (page: Page, userDataDir: string) => Promise<void>
): Promise<void> {
  const tmp = (label: string) =>
    fs.mkdtempSync(
      path.join(os.tmpdir(), `desktop-local-priority-${prefix}-${label}-`)
    );
  // Empty CLAUDE_HOME/CODEX_HOME: the collectors ingest nothing, so the seeded
  // rows are the whole corpus.
  const claudeHome = tmp("claude");
  const codexHome = tmp("codex");
  const userDataDir = tmp("udd");
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };
  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seed(userDataDir);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await drive(page, userDataDir);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

/**
 * The shell keeps a visited route mounted but hidden, so a row is resolved
 * among the VISIBLE rows only.
 */
function visibleRowWith(page: Page, anchor: Locator): Locator {
  return page
    .getByRole("row")
    .filter({ visible: true })
    .filter({ has: anchor });
}

async function editPriorityAndReadBack(
  page: Page,
  row: () => Locator,
  readStored: () => Promise<unknown>
): Promise<void> {
  const mark = () => row().locator(PRIORITY_MARK_SELECTOR);

  // The seeded value renders through the local read.
  await expect(mark()).toHaveText(PRIORITY_LABELS[SEEDED_PRIORITY], {
    timeout: 30_000,
  });

  // The editor trigger is the button wrapping the mark; it opens a menu.
  const trigger = row()
    .getByRole("button")
    .filter({ has: page.locator(PRIORITY_MARK_SELECTOR) });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await trigger.click();
  await page
    .getByRole("menuitem", { name: PRIORITY_LABELS[EDITED_PRIORITY] })
    .click();

  await expect(mark()).toHaveText(PRIORITY_LABELS[EDITED_PRIORITY]);
  // The row can show the optimistic value before the write settles; the store
  // is what says it committed rather than rolled back.
  await expect
    .poll(readStored, { timeout: WRITE_SETTLE_TIMEOUT_MS })
    .toBe(EDITED_PRIORITY);
  await expect(mark()).toHaveText(PRIORITY_LABELS[EDITED_PRIORITY]);

  // A reload drops every renderer cache, so this read comes from the store.
  await page.reload();
  await expect(mark()).toHaveText(PRIORITY_LABELS[EDITED_PRIORITY], {
    timeout: 30_000,
  });
}

async function runSql(
  userDataDir: string,
  sql: string,
  args: string[]
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    const result = await client.execute({ sql, args });
    expect(result.rowsAffected).toBeGreaterThan(0);
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/** A cross-process read of the running app's committed store. */
async function readSingleValue(
  userDataDir: string,
  sql: string,
  args: string[]
): Promise<unknown> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopBusyTimeout(client);
    const result = await client.execute({ sql, args });
    return result.rows[0]?.value ?? null;
  } finally {
    client.close();
  }
}
