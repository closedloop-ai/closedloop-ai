import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { isolatedHarnessHomes } from "../../helpers/isolated-harness-homes";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  type LaunchOptions,
  launchDesktopApp,
} from "./desktop-app";
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
 * Extracted here in ISS-5579 rather than re-typed per spec. The former
 * shared-only column-fold duplicate was removed in ISS-10527; new consumers
 * should use this helper rather than copying the launch/seed sequence.
 *
 * Steps 1-3 are {@link withSeededSessionsProfile}, which every VARIANT of the
 * sandwich calls; step 4 and the ready-row check are the wrapper's, because that
 * is the half a variant surface legitimately disagrees about.
 */

/** The isolated HOME/user-data directories one seeded desktop run needs. */
export type SeededSessionsDirs = {
  claudeHome: string;
  codexHome: string;
  /** Root holding one throwaway home per collector (see {@link seededSessionsEnv}). */
  harnessHomesRoot: string;
  userDataDir: string;
};

/**
 * Fresh temp directories for one run.
 *
 * EVERY collector home must be isolated, not just Claude's and Codex's:
 * `launchDesktopApp` inherits `process.env`, so an unpinned `CURSOR_HOME`,
 * `COPILOT_HOME`, `COPILOT_VSCODE_STORAGE_DIR` or `OPENCODE_DATA_DIR` still
 * resolves under `os.homedir()` and the boot collectors ingest the OPERATOR'S
 * REAL agent history into the corpus a spec is about to assert against
 * (ISS-7697 — observed as a real Copilot row landing in a seeded Sessions
 * population). `harnessHomesRoot` is where those throwaway homes live.
 */
export function makeSeededSessionsDirs(prefix: string): SeededSessionsDirs {
  return {
    claudeHome: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-claude-`)),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`)),
    harnessHomesRoot: fs.mkdtempSync(
      path.join(os.tmpdir(), `${prefix}-homes-`)
    ),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`)),
  };
}

/**
 * The launch environment every seeded Sessions spec must use.
 *
 * The full isolated set, with `CLAUDE_HOME`/`CODEX_HOME` alongside the other
 * four rather than after them, so `extra` outranks ALL SIX uniformly. That is
 * `launchDesktopApp`'s own stated convention for this set — harness homes sit
 * below `options.env` precisely so a spec that deliberately seeds one still
 * wins (`historical-import-utility-worker.spec.ts`) — and pinning two of the six
 * last used to break it for exactly the two keys a seeded-corpus spec would
 * reach for, with nothing to say so. Nothing writes into `claudeHome` or
 * `codexHome`; like the other four they are empty homes that exist so a
 * collector cannot read the operator's real history.
 *
 * Callers MUST route through this rather than re-listing
 * `{ CLAUDE_HOME, CODEX_HOME }` at the call site — a hand-written pair is
 * exactly the shape ISS-7697 found leaking, and it passes on a machine that
 * happens to have no Cursor/Copilot/OpenCode history, so the omission is
 * invisible where it is introduced.
 */
export function seededSessionsEnv(
  dirs: SeededSessionsDirs,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...isolatedHarnessHomes(dirs.harnessHomesRoot),
    CLAUDE_HOME: dirs.claudeHome,
    CODEX_HOME: dirs.codexHome,
    ...extra,
  };
}

/**
 * Removes every directory {@link makeSeededSessionsDirs} created, including the
 * `harnessHomesRoot` tree {@link seededSessionsEnv} populates.
 */
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
  await withSeededSessionsProfile(dirs, { sessions }, async (page) => {
    await gotoNav(page, "sessions");
    await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
    await expect(
      page.getByRole("link", { name: sessions[0].name as string })
    ).toBeVisible({ timeout: 30_000 });

    await assertions(page);
  });
}

/**
 * The boot sandwich itself, with a SEAM between the seed and the relaunch.
 *
 * Owns launch-1/migrate/close, the corpus seed, the relaunch, the renderer
 * `pageError` assertion and teardown. `onReady` owns navigation, the ready-row
 * check and the caller's assertions — the half a variant surface genuinely
 * disagrees about (page-global versus panel-scoped, `gotoNav` versus
 * `gotoNavSettled`). `beforeRelaunch` runs with the app DOWN, the only moment a
 * profile write — a feature-flag seed, say — is both uncontended and still read
 * at the next boot.
 *
 * ISS-5579 extracted this sequence once and it was open-coded again anyway, so
 * what a variant needs is a parameter here rather than a reason to copy the
 * sandwich a third time. ISS-8198 adds the third and fourth OPTION here for
 * that same reason rather than a third copy: `env` for a spec that has to pin
 * `TZ` (a calendar-driven one must, or the clicked cell and the seeded month
 * disagree east or west of UTC), and `relaunch` for a spec that needs a
 * launch-time gate preload on the ASSERTING launch. Both default to nothing, so
 * every existing caller is byte-unchanged.
 *
 * `onReady` is handed the `ElectronApplication` beside the page because the
 * `pageData` gate is read through `ElectronApplication.evaluate` — there is no
 * HTTP on this path for `page.route` to observe, so the request record lives in
 * the MAIN process. A caller that ignores the second argument still typechecks.
 * It must not call `cleanup` — teardown stays this function's.
 */
export async function withSeededSessionsProfile(
  dirs: SeededSessionsDirs,
  options: {
    beforeRelaunch?: (userDataDir: string) => void | Promise<void>;
    /**
     * Layered over every isolated collector home by {@link seededSessionsEnv},
     * `CLAUDE_HOME` and `CODEX_HOME` included — a key passed here wins.
     */
    env?: Record<string, string>;
    /** Launch options for the ASSERTING launch only; launch 1 just migrates. */
    relaunch?: Pick<
      LaunchOptions,
      "sessionsPageDataGate" | "insightsReadFailureGate"
    >;
    sessions: SessionListSeed[];
  },
  onReady: (page: Page, app: ElectronApplication) => Promise<void>
): Promise<void> {
  const env = seededSessionsEnv(dirs, options.env);
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

  await seedSessionsList(dirs.userDataDir, options.sessions);
  await options.beforeRelaunch?.(dirs.userDataDir);

  const { app, page, pageErrors, cleanup } = await launchDesktopApp({
    ...options.relaunch,
    env,
    keepUserDataDir: true,
    userDataDir: dirs.userDataDir,
  });
  try {
    await onReady(page, app);
    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
}
