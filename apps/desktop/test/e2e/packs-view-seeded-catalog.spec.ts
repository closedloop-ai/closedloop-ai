/**
 * ISS-6687 — `#/packs` must render its CONTENT, not just its chrome.
 *
 * The invariant: a seeded catalog row's DISPLAY NAME renders inside that row's
 * own card. The existing smoke asserts only the `<h1>` and the "Your packs"
 * region, both of which render on an entirely empty store, so it cannot tell a
 * rendered catalog from a silently empty one — the failure mode this panel is
 * prone to, because `useCatalogData` reads the store once on mount with no
 * retry. The seeded id and display name deliberately share no substring, and
 * the id is asserted ABSENT from the card, so a regression that dropped the
 * name or fell back to the id cannot pass on a card that merely mounted.
 *
 * The seed is a `pack_catalog` row, not a filesystem or cloud pack: the grid
 * asserted here is the local `PluginsPanel`, whose rows come from that table.
 * (The "Your packs" region reads the CLOUD catalog, which desktop e2e has no
 * seeded backend for.) Seeding the table directly is the read path the rendered
 * grid actually uses, and needs no child process, harness CLI, or network.
 *
 * Nothing is imported from `@repo/app`: a spec-level import failure aborts the
 * whole desktop suite (`apps/desktop/test/AGENTS.md`), and an expectation
 * derived from the corpus this test wrote cannot drift into agreeing with a
 * broken mapper the way an imported constant compared against itself can.
 *
 * Prerequisites: the app must be built first (`pnpm -C apps/desktop build`).
 */

import { expect, test } from "@playwright/test";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  makeHarnessHomes,
  removeHarnessHomes,
  waitForCatalogEntryServing,
} from "./helpers/pack-install-fixture";
import { seedPackCatalogEntry } from "./helpers/seed-pack-catalog-db";

test("ISS-6687: the Packs view renders a seeded catalog row with its display name", async () => {
  test.setTimeout(specTimeoutMs);
  const homes = makeHarnessHomes();
  const launched = await launchDesktopApp({
    env: {
      ...homes.env,
      // A seeded row has no GitHub scrape spec, so an unguarded contents refresh
      // would overwrite its cache; the detectors are skipped for the same
      // reason the sibling pack specs skip them — neither is under test here.
      SKIP_CATALOG_CONTENTS_FETCH: "1",
      SKIP_CATALOG_DETECTORS: "1",
    },
    userDataPrefix: "desktop-packs-seeded-catalog-e2e-",
  });

  try {
    await seedPackCatalogEntry(launched.userDataDir, {
      displayName: seededDisplayName,
      harnesses: [HarnessName.Claude],
      installCommands: { [HarnessName.Claude]: inertCommand },
      packId: seededPackId,
      uninstallCommands: { [HarnessName.Claude]: inertCommand },
    });

    // SYNCHRONIZATION, NOT AN ASSERTION, and it must precede the navigation:
    // the panel reads the catalog exactly once on mount with no retry, so a
    // navigation issued before the runtime serves would pin an empty answer
    // into the UI permanently and then wait on a DOM that can never change.
    await waitForCatalogEntryServing(
      launched.page,
      seededPackId,
      catalogReadyTimeoutMs
    );

    await gotoNav(launched.page, "packs");

    const card = launched.page.getByTestId(`pack-card-${seededPackId}`);
    await expect(card).toBeVisible({ timeout: catalogReadyTimeoutMs });

    // THE assertion ISS-6687 exists for. Scoped to the card rather than the
    // page, so a name rendered anywhere else (a toast, the detail pane, a
    // heading) cannot stand in for the grid row. `exact` because Playwright's
    // string text matching is a case-insensitive SUBSTRING match, which a
    // truncated or concatenated name would satisfy.
    await expect(
      card.getByText(seededDisplayName, { exact: true })
    ).toBeVisible();

    // The card shows the pack's NAME, not its id: `catalogEntryToPackView` maps
    // `name` from the entry's display name, and an id fallback there would still
    // render a correctly-identified, visible card that satisfies every assertion
    // above except this one.
    await expect(card.getByText(seededPackId)).toHaveCount(0);

    // Asserted LAST and only now that a real card has settled: with a row in
    // the store, the grid must not ALSO be telling the empty story. Ordered
    // after the positive assertions because a `toHaveCount(0)` run against a
    // not-yet-rendered page is satisfied by an empty DOM.
    await expect(
      launched.page.getByText(workspaceEmptyTitle, { exact: true })
    ).toHaveCount(0);

    // The health gate the smoke carries, kept here so a render that produced the
    // right card while throwing on the way is not reported as a pass.
    expect(launched.pageErrors, "no uncaught renderer errors").toEqual([]);
  } finally {
    await launched.cleanup();
    removeHarnessHomes(homes);
  }
});

/** One launch, one seed, one navigation — plus the runtime's own start-up. */
const specTimeoutMs = 240_000;

/** Ceiling for the asynchronous Agent Dashboard runtime to start serving. */
const catalogReadyTimeoutMs = 120_000;

/**
 * The seeded row. The id and the display name deliberately share NO substring:
 * a card that fell back to rendering the pack id must fail the name assertion
 * rather than accidentally satisfy it.
 */
const seededPackId = "closedloop-e2e-iss6687-catalog-row";
const seededDisplayName = "Windward Standards Bundle";

/**
 * Inert command text. This spec never clicks Install or Uninstall, but the
 * catalog row's command maps are what the install IPC would resolve, so they
 * are given a no-op rather than a real command that could run if a later edit
 * did click something.
 */
const inertCommand = "true";

/**
 * `PacksWorkspace`'s grid empty state — the story the grid tells when it has no
 * rows to show, and the one a silently-empty catalog would be stuck on.
 * Deliberately NOT `MemberView`'s "No packs yet", which is the CLOUD-backed
 * "Your packs" region's empty state and IS legitimately present here: desktop
 * e2e has no seeded cloud catalog, so asserting its absence would fail on a
 * healthy app.
 */
const workspaceEmptyTitle = "No packs match your filters";
