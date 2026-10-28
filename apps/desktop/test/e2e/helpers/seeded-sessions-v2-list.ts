/**
 * The seeded-corpus boot sandwich for a FLAG-ON desktop Sessions v2 spec.
 *
 * The sandwich itself is {@link withSeededSessionsProfile} — one definition,
 * shared with the v1 wrapper. What this adds is the v2 flavour: the flag seed
 * lands on that helper's `beforeRelaunch` seam (with the app DOWN, because
 * `seedDesktopFeatureFlags` writes into the same profile the second launch reads
 * at boot), and the ready check is panel-scoped and exact rather than
 * page-global. A v2 spec supplies its corpus, its flag set and its assertions
 * and nothing else.
 *
 * The flag RECORD stays the caller's: each spec pins `grid-table-v2` as its own
 * local literal (PLN-1952 AC-001), and passing it through here is also what lets
 * a spec be run once with the flag off to prove it fails without the pin.
 *
 * `@repo/*`-free because nothing here needs a shared symbol, not because the
 * directory is: sibling helpers and specs import `@repo/*` freely, but only in
 * the EXTENSION-QUALIFIED form (`…/session-status.ts`). It is the extension-LESS
 * subpath that does not resolve under Playwright's ESM loader
 * (`apps/desktop/test/AGENTS.md`), and a load-time import failure aborts the
 * WHOLE desktop-e2e suite with no failing test name to point at it.
 */

import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNavSettled,
  seedDesktopFeatureFlags,
} from "./desktop-app";
import type { SessionListSeed } from "./seed-branches-db";
import {
  type SeededSessionsDirs,
  withSeededSessionsProfile,
} from "./seeded-sessions-list";

/** The shell nav id the Sessions list is committed under. */
const SESSIONS_NAV_ID = "sessions";

/**
 * `GRID_TABLE_SCROLL_BAND_TEST_ID`, spelled here rather than imported: its home
 * (`packages/design-system/components/ui/grid-table-list-surface.tsx`) is a
 * component module, and pulling a React runtime through the spec loader is the
 * load-time abort this directory exists to avoid.
 */
export const SCROLL_BAND_TEST_ID = "grid-table-scroll-band";

/** How long a seeded corpus gets to travel SQLite → IPC → the rendered list. */
export const SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS = 30_000;

/**
 * Run `assertions` against the Sessions list showing `sessions`, with
 * `featureFlags` seeded into the profile the app boots from.
 *
 * The active nav PANEL is handed to the caller alongside the page, and every
 * list assertion should be scoped to it: keep-alive leaves Dashboard mounted,
 * and its Recent Sessions grid renders session links, `data-column-id` headers
 * and cost values of its own, so a page-global query on a Sessions surface tends
 * to resolve Dashboard's copy first (see `activeNavPanel`).
 *
 * `readyRowName` is matched EXACTLY, so a corpus whose row names share a prefix
 * (`… one` and `… one 2`) resolves to the one row rather than tripping strict
 * mode. It is asserted on screen before handing over, so a caller's own
 * assertions can never run against a grid that simply has not loaded.
 *
 * The AC-001 v2 barrier then runs unconditionally, before the caller is handed
 * the panel, because a spec cannot be trusted to remember it: forgetting it is
 * exactly how a pin that stopped taking reaches a caller's assertions and
 * quietly re-tests v1 through controls v1 does not have. Running it here still
 * proves the pin is load-bearing — a spec run with the flag OFF reddens on the
 * barrier, one frame earlier than it used to and for the same reason.
 *
 * `dateRangePreset` is the preset clicked before that ready check, defaulting to
 * All time so a seed's own date cannot decide whether the list is empty. Pass
 * `null` to LEAVE THE PRESET WHERE IT BOOTS — which a spec must do when the
 * value of `dateRange` is itself part of what it asserts, because the surface's
 * "Clear filters" patches the range back to `DEFAULT_DATE_RANGE` and a host that
 * was on a different one then strips the `?from=`/`?to=` window as a RANGE move,
 * independently of the contract under test (`resolveSessionsScopeDelta`).
 *
 * `sessionsPageDataGate` installs the main-process `pageData` recorder on the
 * asserting launch. It is INERT until a spec arms it; installing it only records
 * each invocation's query, which is how a spec reads the REQUEST rather than
 * only the label a control moved.
 *
 * `beforeRelaunch` is an extra profile write for the same app-down seam, awaited
 * after the flag seed — for a column `SessionListSeed` has no lever for (ISS-9431
 * seeds harness and model this way).
 */
export async function withSeededSessionsV2List(
  dirs: SeededSessionsDirs,
  options: {
    beforeRelaunch?: (userDataDir: string) => Promise<void>;
    dateRangePreset?: DesktopDateRangeLabel | null;
    env?: Record<string, string>;
    featureFlags: Record<string, boolean>;
    readyRowName: string;
    sessionsPageDataGate?: boolean;
    sessions: SessionListSeed[];
  },
  assertions: (
    page: Page,
    panel: Locator,
    app: ElectronApplication
  ) => Promise<void>
): Promise<void> {
  const dateRangePreset =
    options.dateRangePreset === undefined
      ? DesktopDateRangeLabel.AllTime
      : options.dateRangePreset;
  await withSeededSessionsProfile(
    dirs,
    {
      // The real flag resolution reads this assignment at the next boot, so it
      // has to be written on the seam — with the app down, before launch 2.
      beforeRelaunch: async (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, options.featureFlags);
        await options.beforeRelaunch?.(userDataDir);
      },
      env: options.env,
      relaunch: { sessionsPageDataGate: options.sessionsPageDataGate },
      sessions: options.sessions,
    },
    async (page, app) => {
      const panel = await gotoNavSettled(page, SESSIONS_NAV_ID);
      // Widen the window filter so the seeded rows are in range independent of
      // the run clock.
      if (dateRangePreset !== null) {
        await clickDesktopDateRange(page, dateRangePreset);
      }
      await expect(
        panel.getByRole("link", { exact: true, name: options.readyRowName })
      ).toBeVisible({ timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS });
      await expectGridTableV2Mounted(panel);

      await assertions(page, panel, app);
    }
  );
}

/**
 * The AC-001 barrier, run by {@link withSeededSessionsV2List} on every caller's
 * behalf rather than left to each spec to remember.
 *
 * Both anchors are v2-only — the v1 listing renders no `GridTableListSurface`
 * band and no ARIA `grid` — so a flag pin that stopped taking reddens here,
 * before a spec can drive v1 through controls it believes are v2.
 *
 * Exported for the one thing the setup call cannot cover: a spec that leaves the
 * list and comes back — a detail route and the back nav — remounts the surface,
 * and re-asserting it there is a claim about the RETURN, not about the boot. A
 * spec that only reads the settled first page does not need to call this.
 */
export async function expectGridTableV2Mounted(panel: Locator): Promise<void> {
  await expect(panel.getByTestId(SCROLL_BAND_TEST_ID)).toBeVisible({
    timeout: SEEDED_SESSIONS_V2_MOUNT_TIMEOUT_MS,
  });
  await expect(panel.getByRole("grid").first()).toBeVisible();
}

/**
 * `GRID_TABLE_PAGINATION_BAND_TEST_ID`, spelled for the same reason as
 * {@link SCROLL_BAND_TEST_ID} — its home is a component module — and spelled
 * ONCE for the v2 family rather than per spec, so the three specs that address
 * the footer band cannot drift apart from each other.
 */
export const PAGINATION_BAND_TEST_ID = "grid-table-pagination-band";

/**
 * The `PaginationLink` for the page the pager is on, inside that band.
 *
 * By ATTRIBUTE rather than role: it renders as an `<a>` with no `href`, which
 * carries no ARIA role and is therefore unreachable through `getByRole("link")`.
 */
export const CURRENT_PAGE_SELECTOR =
  '[data-slot="pagination-link"][aria-current="page"]';

/**
 * The `PaginationNext` control, inside that band.
 *
 * By ATTRIBUTE for the same reason as {@link CURRENT_PAGE_SELECTOR}, and here
 * for the same reason as {@link PAGINATION_BAND_TEST_ID}: it is the third
 * footer literal the v2 specs share, and two of them turning the page through
 * their own copy is how they drift apart.
 */
export const NEXT_PAGE_SELECTOR = '[aria-label="Go to next page"]';

/**
 * A header cell addressed by COLUMN ID rather than accessible name, scoped to the
 * committed Sessions panel.
 *
 * Keep-alive leaves Dashboard mounted, and its Recent Sessions grid renders
 * `data-column-id` headers of its own — unscoped, a `toHaveCount(0)` here could
 * never reach zero and a `toBeVisible()` could pass against the wrong grid. By
 * ID rather than by label because the id does not depend on the header's
 * accessible name, which before ISS-11837 folded in the column-options button's
 * name, so an absence assertion written against the label could not fail
 * (ISS-6065).
 */
export function columnHeaderById(panel: Locator, columnId: string): Locator {
  return panel.locator(`[role="columnheader"][data-column-id="${columnId}"]`);
}
