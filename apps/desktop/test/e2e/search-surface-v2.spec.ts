/**
 * ISS-9414: the DESKTOP ⌘K palette reaches `SearchSurfaceV2` through the
 * shipped shell when `portable-search-surface` is on, and keeps its own
 * `DocsCommandGroup` when it is off.
 *
 * The renderer suite drives `CommandPalette` directly, which cannot answer
 * whether the surface branch is REACHABLE from `App.tsx` or merely exported.
 * Here the real ⌘K listener, the real `CommandDialog`, the real PostHog
 * assignment resolution and the real Labs composition all run.
 *
 * Both flag states are launched from the same profile shape, because "the
 * surface renders" is only half the claim: a shell that mounted it
 * unconditionally would satisfy the ON case alone. Each case is anchored on the
 * palette INPUT being visible first, so the surface's presence or absence is
 * the branch rendering rather than a palette that never opened.
 *
 * THE LOCATOR IS THE POINT. Both branches render "Type to search the
 * documentation." — the surface deliberately keeps the palette's own copy — so
 * an assertion on that copy passes either way. The ON case is pinned on the
 * surface's root test id and the OFF case on the `cmdk` empty slot that only
 * the legacy branch emits.
 *
 * TWO GATES, NOT A PAIR. `docsHelp` ANDed with `labsNav` decides whether the
 * docs CORPUS is reachable on this build at all; ISS-9414 neither adds nor
 * removes it, and seeds both ON so the palette exists to be tested. The new
 * PostHog key decides only WHICH component renders that corpus. No Labs toggle
 * was added for it (operator directive 2026-08-30).
 *
 * ISS-7493 also lands here, as the third case below. It is a different subject
 * — whether the ⌘K listener survives a synthetic keydown carrying no usable
 * `key` — but it needs the same shipped-shell launch and the same two corpus
 * gates this file already wires, and the Labs key those need is restated in
 * this file and nowhere else it could be reached from (see below). A fourth
 * restatement in a new spec was the alternative.
 *
 * The surface test id is pinned as a literal rather than imported: an
 * EXTENSION-LESS `@repo/app/...` subpath does not resolve under Playwright's ESM
 * loader and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load, while `@repo/api/src/types/*.ts` resolves. So the flag key comes from its
 * canonical module and only the `@repo/app` literal is restated; its drift is
 * caught by `search-surface-mount.test.tsx`, which imports it for real. Web twin:
 * `e2e/search-surface-v2.spec.ts`.
 *
 * ISS-10366 narrowed that rule: written WITH its extension, a `@repo/app` subpath
 * resolves too, so a React-free leaf module there can be imported outright — see
 * `DOCS_HELP_SEARCH_FAILED_TITLE` below. It is the component graph behind a
 * `.tsx`, not the `@repo/app` prefix, that keeps the rest restated.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run with a fresh CODEX_HOME:
 *     `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- search-surface-v2.spec.ts`
 */

import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { PORTABLE_SEARCH_SURFACE_FLAG_KEY } from "@repo/api/src/types/portable-search-surface-flag.ts";
import { DOCS_HELP_SEARCH_FAILED_TITLE } from "@repo/app/help/lib/docs-help-labels.ts";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../src/shared/desktop-docs-help-flag";
import {
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  armDocsHelpFailure,
  DocsHelpFailureOperation,
  disarmDocsHelpFailure,
  readDocsHelpFailureGateStats,
} from "./helpers/docs-help-failure-gate";

// `SEARCH_SURFACE_V2_TEST_ID`.
const SURFACE_TEST_ID = "search-surface-v2";

/**
 * `DESKTOP_LABS_NAV_FEATURE_FLAG_KEY`, restated rather than imported.
 *
 * Its canonical module, `apps/desktop/src/shared/feature-flags-labs-detail.ts`,
 * re-exports extension-less `@repo/api/src/types/*` specifiers that Playwright's
 * ESM loader cannot resolve — importing it here aborts the WHOLE desktop-e2e
 * suite at load with "Total: 0 tests in 0 files", not just this spec. The
 * sibling `docsHelp` key lives in a leaf module with no such imports, so it IS
 * imported above. Drift on this one is caught by
 * `apps/desktop/test/labs-setting-key-ledger.test.ts`, which pins every Labs
 * setting key by hand.
 */
const DESKTOP_LABS_NAV_FEATURE_FLAG_KEY = "labsNav";

const PALETTE_PLACEHOLDER = "Search documentation…";
const MOUNT_TIMEOUT_MS = 30_000;

/** Matches the bundled `index` page on its TITLE, so the hit cannot drift away. */
const SEEDED_QUERY = "Documentation";
/**
 * `helpPageHref("index")` as the RENDERER paints it: the desktop shell is a hash
 * router, so the anchor carries the `#` prefix the same way `#/dashboard` does in
 * `labs-gating-withdrawal.spec.ts`. No heading, because a title match carries no
 * anchor.
 */
const SEEDED_HIT_HREF = "#/help?page=index";
/**
 * `hitKey(hit)` for that page — the `value` the legacy group stamps on its row,
 * which cmdk reflects as `data-value`.
 *
 * Keyed on the bundle PATH, not on the page's prose title: a docs-only PR that
 * retitles a page would otherwise redden this lane with a locator timeout and
 * nothing pointing back at the docs change. No heading, because a title match
 * carries no anchor.
 */
const SEEDED_HIT_ITEM_VALUE = "index#";

/**
 * ISS-10366 — the failure copy each branch actually emits.
 *
 * THE TWO BRANCHES DO NOT SAY THE SAME THING, and that is why each case is pinned
 * on its own literal rather than on a shared one: the legacy group names the docs,
 * the shared surface renders `SearchSurfaceV2`'s generic title and knows nothing
 * about them. A locator written against one passes vacuously on the other.
 *
 * The legacy one is IMPORTED from its canonical module — that module is a
 * React-free leaf, so it resolves with the `.ts` extension exactly as the flag key
 * above does. `SHARED_SEARCH_FAILED_TITLE` and `RETRY_LABEL` cannot follow:
 * `UNAVAILABLE_TITLE` and `RETRY_LABEL` are module-private in
 * `search-surface-v2-states.tsx` and are not exported at all. Nothing mechanically
 * reconciles those two, so a rename there lands as a RED here rather than a silent
 * pass — each is positively asserted in its own case before it is used in a
 * negative.
 */
const LEGACY_SEARCH_FAILED_TITLE = DOCS_HELP_SEARCH_FAILED_TITLE;
const SHARED_SEARCH_FAILED_TITLE = "Couldn't load results";
/**
 * One constant for both cases: the two branches deliberately spell it alike.
 *
 * The LEGACY half does have a canonical export — `DOCS_SEARCH_RETRY_LABEL` in
 * `docs-command-group.tsx` — so the "not exported at all" reason above covers
 * only the shared half (marisolashgrove review). It is still restated rather than
 * imported, for the OTHER reason on this file: `docs-command-group.tsx` is a
 * `.tsx` whose import drags the component graph into the loader path of every
 * desktop-e2e spec, the same trade `PAGE_ERROR_TEST_ID` records in
 * `help-surface-v2.spec.ts`. Importing it would also pin only one of the two
 * branches this constant serves, leaving the shared one exactly as unreconciled
 * while implying both were covered. A rename on either side lands as a RED here,
 * never a silent pass.
 */
const RETRY_LABEL = "Try again";

/**
 * The NO-RESULTS sentence each branch reaches for a query that ran and matched
 * nothing — `SearchSurfaceV2`'s `NO_RESULTS_TITLE`, and the palette's own
 * `CommandEmpty`. Asserted positively in each failure case before the gate is
 * armed, so the "and not this one" half afterwards is a real distinction rather
 * than a claim about a sentence this build might never render.
 */
const SHARED_NO_RESULTS_TITLE = "No results";
const LEGACY_NO_RESULTS_PREFIX = "No documentation matches";
/** Matches no title, heading, body or group in the bundled snapshot. */
const ABSENT_QUERY = "zzqqxvnosuchdocsterm";

test.describe("Search surface v2 in the desktop command palette", () => {
  test("mounts the shared surface behind ⌘K when the key is on", async () => {
    await withPalette({ portableSurface: true }, async (page) => {
      await openPalette(page);

      await expect(page.getByTestId(SURFACE_TEST_ID)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      // The surface owns the empty branch now, so the palette's own empty slot
      // must be gone — the half that stops this passing on the legacy branch.
      await expect(page.locator('[data-slot="command-empty"]')).toHaveCount(0);

      // A query keeps the body inside the surface: whichever of rows,
      // no-results or unavailable lands, it is the surface's to render.
      await page.getByPlaceholder(PALETTE_PLACEHOLDER).fill("api");
      await expect(page.getByTestId(SURFACE_TEST_ID)).toBeVisible();
      await expect(page.locator('[data-slot="command-empty"]')).toHaveCount(0);
    });
  });

  /**
   * whitlockk review: the case above fills the input and rechecks the ROOT, which a
   * broken mapper or a broken destination leaves green — it never proves the new
   * path returned a result, let alone a routable one.
   *
   * `SEEDED_QUERY` is a title match on the docs bundle's `index` page, which is
   * compiled into the app at build time (`docs-bundle-manifest.ts`), so the hit
   * is deterministic rather than dependent on what the corpus happens to hold.
   * The href is `docsHitsToSurfaceResults` -> `helpPageHref` end to end, which is
   * the seam this PR's both-host argument rests on.
   */
  test("returns a docs hit whose row carries its Help destination", async () => {
    await withPalette({ portableSurface: true }, async (page) => {
      await openPalette(page);
      await page.getByPlaceholder(PALETTE_PLACEHOLDER).fill(SEEDED_QUERY);

      const row = page.getByTestId(SURFACE_TEST_ID).getByRole("link").first();
      await expect(row).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(row).toHaveAttribute("href", SEEDED_HIT_HREF);
    });
  });

  /**
   * ISS-7493 (whitlockk review, PR #7424). Both cases above reach the palette with
   * `page.keyboard.press`, which drives the real input pipeline and therefore
   * always produces a `key` — so the guard on `isPaletteChord` could be deleted
   * without either of them failing. The events that broke production never came
   * from that pipeline: a password manager or extension dispatches a synthetic
   * keydown, and one carrying no usable `key` reached `.toLowerCase()` and threw
   * out of a listener bound for the renderer's whole lifetime.
   *
   * Errors are collected INSIDE the renderer rather than through Playwright's
   * `pageerror`, so the read is ordered against the dispatch instead of racing
   * the CDP round trip.
   *
   * The flag state is irrelevant to this case — the listener is bound by
   * `CommandPaletteInner` above either branch — so it rides the OFF profile
   * rather than launching a third Electron instance for its own.
   */
  test("a ⌘K keydown with no usable key neither opens the palette nor throws (ISS-7493)", async () => {
    await withPalette({ portableSurface: false }, async (page) => {
      // Prove the shell is up and the palette is SHUT before the synthetic
      // dispatch, or "stayed hidden" would also describe a renderer that had
      // not finished mounting.
      await openPalette(page);
      await page.keyboard.press("Escape");
      await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeHidden({
        timeout: MOUNT_TIMEOUT_MS,
      });

      const errors = await page.evaluate(() => {
        const seen: string[] = [];
        const onError = (event: ErrorEvent) => {
          seen.push(event.message);
        };
        window.addEventListener("error", onError);
        const keys: unknown[] = [undefined, null, 42];
        try {
          for (const key of keys) {
            const event = new KeyboardEvent("keydown", {
              bubbles: true,
              ctrlKey: true,
              metaKey: true,
            });
            Object.defineProperty(event, "key", {
              configurable: true,
              value: key,
            });
            window.dispatchEvent(event);
          }
        } finally {
          window.removeEventListener("error", onError);
        }
        return seen;
      });

      expect(errors).toEqual([]);
      await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeHidden();

      // The positive control on the same renderer: the real chord still opens
      // it, so the assertions above are the guard rather than a listener that
      // was never bound.
      await openPalette(page);
    });
  });

  test("keeps the palette's own Docs group when the key is off", async () => {
    await withPalette({ portableSurface: false }, async (page) => {
      await openPalette(page);

      // Anchored on the legacy branch RENDERING, so the surface's absence is a
      // branch choice rather than a palette that never opened.
      await expect(page.locator('[data-slot="command-empty"]')).toHaveCount(1);
      await expect(page.getByTestId(SURFACE_TEST_ID)).toHaveCount(0);
    });
  });

  /**
   * ISS-10366 — the launched-app half of ISS-10044 on the palette, which PR #7241
   * could not pay for. Every case above runs a search that SUCCEEDS, so nothing
   * here proved that a rejected `docsHelp.search` reaches the failure body
   * through the real `ipcMain -> preload -> useDocsCommandSearch` chain, or that
   * the retry item re-crosses IPC rather than only re-rendering.
   *
   * The renderer cannot inject the rejection — `desktopApi` is frozen and
   * non-configurable, as `help-surface-v2.spec.ts` sets out at length — so it is
   * substituted in the MAIN process by `docs-help-failure-gate-preload.cjs`, on
   * the `search` channel alone.
   *
   * BOTH BRANCHES, because they do not say the same thing: the ticket's AC quotes
   * the legacy group's docs-specific sentence, while the gap it describes is on
   * the shared-surface branch, which renders the generic one. One case cannot
   * carry both literals.
   *
   * Each case walks the same three states in one launch, because the claim is a
   * DISTINCTION: a query that ran and matched nothing (the no-results sentence,
   * emitted for real), then a query with real hits whose read was REJECTED (the
   * failure sentence, and NOT the no-results one — the whole point of ISS-10044),
   * then a retry once the gate lets go (the hits the failed read was hiding).
   */
  test("shows the shared surface's failure body, not no-results, when the search rejects", async () => {
    test.setTimeout(300_000);

    await withPalette(
      { docsHelpFailureGate: true, portableSurface: true },
      async (page, app) => {
        await openPalette(page);
        const surface = page.getByTestId(SURFACE_TEST_ID);
        const input = page.getByPlaceholder(PALETTE_PLACEHOLDER);
        const failure = surface.getByText(SHARED_SEARCH_FAILED_TITLE);
        const noResults = surface.getByText(SHARED_NO_RESULTS_TITLE, {
          exact: true,
        });

        // The gate is INERT: a real search runs and settles empty.
        await input.fill(ABSENT_QUERY);
        await expect(noResults).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(failure).toHaveCount(0);

        const armed = await armDocsHelpFailure(
          app,
          DocsHelpFailureOperation.Search
        );
        expect(armed.succeeded).toBeGreaterThan(0);
        expect(armed.failed).toBe(0);

        // A query the index DOES answer, so "nothing matched" would be a false
        // claim about the corpus rather than a defensible empty result.
        await input.fill(SEEDED_QUERY);
        await expect(failure).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(noResults).toHaveCount(0);

        const retry = surface.getByRole("option", { name: RETRY_LABEL });
        await expect(retry).toBeVisible();

        // The retry re-crosses IPC rather than only re-rendering the state it is
        // attached to: the gate counts a SECOND rejected read.
        const beforeRetry = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.Search
        );
        await retry.click();
        await expect
          .poll(
            async () =>
              (
                await readDocsHelpFailureGateStats(
                  app,
                  DocsHelpFailureOperation.Search
                )
              ).failed,
            { timeout: MOUNT_TIMEOUT_MS }
          )
          .toBeGreaterThan(beforeRetry.failed);

        // And the gate is what was producing it: with the real handler answering
        // again, the same retry lands the hit the failed read was standing in for.
        await disarmDocsHelpFailure(app, DocsHelpFailureOperation.Search);
        await surface.getByRole("option", { name: RETRY_LABEL }).click();
        const row = surface.getByRole("link").first();
        await expect(row).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(row).toHaveAttribute("href", SEEDED_HIT_HREF);
        await expect(failure).toHaveCount(0);
      }
    );
  });

  test("shows the legacy group's failure row, not no-results, when the search rejects", async () => {
    test.setTimeout(300_000);

    await withPalette(
      { docsHelpFailureGate: true, portableSurface: false },
      async (page, app) => {
        await openPalette(page);
        const list = page.locator('[data-slot="command-list"]');
        const input = page.getByPlaceholder(PALETTE_PLACEHOLDER);
        const failure = list.getByText(LEGACY_SEARCH_FAILED_TITLE);
        const noResults = list.getByText(LEGACY_NO_RESULTS_PREFIX);

        await input.fill(ABSENT_QUERY);
        await expect(noResults).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(failure).toHaveCount(0);

        const armed = await armDocsHelpFailure(
          app,
          DocsHelpFailureOperation.Search
        );
        expect(armed.succeeded).toBeGreaterThan(0);
        expect(armed.failed).toBe(0);

        await input.fill(SEEDED_QUERY);
        await expect(failure).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // The regression ISS-10044 fixed: a rejection used to render nothing
        // here, so `CommandEmpty` answered for the docs a query never reached.
        await expect(noResults).toHaveCount(0);

        const retry = list.getByRole("option", { name: RETRY_LABEL });
        await expect(retry).toBeVisible();

        const beforeRetry = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.Search
        );
        await retry.click();
        await expect
          .poll(
            async () =>
              (
                await readDocsHelpFailureGateStats(
                  app,
                  DocsHelpFailureOperation.Search
                )
              ).failed,
            { timeout: MOUNT_TIMEOUT_MS }
          )
          .toBeGreaterThan(beforeRetry.failed);

        await disarmDocsHelpFailure(app, DocsHelpFailureOperation.Search);
        await list.getByRole("option", { name: RETRY_LABEL }).click();
        // Keyed on the row's own `value`, not on any rendered text: the query
        // appears in several hits' excerpts as well as in the title, so a text
        // locator ranges over rows this assertion does not mean.
        await expect(
          list.locator(`[data-value="${SEEDED_HIT_ITEM_VALUE}"]`)
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(failure).toHaveCount(0);
      }
    );
  });
});

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}

async function withPalette(
  {
    docsHelpFailureGate = false,
    portableSurface,
  }: {
    /** ISS-10366: install the docs-help IPC failure gate, INERT. Off by default. */
    docsHelpFailureGate?: boolean;
    portableSurface: boolean;
  },
  run: (page: Page, app: ElectronApplication) => Promise<void>
): Promise<void> {
  const { app, page, cleanup } = await launchDesktopApp({
    beforeLaunch: (userDataDir) => {
      seedDesktopFeatureFlags(userDataDir, {
        // The corpus gate, ON in both cases: without it the palette does not
        // mount at all and neither branch could be observed.
        [DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY]: true,
        [DESKTOP_LABS_NAV_FEATURE_FLAG_KEY]: true,
        [PORTABLE_SEARCH_SURFACE_FLAG_KEY]: portableSurface,
      });
    },
    docsHelpFailureGate,
    userDataPrefix: `desktop-search-surface-v2-${portableSurface ? "on" : "off"}-e2e-`,
  });

  try {
    await run(page, app);
  } finally {
    await cleanup();
  }
}
