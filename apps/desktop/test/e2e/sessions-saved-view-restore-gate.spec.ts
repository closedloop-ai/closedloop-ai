/**
 * ISS-6382 (whitlockk review, PR #5481): the Electron twin of
 * `e2e/sessions-saved-view-restore-gate.spec.ts`. The desktop Sessions list's
 * FIRST read must go out under the viewer's SAVED sort, and the window it waits
 * in must render as loading, never as an empty account.
 *
 * The saved view is restored from `localStorage` in a POST-MOUNT effect and
 * `sortBy`/`sortDir` are in the combined `pageData` query key, so a view that
 * read on its first commit paginated the corpus once under the default order and
 * again under the restored one — the first run wasted and unrecoverable. And
 * because a query held closed by the gate reports `isLoading: false` with no
 * rows, the pre-fix derivation fell through to the honest-empty surface and
 * showed the connect-an-agent onboarding CTA over an account with sessions.
 *
 * Driven through the LAUNCHED app per `apps/desktop/AGENTS.md` ("UI bug fix ⇒
 * regression e2e", "cross-surface work covers both adapters"): the real Electron
 * shell, the real `pageData` IPC handler and its real list read off a seeded
 * store, the real persisted-view restore, and the real mounted `SessionsView`.
 * The gate preload supplies only the two things a spec cannot otherwise reach on
 * this path — the RESPONSE TIMING, and a record of the request itself, since
 * there is no HTTP here for `page.route` to observe.
 *
 * WHAT THIS DOES AND DOES NOT DISCRIMINATE, measured rather than assumed.
 * Removing `isViewReady` from this view's read gate does NOT turn this spec red:
 * desktop gates on `canReadSessions && isViewReady`, and the local-source probe
 * behind `canReadSessions` already resolves after the restore effect in this
 * harness, so the request carries the saved sort either way. What it does pin —
 * verified by seeding a bogus saved-view key, which turns it red — is the
 * user-visible contract this ticket is about: the first Sessions render under a
 * saved view is ordered by that view and reads as loading, never as an empty
 * account. The `isViewReady` conjunct in isolation is pinned by
 * `src/renderer/components/sessions/__tests__/sessions-view-empty-states.test.tsx`,
 * which can hold the gate closed directly. Do not upgrade this docstring to
 * claim the conjunct.
 *
 * ISS-8262 (whitlockk review, PR #6123) adds a SECOND thing this spec does not
 * discriminate, for the same structural reason. The deadline fallback in
 * `usePersistedTableViewState` (`restoreStorageKey`) only changes behavior when
 * auth is STILL unresolved after `VIEW_RESTORE_AUTH_DEADLINE_MS`, and nothing
 * here holds `desktop:get-desktop-auth-state` that long: this profile's bridge
 * settles as signed out promptly, `storageKey` resolves to the legacy key on its
 * own, and the read below carries the saved sort with or without the fallback.
 * Drop `restoreStorageKey` and this spec stays green. What it DOES pin is the
 * plant-ordering fix below — the race that made it eject from the merge queue.
 * The deadline fallback is discriminated by
 * `src/renderer/components/sessions/__tests__/sessions-view-saved-view-auth-deadline.test.tsx`,
 * which holds the shared auth port unresolved and asserts the first `pageData`
 * request's sort, and by the hook unit suite
 * (`packages/app/shared/hooks/__tests__/use-persisted-table-view-state.test.tsx`).
 * A launched-Electron twin that holds the auth IPC past the deadline is ISS-8288.
 * It needs a main-process gate that ALSO suppresses the startup auth PUSH
 * (`desktop:auth-state-changed`): that send has no queue and no republish on
 * renderer-ready, so a pull-only delay would sometimes be settled early by it
 * and pass for the wrong reason.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, test } from "@playwright/test";
import { SESSIONS_LIST_LOADING_LABEL } from "@repo/app/agents/components/sessions/sessions-list-loading-labels.ts";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";
import {
  holdPageDataReads,
  readPageDataFilters,
  resumePageDataReads,
} from "./helpers/sessions-page-data-gate";

const SEEDED_SESSION_NAME = "iss-6382 restore gate session";

/**
 * This surface's saved-view key: `keyPrefix` (`"sessions:saved-view:"`) plus the
 * desktop persist key (`"sessions:desktop"`). Un-namespaced because every E2E
 * profile is SIGNED OUT, which is exactly the case the shared hook resolves to
 * the legacy un-namespaced key (a signed-in profile would read
 * `…:u:<userId>` and fall back to this one).
 */
const SAVED_VIEW_STORAGE_KEY = "sessions:saved-view:sessions:desktop";

/**
 * `started` / `desc` deliberately. The default view is `lastActivity` / `desc`
 * (`useSessionsViewState`), so a pre-restore read is distinguishable on the KEY
 * — measured, not assumed: seeding a bogus storage key makes the assertion below
 * report `lastActivity`. Newest-first also keeps the just-seeded row on page one
 * no matter what the boot collectors found, since `~/.copilot` history is not
 * isolated by this harness.
 */
const SAVED_VIEW = {
  columnOrder: [],
  hiddenColumns: [],
  sortDir: "desc",
  sortKey: "started",
} as const;

/** `getSessionsTableLoadingLabel` — what the body says while a read is pending. */
const LOADING_LABEL = SESSIONS_LIST_LOADING_LABEL;

/** `SessionsEmptyState`'s genuinely-empty onboarding title. */
const ONBOARDING_EMPTY_TITLE = "No sessions yet";

test("the desktop Sessions list's first read uses the saved view, and the wait renders as loading, not empty", async () => {
  test.setTimeout(300_000);

  const dirs = makeSeededSessionsDirs("desktop-restore-gate");
  const env = seededSessionsEnv(dirs);

  try {
    // Launch 1 — create + migrate the SQLite schema AND plant the saved view,
    // then close. The app must be DOWN to seed the store: a running app does not
    // observe another process's writes.
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
      // ISS-8262: the saved view is planted HERE, in the launch that is about to
      // close, and not in the asserting launch below.
      //
      // It used to be written after that launch returned, under a comment
      // claiming the app boots on the dashboard so `SessionsView` had not
      // mounted yet. That claim is false — the app boots on `#/sessions`, which
      // also makes the `gotoNav` below a no-op — so the plant landed on a
      // surface that had ALREADY run its restore against this very key and found
      // it empty. The restore does not re-run for an unchanged key, so the spec
      // only ever passed on a SECOND restore pass it does not control: the one
      // triggered when auth hydrates and `storageKey` flips null → legacy. Win
      // that race and the read goes out under the default sort. That is a
      // structural defect in the spec, independent of the product bug this
      // change fixes, and it is why this spec ejects from the merge queue.
      //
      // `--user-data-dir` is kept across both launches, so Local Storage written
      // here is on disk before the asserting launch's renderer runs a single
      // script. If the write did not survive, the assertion below fails loudly
      // on the default sort rather than passing for the wrong reason.
      await first.page.evaluate(
        ({ key, value }) => {
          globalThis.localStorage.setItem(key, JSON.stringify(value));
        },
        { key: SAVED_VIEW_STORAGE_KEY, value: SAVED_VIEW }
      );
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(dirs.userDataDir, [
      { sessionId: "iss-6382-restore-gate", name: SEEDED_SESSION_NAME },
    ]);

    const app = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      sessionsPageDataGate: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      // The saved view is already on disk (planted in launch 1), so this is a
      // returning user's launch: the view is in force from the surface's very
      // first mount, with no restore pass left to race.
      //
      // Hold every `pageData` response so the window this spec asserts on is a
      // stable blocking state rather than a race against a fast local read. This
      // holds the RESPONSE only — the request is dispatched and recorded, which
      // is what the saved-view assertion below reads.
      await holdPageDataReads(app.app);

      // A no-op when the app already booted on `#/sessions` (it does today);
      // kept so the spec still lands on this surface if that default moves.
      await gotoNav(app.page, "sessions");

      // What the surface shows while the read is in flight. The onboarding CTA is
      // what the pre-fix derivation rendered here, because a query with nothing in
      // flight reports `isLoading: false` with no rows.
      await expect(
        app.page.getByText(LOADING_LABEL, { exact: true }).first()
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        app.page.getByText(ONBOARDING_EMPTY_TITLE, { exact: true })
      ).toHaveCount(0);

      await resumePageDataReads(app.app);
      await expect(
        app.page.getByRole("link", { name: SEEDED_SESSION_NAME, exact: true })
      ).toBeVisible({ timeout: 60_000 });

      // The heart of it: not one read went out under the default order. A
      // pre-restore read carries NO `sortBy` at all, so a single entry missing it
      // is the wasted first pagination the gate exists to prevent.
      const filters = await readPageDataFilters(app.app);
      expect(filters.length).toBeGreaterThan(0);
      for (const filter of filters) {
        expect(filter.sortBy).toBe(SAVED_VIEW.sortKey);
        expect(filter.sortDir).toBe(SAVED_VIEW.sortDir);
      }
      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});
