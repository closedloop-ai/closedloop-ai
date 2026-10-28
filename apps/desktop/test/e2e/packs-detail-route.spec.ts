/**
 * ISS-6925: on desktop too, a pack detail must be reachable by its own route.
 *
 * Selection used to live in `PacksWorkspace`'s `useState`, so the only way into
 * a pack's detail was a card click and a reload dropped you back on the grid.
 * The desktop route table now maps `/packs/:id` onto the Packs view carrying an
 * `id` param, and the shared host reads it back through the navigation port.
 *
 * The invariant driven here is the one a unit test cannot reach: navigating the
 * renderer STRAIGHT to `#/packs/<id>` — no click anywhere — renders that pack's
 * detail. The seeded display name is the marker, and the pack id deliberately
 * shares no substring with it, so a regression that fell back to the grid, or
 * rendered the id instead of the name, cannot pass.
 *
 * It also covers the direct-load hydration half: `PluginsPanel` used to fetch a
 * pack's contents inside its click handler, which a routed load never fires.
 * The Contents heading only renders once that read lands, so asserting it proves
 * hydration is keyed on the selection rather than on the click.
 *
 * Nothing is imported from `@repo/app`: a spec-level import failure aborts the
 * whole desktop suite (`apps/desktop/test/AGENTS.md`), so the flag key is spelled
 * out here — keep it byte-identical to `PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`.
 *
 * Prerequisites: the app must be built first (`pnpm -C apps/desktop build`).
 */

import { expect, test } from "@playwright/test";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  makeHarnessHomes,
  removeHarnessHomes,
  waitForCatalogEntryServing,
} from "./helpers/pack-install-fixture";
import { seedPackCatalogEntry } from "./helpers/seed-pack-catalog-db";

/** Keep byte-identical to PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY (@repo/app). */
const PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY = "packs-detail-route";

const SEEDED_PACK_ID = "iss6925-routed-pack";
// Shares no substring with the id, so the assertion cannot pass on a card that
// merely mounted or on a fallback that rendered the identifier.
const SEEDED_DISPLAY_NAME = "Telescope Workbench";
const INERT_COMMAND = "true";
const SPEC_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 30_000;

test("ISS-6925: a direct load of #/packs/:id renders that pack's detail", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const homes = makeHarnessHomes();
  const launched = await launchDesktopApp({
    env: {
      ...homes.env,
      // A seeded row has no GitHub scrape spec, so an unguarded contents refresh
      // would overwrite its cache; the detectors are skipped for the same reason
      // the sibling pack specs skip them — neither is under test here.
      SKIP_CATALOG_CONTENTS_FETCH: "1",
      SKIP_CATALOG_DETECTORS: "1",
    },
    userDataPrefix: "desktop-packs-detail-route-e2e-",
    beforeLaunch: (userDataDir) => {
      seedDesktopFeatureFlags(userDataDir, {
        [PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY]: true,
      });
    },
  });

  try {
    await seedPackCatalogEntry(launched.userDataDir, {
      displayName: SEEDED_DISPLAY_NAME,
      harnesses: [HarnessName.Claude],
      installCommands: { [HarnessName.Claude]: INERT_COMMAND },
      packId: SEEDED_PACK_ID,
      uninstallCommands: { [HarnessName.Claude]: INERT_COMMAND },
    });
    await waitForCatalogEntryServing(
      launched.page,
      SEEDED_PACK_ID,
      RENDER_TIMEOUT_MS
    );

    // Straight to the detail route — no card click anywhere in this spec.
    await gotoHash(launched.page, `/packs/${SEEDED_PACK_ID}`);

    await expect(
      launched.page.getByText(SEEDED_DISPLAY_NAME).first()
    ).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
    // The back affordance is a real link once the detail is addressable.
    await expect(
      launched.page.getByRole("link", { name: "All plugins" })
    ).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
    // Hydration keyed on the SELECTION, not the click that never happened.
    await expect(
      launched.page.getByRole("tab", { name: "Contents" })
    ).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
  } finally {
    await launched.cleanup();
    removeHarnessHomes(homes);
  }
});
