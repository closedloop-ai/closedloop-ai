/**
 * ISS-8640 — marketplace metadata stays safe at the Desktop boundary.
 *
 * This launched-app regression drives a malformed marketplace description from
 * a seeded cache row through main-process catalog mapping, IPC, preload, the
 * Desktop Plugins panel, and the shared PackDetail Contents tab. The refresh is
 * skipped so the seeded row is deterministic and no GitHub transport is used.
 */

import { expect, test } from "@playwright/test";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { waitForCatalogEntryServing } from "./helpers/pack-install-fixture";
import { seedPackCatalogEntry } from "./helpers/seed-pack-catalog-db";

test("ISS-8640: malformed marketplace descriptions do not blank the pack detail", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const launched = await launchDesktopApp({
    env: {
      SKIP_CATALOG_CONTENTS_FETCH: "1",
      SKIP_CATALOG_DETECTORS: "1",
    },
    userDataPrefix: "desktop-pack-manifest-validation-e2e-",
  });

  try {
    await seedPackCatalogEntry(launched.userDataDir, {
      contents: { type: "claude-marketplace" },
      contentsCache: [
        {
          name: PLUGIN_NAME,
          type: "plugin",
          description: { text: INVALID_DESCRIPTION_TEXT },
        },
      ],
      displayName: PACK_DISPLAY_NAME,
      harnesses: [HarnessName.Claude],
      installCommands: { [HarnessName.Claude]: "true" },
      packId: PACK_ID,
      uninstallCommands: { [HarnessName.Claude]: "true" },
    });
    await waitForCatalogEntryServing(
      launched.page,
      PACK_ID,
      CATALOG_READY_TIMEOUT_MS
    );

    await gotoNav(launched.page, "packs");
    const card = launched.page.getByTestId(`pack-card-${PACK_ID}`);
    await expect(card).toBeVisible({ timeout: CATALOG_READY_TIMEOUT_MS });
    await card.click();

    await expect(
      launched.page.getByRole("heading", { name: PACK_DISPLAY_NAME })
    ).toBeVisible({ timeout: CATALOG_READY_TIMEOUT_MS });
    await expect(
      launched.page.getByText(CONTENTS_UNAVAILABLE_NOTE, { exact: true })
    ).toBeVisible({ timeout: CATALOG_READY_TIMEOUT_MS });

    const row = launched.page
      .locator('[data-testid="plugins-panel"]')
      .getByRole("listitem")
      .filter({
        has: launched.page.getByText(PLUGIN_NAME, { exact: true }),
      });
    await expect(row).toHaveCount(1, { timeout: CATALOG_READY_TIMEOUT_MS });
    await expect(row).not.toContainText(INVALID_DESCRIPTION_TEXT);
    expect(launched.pageErrors, "no uncaught renderer errors").toEqual([]);
  } finally {
    await launched.cleanup();
  }
});

const SPEC_TIMEOUT_MS = 240_000;
const CATALOG_READY_TIMEOUT_MS = 120_000;
const PACK_ID = "closedloop-e2e-iss8640-marketplace";
const PACK_DISPLAY_NAME = "Marketplace Validation Fixture";
const PLUGIN_NAME = "manifest-safety-plugin";
const INVALID_DESCRIPTION_TEXT = "must not reach React";
const CONTENTS_UNAVAILABLE_NOTE =
  "Bundled contents could not be refreshed right now. Showing cached contents when available.";
