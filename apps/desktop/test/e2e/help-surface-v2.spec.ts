/**
 * ISS-10005 AC3 — the DESKTOP Help route reaches `HelpSurfaceV2` through the
 * shipped shell on a real docs deep link, and keeps its superseded composition
 * when `help-complete-surface` is off.
 *
 * The renderer suite cannot say whether the surface is REACHABLE from `App.tsx`
 * or merely exported. Here the hash route, the lazy chunk, the real IPC and the
 * real PostHog assignment all run. Both gate states launch, because a shell that
 * mounted it unconditionally would satisfy the ON case alone.
 *
 * The deep link and anchor are REAL bundle coordinates: AC1 is that the links
 * PRD-555 shipped still land. `pageErrors` is what stops "did not crash" being
 * taken on trust. The `@repo/app` test id is a LITERAL because that subpath does
 * not resolve under Playwright's loader; `help-v2-mount.test.tsx` reconciles it.
 *
 * ISS-10366 adds the rejected-`getPage` case, for the same reason the two above
 * exist: it is the only tier that can say a transport failure reaches the reader
 * as `error` rather than as a claim about the snapshot's contents.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- help-surface-v2.spec.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "../../../../packages/api/src/types/help-complete-surface-flag";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../src/shared/desktop-docs-help-flag";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  armDocsHelpFailure,
  DocsHelpFailureOperation,
  readDocsHelpFailureGateStats,
} from "./helpers/docs-help-failure-gate";

const SURFACE_TEST_ID = "help-surface-v2";

/** Real coordinates in the bundled snapshot of `apps/web/content/docs`. */
const DEEP_LINK_PAGE_PATH = "getting-started/prerequisites";
const DEEP_LINK_PAGE_TITLE = "Prerequisites";
const DEEP_LINK_HEADING_SLUG = "optional-tools";
const DEEP_LINK_NAV_GROUP = "Getting Started";
const DEEP_LINK_HASH = `/help?page=${encodeURIComponent(
  DEEP_LINK_PAGE_PATH
)}&heading=${DEEP_LINK_HEADING_SLUG}`;

/**
 * ISS-10366. `HELP_SURFACE_V2_PAGE_ERROR_TEST_ID`, which `HelpReaderUnavailable`
 * stamps and no other branch of the reader pane does.
 *
 * Restated, and NOT reconciled anywhere — `help-v2-mount.test.tsx` pins
 * `SURFACE_TEST_ID` alone. Its canonical module is `help-reader.tsx`, a React
 * component: importing it would pull the design system into the loader path of
 * every desktop-e2e spec to read one string, which is the worse trade. A rename
 * therefore lands as a RED here, not a silent pass — the id is positively asserted
 * below before it is used in any negative.
 */
const PAGE_ERROR_TEST_ID = "help-surface-v2-page-error";
/**
 * The two reader states this case exists to keep apart, each pinned on its OWN
 * literal rather than on the absence of the other: `HelpReaderUnavailable` says
 * the read failed, `HelpReaderMissing` says the snapshot has no such page. Before
 * ISS-10044 a rejection rendered the second sentence, sending a reader with a
 * perfectly good local copy to look for it online.
 */
const PAGE_ERROR_TITLE = "Couldn't load this page";
const PAGE_MISSING_TITLE = "Page not found";

/**
 * A second REAL bundled page, in the group the deep link already opened.
 *
 * This is `.mdx` FRONTMATTER, so a docs-only PR that retitles the page breaks
 * this lane. The row is therefore asserted present while the gate is still inert
 * — a retitle then fails there, naming the nav row, instead of surfacing as a
 * timeout on the error state thirty seconds later.
 */
const SECOND_PAGE_TITLE = "Install the desktop client";
/** Not in the snapshot, so `getPage` RESOLVES `missing` rather than rejecting. */
const ABSENT_PAGE_HASH = "/help?page=getting-started%2Fnot-in-this-snapshot";

/**
 * The Help pane's own search box and its result list (`help-nav-pane.tsx`), used
 * to check that the gate really is per CHANNEL. `search` is never armed in this
 * case, so it must keep answering for real while `getPage` rejects — otherwise
 * "on the `getPage` channel alone" is a claim the harness makes about itself and
 * nothing tests. This is also the ONLY launched-app exercise of the Help pane's
 * search, whose ISS-10044 failure branch offers no retry at all.
 */
const PANE_SEARCH_LABEL = "Search documentation";
const PANE_RESULTS_LABEL = "Search results";
/** A title match on the bundled `index` page, as `search-surface-v2.spec.ts` pins. */
const PANE_SEARCH_QUERY = "Documentation";

/**
 * `HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID`, the pane's own failed-search branch
 * and the THIRD consumer of the ISS-10044 contract — the one with no retry
 * affordance, so a regression there is permanent for that reader's session.
 *
 * Restated for the same reason as {@link PAGE_ERROR_TEST_ID}: its canonical
 * module `help-nav-pane.tsx` is a React component, and importing it would pull
 * the design system into the loader path of every desktop-e2e spec to read one
 * string. A rename lands as a RED here rather than a silent pass, because the id
 * is positively asserted below before it is used in any negative.
 */
const PANE_SEARCH_FAILED_TEST_ID = "help-surface-v2-search-failed";

const MOUNT_TIMEOUT_MS = 30_000;
const WIDE_VIEWPORT = { height: 900, width: 1380 };

test.describe("Help surface v2 (ISS-10005)", () => {
  test("opens a docs deep link inside the shared surface, at its anchor", async () => {
    test.setTimeout(300_000);

    await withHelpProfile(
      { flagOn: true, prefix: "iss-10005-deep-link" },
      async (page, pageErrors) => {
        await openHelpDeepLink(page);

        const surface = page.getByTestId(SURFACE_TEST_ID);
        await expect(surface).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The deep link opened the page it names, inside the surface's own root
        // — the assertion the superseded body cannot satisfy.
        await expect(
          surface.getByRole("heading", { level: 1, name: DEEP_LINK_PAGE_TITLE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          surface.getByRole("navigation", { name: "Documentation" })
        ).toContainText(DEEP_LINK_NAV_GROUP);

        // The ANCHOR half of AC1: the heading id the bundle generator persisted
        // is stamped on the rendered heading, and it is what the reader scrolled
        // to. Asserted `inViewport`, not merely present — a stamped id that
        // nothing scrolled to is exactly the silent failure ISS-5303 describes.
        const anchor = surface.locator(`#${DEEP_LINK_HEADING_SLUG}`);
        await expect(anchor).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(anchor).toBeInViewport();

        expect(pageErrors).toEqual([]);
      }
    );
  });

  /**
   * THE MALFORMED-NAV CASE IS NOT HERE, AND CANNOT BE (marisolashgrove review).
   *
   * It stubbed the bridge with `Object.defineProperty(window, "desktopApi", …)`
   * to inject a group with no `pages`. That throws in the real app: preload
   * exposes `desktopApi` through `contextBridge.exposeInMainWorld`
   * (`preload-common.ts`), which Electron installs read-only and
   * non-configurable unless `ContextBridgeMutability` is enabled — and this app
   * never enables it, so the case failed on every run with
   * `TypeError: Cannot redefine property: desktopApi`. The exposed object is
   * deep-frozen too, so patching `original.docsHelp.nav` in place is no escape.
   *
   * Nor can it move main-process side: `loadDocsHelpService()` reads the
   * compiled-in `DOCS_BUNDLE`, and there is no path or env override to point at
   * a corrupt manifest. Inventing one would be production code that exists only
   * for this test.
   *
   * AC2 is a RENDER contract and the renderer suites own it outright:
   * `help-surface-v2.test.tsx` covers "drops an unreadable nav group and keeps
   * the rest of the tree" plus all three states of the
   * `help-surface-v2-nav-incomplete` notice, `docs-help-payload-guard.test.ts`
   * covers "skips an unreadable FIRST group instead of throwing on it" — the
   * very position this case chose — and `help-view.test.tsx` covers the shipped
   * body surviving a malformed index.
   *
   * What is left here is the question only an Electron spec can answer: is the
   * surface REACHABLE through the shipped route on each branch of the gate.
   */
  test("keeps the shipped Help body, with no surface root, when the key is off", async () => {
    test.setTimeout(300_000);

    await withHelpProfile(
      { flagOn: false, prefix: "iss-10005-flag-off" },
      async (page, pageErrors) => {
        await openHelpDeepLink(page);

        // The same anchor the ON case waits on, so the surface being absent is
        // the DEFAULT branch rendering rather than a page that never loaded.
        await expect(
          page.getByRole("heading", { level: 1, name: DEEP_LINK_PAGE_TITLE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(page.getByTestId(SURFACE_TEST_ID)).toHaveCount(0);

        expect(pageErrors).toEqual([]);
      }
    );
  });

  /**
   * ISS-10366 — the launched-app half of ISS-10044, which PR #7241 could not pay
   * for. The renderer suites prove `HelpSurfaceV2` renders `page.kind === "error"`
   * as the unavailable notice; nothing proved that a `docsHelp.getPage` REJECTION
   * arrives as that kind through the real `ipcMain -> preload -> useDocsHelp`
   * chain, which is where the bug was.
   *
   * The renderer cannot inject it — `desktopApi` is frozen and non-configurable
   * (see the block above) — so the rejection is substituted in the MAIN process by
   * `docs-help-failure-gate-preload.cjs`, on the `getPage` channel alone. `status`
   * and `nav` stay real, so the reader pane is reached the ordinary way.
   *
   * Three selections in one launch, because the claim is a DISTINCTION and one
   * state alone cannot carry it: a real page (the read works), an absent path (the
   * `missing` sentence, emitted for real), then a real page while armed (the
   * unavailable sentence, and NOT the missing one). Each state is positively
   * asserted on its own literal somewhere in the case, so neither negative is an
   * assertion about a locator nothing ever emits.
   */
  test("drives the reader to the unavailable notice, not the missing one, when getPage rejects", async () => {
    test.setTimeout(300_000);

    await withHelpProfile(
      {
        docsHelpFailureGate: true,
        flagOn: true,
        prefix: "iss-10366-getpage-rejected",
      },
      async (page, pageErrors, app) => {
        await openHelpDeepLink(page);

        const surface = page.getByTestId(SURFACE_TEST_ID);
        await expect(surface).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // The gate is INERT so far: the real read lands, which is what makes the
        // failure below a change of state rather than a surface that never worked.
        await expect(
          surface.getByRole("heading", { level: 1, name: DEEP_LINK_PAGE_TITLE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(surface.getByTestId(PAGE_ERROR_TEST_ID)).toHaveCount(0);

        // The neighbouring state, produced for real by a path the snapshot does
        // not hold. Without this the "not missing" assertion below would be a
        // claim about a sentence this build might never render at all.
        await gotoHash(page, ABSENT_PAGE_HASH);
        await expect(
          surface.getByRole("heading", { level: 2, name: PAGE_MISSING_TITLE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(surface.getByTestId(PAGE_ERROR_TEST_ID)).toHaveCount(0);

        const armed = await armDocsHelpFailure(
          app,
          DocsHelpFailureOperation.GetPage
        );
        // At least the deep link and the absent path already crossed IPC for
        // real, so the gate is failing a channel that demonstrably worked.
        expect(armed.succeeded).toBeGreaterThan(0);
        expect(armed.failed).toBe(0);

        // A page the snapshot DOES hold, and one the per-path cache has never
        // seen — so the selection reaches IPC instead of being answered locally.
        const secondPage = surface
          .getByRole("navigation", { name: "Documentation" })
          .getByRole("button", { name: SECOND_PAGE_TITLE });
        await expect(secondPage).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await secondPage.click();

        const pageError = surface.getByTestId(PAGE_ERROR_TEST_ID);
        await expect(pageError).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          pageError.getByRole("heading", { level: 2, name: PAGE_ERROR_TITLE })
        ).toBeVisible();
        // The whole point of ISS-10044: a rejection must not be dressed as a
        // statement about what the snapshot contains.
        await expect(
          surface.getByRole("heading", { level: 2, name: PAGE_MISSING_TITLE })
        ).toHaveCount(0);

        const settled = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.GetPage
        );
        expect(settled.failed).toBeGreaterThan(0);

        // PER CHANNEL, checked rather than asserted in a comment: the pane's
        // search crosses the same preload bridge in the same renderer while
        // `getPage` is still rejecting, and comes back with real rows.
        //
        // Read as a DELTA across the search below, not as an absolute
        // (marisolashgrove review). The gate's counters are global to the main
        // process, so a bare `succeeded > 0` is satisfied by anything that
        // touched `desktop:docs-help:search` earlier in this launch — including
        // the pane's own mount — and would say nothing about the search this
        // case runs. The same shape as the retry case in
        // `search-surface-v2.spec.ts`.
        const beforeSearch = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.Search
        );
        await surface
          .getByRole("searchbox", { name: PANE_SEARCH_LABEL })
          .fill(PANE_SEARCH_QUERY);
        await expect(
          surface
            .getByRole("list", { name: PANE_RESULTS_LABEL })
            .getByRole("button")
            .first()
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect
          .poll(
            async () =>
              (
                await readDocsHelpFailureGateStats(
                  app,
                  DocsHelpFailureOperation.Search
                )
              ).succeeded,
            { timeout: MOUNT_TIMEOUT_MS }
          )
          .toBeGreaterThan(beforeSearch.succeeded);
        // This one stays ABSOLUTE on purpose: `Search` was never armed in this
        // launch, so the channel must never have failed at all. A delta here
        // would tolerate a pre-existing failure the case had not noticed.
        const searched = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.Search
        );
        expect(searched.failed).toBe(0);

        expect(pageErrors).toEqual([]);
      }
    );
  });

  /**
   * The MIRROR of the case above, and the reason it exists (davetho review).
   *
   * That case arms `getPage` and shows `search` still answering. On its own it
   * only proves isolation in ONE direction: a gate regression that made
   * `arm(Search)` reject BOTH channels would leave every existing case green,
   * because no case had ever held `Search` armed while reading a page. This one
   * does exactly that, so the per-channel claim is pinned both ways.
   *
   * It also puts the pane's own `searchFailed` branch through the launched app
   * for the first time — the third ISS-10044 consumer, and the only one with no
   * retry affordance.
   */
  test("keeps the reader answering while an armed search rejects", async () => {
    test.setTimeout(300_000);

    await withHelpProfile(
      {
        docsHelpFailureGate: true,
        flagOn: true,
        prefix: "iss-10366-search-rejected",
      },
      async (page, pageErrors, app) => {
        await openHelpDeepLink(page);

        const surface = page.getByTestId(SURFACE_TEST_ID);
        await expect(surface).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        const searchbox = surface.getByRole("searchbox", {
          name: PANE_SEARCH_LABEL,
        });

        // INERT so far, both channels. The pane answers a real query and the
        // reader holds a real page, so each failure below is a CHANGE of state
        // rather than a surface that never worked.
        await searchbox.fill(PANE_SEARCH_QUERY);
        await expect(
          surface
            .getByRole("list", { name: PANE_RESULTS_LABEL })
            .getByRole("button")
            .first()
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          surface.getByTestId(PANE_SEARCH_FAILED_TEST_ID)
        ).toHaveCount(0);

        const armed = await armDocsHelpFailure(
          app,
          DocsHelpFailureOperation.Search
        );
        // The gate proves itself before it proves anything about the app.
        expect(armed.succeeded).toBeGreaterThan(0);
        expect(armed.failed).toBe(0);

        // The armed channel fails, positively, on its own literal.
        await searchbox.fill("");
        await searchbox.fill(PANE_SEARCH_QUERY);
        await expect(
          surface.getByTestId(PANE_SEARCH_FAILED_TEST_ID)
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        const searchFailed = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.Search
        );
        expect(searchFailed.failed).toBeGreaterThan(0);

        // THE CLAIM: `getPage` is untouched while `Search` is still armed. Read
        // as a delta across this navigation, because the counters are global to
        // the main process and the deep link above already drove one read.
        const beforeGetPage = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.GetPage
        );
        await gotoHash(page, ABSENT_PAGE_HASH);
        await expect(
          surface.getByRole("heading", { level: 2, name: PAGE_MISSING_TITLE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await openHelpDeepLink(page);
        await expect(
          surface.getByRole("heading", { level: 1, name: DEEP_LINK_PAGE_TITLE })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(surface.getByTestId(PAGE_ERROR_TEST_ID)).toHaveCount(0);

        await expect
          .poll(
            async () =>
              (
                await readDocsHelpFailureGateStats(
                  app,
                  DocsHelpFailureOperation.GetPage
                )
              ).succeeded,
            { timeout: MOUNT_TIMEOUT_MS }
          )
          .toBeGreaterThan(beforeGetPage.succeeded);
        // ABSOLUTE, and the half that catches the leak: `GetPage` was never
        // armed in this launch, so it must never have failed at all. A delta
        // here would pass on a gate that rejected the channel and recovered.
        const getPageStats = await readDocsHelpFailureGateStats(
          app,
          DocsHelpFailureOperation.GetPage
        );
        expect(getPageStats.failed).toBe(0);

        expect(pageErrors).toEqual([]);
      }
    );
  });
});

async function openHelpDeepLink(page: Page): Promise<void> {
  await page.setViewportSize(WIDE_VIEWPORT);
  await gotoHash(page, DEEP_LINK_HASH);
}

/** Launch one isolated profile with the gates seeded, and run the case in it. */
async function withHelpProfile(
  {
    docsHelpFailureGate = false,
    flagOn,
    prefix,
  }: {
    /** ISS-10366: install the docs-help IPC failure gate, INERT. Off by default. */
    docsHelpFailureGate?: boolean;
    flagOn: boolean;
    prefix: string;
  },
  run: (
    page: Page,
    pageErrors: Error[],
    app: ElectronApplication
  ) => Promise<void>
): Promise<void> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  try {
    const { app, cleanup, page, pageErrors } = await launchDesktopApp({
      beforeLaunch: (dir: string) => {
        // PRD-555's destination gate, on in both cases: without it `#/help` is
        // dark and the flag-off case would pass for the wrong reason. `labsNav`,
        // the container above it, is seeded ON by the launch helper already.
        seedDesktopFeatureFlags(dir, {
          [DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY]: true,
          ...(flagOn ? { [HELP_COMPLETE_SURFACE_FLAG_KEY]: true } : {}),
        });
      },
      docsHelpFailureGate,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run(page, pageErrors, app);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}
