import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./seed-branches-db";

/**
 * The "seed sandwich" every seeded desktop Sessions e2e spec performs:
 *
 *  1. launch the app once so it creates and migrates the SQLite schema;
 *  2. close it and seed with the app DOWN — a running app does not observe
 *     another process's writes to its own store;
 *  3. relaunch, so the real Sessions IPC read projects the seeded corpus;
 *  4. navigate to Sessions and widen the time window, because a seeded corpus
 *     dated outside the default window renders an empty cohort and every
 *     downstream assertion is then measured against a list that is empty for
 *     the wrong reason.
 *
 * Extracted here (ISS-5579) rather than re-typed per spec: the identical
 * sequence is currently open-coded as a file-local `withSeededSessions` in
 * `sessions-row-qualifiers-column.spec.ts` and again in
 * `sessions-column-fold.spec.ts`. Those two are deliberately left alone in this
 * change — they are green and migrating them is unrelated churn — but new specs
 * should call this, and those two should move onto it as a follow-up so the
 * sequence has one definition.
 */

/** The isolated HOME/user-data directories one seeded desktop run needs. */
export type SeededSessionsDirs = {
  claudeHome: string;
  codexHome: string;
  userDataDir: string;
};

/**
 * Fresh temp directories for one run.
 *
 * `CLAUDE_HOME` and `CODEX_HOME` MUST be isolated: without them the boot
 * collectors ingest the operator's real agent history into the test corpus.
 */
export function makeSeededSessionsDirs(prefix: string): SeededSessionsDirs {
  return {
    claudeHome: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-claude-`)),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`)),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`)),
  };
}

/** Removes every directory {@link makeSeededSessionsDirs} created. */
export function cleanupSeededSessionsDirs(dirs: SeededSessionsDirs) {
  for (const dir of Object.values(dirs)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Runs `assertions` against a Sessions list showing `sessions`.
 *
 * Asserts the first seeded row is on screen before handing over, so a spec's
 * own assertions can never run against a grid that simply has not loaded, and
 * asserts no renderer `pageError` fired before returning.
 */
export async function withSeededSessionsList(
  dirs: SeededSessionsDirs,
  sessions: SessionListSeed[],
  assertions: (
    page: Awaited<ReturnType<typeof launchDesktopApp>>["page"]
  ) => Promise<void>
) {
  const env = { CLAUDE_HOME: dirs.claudeHome, CODEX_HOME: dirs.codexHome };
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

  await seedSessionsList(dirs.userDataDir, sessions);

  const { page, pageErrors, cleanup } = await launchDesktopApp({
    env,
    keepUserDataDir: true,
    userDataDir: dirs.userDataDir,
  });
  try {
    await gotoNav(page, "sessions");
    await page.locator('[aria-label="All time"]:visible').click();
    await expect(
      page.getByRole("link", { name: sessions[0].name as string })
    ).toBeVisible({ timeout: 30_000 });

    await assertions(page);
    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
}
