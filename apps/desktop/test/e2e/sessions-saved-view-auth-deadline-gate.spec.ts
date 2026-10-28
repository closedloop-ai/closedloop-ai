/**
 * ISS-8288 (whitlockk review, PR #6123): the launched-Electron twin of
 * `src/renderer/components/sessions/__tests__/sessions-view-saved-view-auth-deadline.test.tsx`.
 *
 * THE CONTRACT. When the desktop auth bridge never resolves, the Sessions
 * list's FIRST read must still carry the viewer's SAVED sort — not the default
 * one. That is the `restoreStorageKey` deadline fallback in
 * `usePersistedTableViewState` (`@repo/app/shared/hooks/use-table-view-storage-key`),
 * which diverges from `storageKey` only once `authLoaded` is STILL false after
 * `VIEW_RESTORE_AUTH_DEADLINE_MS`.
 *
 * WHY THIS SPEC EXISTS AND ITS SIBLING CANNOT SERVE.
 * `sessions-saved-view-restore-gate.spec.ts` pins the plant-ordering fix and
 * says so plainly: nothing there delays `desktop:get-desktop-auth-state`, so
 * that profile's bridge settles as signed out promptly, `storageKey` resolves to
 * the legacy key on its own, and its read carries the saved sort with or without
 * the fallback. Drop `restoreStorageKey` and it stays green. This spec is the
 * one that turns red — measured, not assumed; see the counterfactual note below.
 *
 * WHY THE GATE COVERS TWO CHANNELS. `createDesktopAuthStore` mirrors main's auth
 * state with an initial PULL plus a PUSH subscription. The renderer lifecycle
 * policy drops a startup push issued before navigation readiness, while the E2E
 * gate suppresses one issued after readiness. Holding the pull and suppressing
 * any late push keeps the store on its LOADING snapshot under either ordering.
 * See `desktop-auth-state-gate-preload.cjs`.
 *
 * NO SLEEP ANYWHERE. The deadline elapsing is the BEHAVIOR under test, so this
 * waits on the observable consequence — the first `pageData` request being
 * recorded — and never on elapsed time. The hold is released on that signal.
 * Under a held bridge the read gate can only open via the deadline, so a
 * recorded request IS the deadline having fired.
 *
 * COUNTERFACTUAL (ISS-8288's own requirement): revert `restoreStorageKey` to
 * `storageKey` in `use-table-view-storage-key.ts` and this spec fails on the
 * first recorded request's `sortBy`, reporting `lastActivity` where `started` is
 * required.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  probeAuthPushSuppression,
  readAuthPullsHeld,
  releaseDesktopAuthState,
} from "./helpers/desktop-auth-state-gate";
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

const SEEDED_SESSION_NAME = "iss-8288 auth deadline session";

/**
 * This surface's saved-view key: `keyPrefix` (`"sessions:saved-view:"`) plus the
 * desktop persist key (`"sessions:desktop"`) — the legacy un-namespaced spelling,
 * which is exactly the key the deadline fallback reads when auth never names a
 * user.
 */
const SAVED_VIEW_STORAGE_KEY = "sessions:saved-view:sessions:desktop";

/**
 * `started` / `desc` deliberately. The default view is `lastActivity` / `desc`
 * (`useSessionsViewState`), so a read issued on the DEFAULTS is distinguishable
 * on the sort KEY rather than only on its absence — which is what makes the
 * counterfactual above report a wrong value instead of a missing one.
 */
const SAVED_VIEW = {
  columnOrder: [],
  hiddenColumns: [],
  sortDir: "desc",
  sortKey: "started",
} as const;

/** Ceiling for the held-auth deadline to open the read gate and a read to land. */
const FIRST_READ_TIMEOUT_MS = 60_000;

test("the desktop Sessions list reads under the saved view when the auth bridge never resolves", async () => {
  test.setTimeout(300_000);

  const dirs = makeSeededSessionsDirs("desktop-auth-deadline-gate");
  const env = seededSessionsEnv(dirs);

  try {
    // Launch 1 — NO auth gate. Creates and migrates the SQLite schema and plants
    // the saved view, then closes. The app must be DOWN to seed the store: a
    // running app does not observe another process's writes.
    //
    // Nothing on this path waits on auth any more: the shell mounts on the
    // renderer's first frame whatever the auth bridge says (ISS-10855), and the
    // launcher's returning-install seed keeps the guided takeover off both
    // launches. So launch 2 mounts Sessions under the held bridge for the reason
    // every launch does, not because launch 1 answered anything.
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
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
      { sessionId: "iss-8288-auth-deadline", name: SEEDED_SESSION_NAME },
    ]);

    const app = await launchDesktopApp({
      desktopAuthStateGate: true,
      env,
      keepUserDataDir: true,
      sessionsPageDataGate: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      // Hold every `pageData` RESPONSE. The request is still dispatched and
      // recorded — which is what this spec reads — and holding the response
      // keeps the surface in a stable in-flight state rather than racing a fast
      // local read.
      await holdPageDataReads(app.app);

      // Land on the surface under test. Dashboard is the shell's canonical
      // first-mounted view, so this is a real navigation and not a no-op —
      // dropping it leaves `SessionsView` unmounted and no read is ever issued.
      await gotoNav(app.page, "sessions");

      // THE SYNCHRONIZATION, and not a timing assertion: wait for the first
      // `pageData` request to be RECORDED. Under a held auth bridge the read
      // gate has exactly one way to open — the deadline — so a recorded request
      // is the deadline having fired, observed rather than slept through.
      await expect
        .poll(async () => (await readPageDataFilters(app.app)).length, {
          message:
            "the held-auth deadline should open the read gate and issue a Sessions read",
          timeout: FIRST_READ_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);

      // The gate's proof of effect. Without this the assertion below could pass
      // on a bridge that simply resolved normally — the exact false green this
      // ticket exists to close — so the hold is asserted, not assumed.
      expect(
        await readAuthPullsHeld(app.app),
        "the auth-state pull must have been parked by the gate"
      ).toBeGreaterThan(0);

      // Startup auth now normally publishes before renderer navigation
      // readiness, where the lifecycle policy drops it. Probe the E2E gate
      // directly so a future late startup push still cannot settle this hold.
      expect(
        await probeAuthPushSuppression(app.app),
        "the auth-state push gate must cover a post-readiness send"
      ).toBeGreaterThan(0);

      // THE HEART OF IT. Every read the surface issued while auth was unresolved
      // carried the SAVED sort. A read on the defaults reports `lastActivity`
      // here, which is what reverting `restoreStorageKey` produces.
      const filters = await readPageDataFilters(app.app);
      for (const filter of filters) {
        expect(filter.sortBy).toBe(SAVED_VIEW.sortKey);
        expect(filter.sortDir).toBe(SAVED_VIEW.sortDir);
      }

      // Let auth resolve and the held reads answer, then prove the surface
      // recovers rather than being wedged by the gate — a spec that left the app
      // stuck would not be evidence about the shipped product.
      await releaseDesktopAuthState(app.app);
      await resumePageDataReads(app.app);
      await expect(
        app.page.getByRole("link", { name: SEEDED_SESSION_NAME, exact: true })
      ).toBeVisible({ timeout: FIRST_READ_TIMEOUT_MS });

      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});
