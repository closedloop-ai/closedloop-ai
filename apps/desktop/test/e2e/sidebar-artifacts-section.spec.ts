/**
 * The desktop sidebar's "Artifacts" group — header on screen, Sessions and
 * Branches inside it — in the LAUNCHED app.
 *
 * `sidebar-artifacts-section.test.tsx` drives the same contract in jsdom, and
 * that is not enough here. The defect it fixes was a rendering consequence of
 * `nav-config`'s FOCUS_MODE fold: `navItemsForSection(NavSection.Artifacts)`
 * returned `[]`, so `Sidebar`'s `artifactItems.length > 0` guard dropped the
 * group header while Sessions and Branches still rendered — unlabeled — in the
 * top group. A jsdom render of `Sidebar` answers "does the component group
 * them"; it cannot answer "does the SHIPPED shell put that group on screen".
 * ISS-9107 hit the same seam a day earlier: a green renderer suite over a
 * surface the Electron shell never reached.
 *
 * So the whole chain runs here — `App.tsx`'s real shell, the real `nav-config`
 * evaluation, the real `use-nav-gates` flag resolution, the real Radix
 * collapsible, the real Electron renderer. Drop the `artifacts` exemption again
 * and the header disappears with it, which is exactly what the existing suite
 * could not notice.
 *
 * Every assertion is SCOPED to the Artifacts group, not to the page: the
 * Dashboard behind the sidebar links to Sessions and Branches too, so a
 * page-wide query would be satisfied by content that has nothing to do with the
 * nav. Collapsing the group is the containment proof — Radix unmounts closed
 * `CollapsibleContent`, so links that survive the collapse were never under the
 * header.
 *
 * Packs is asserted absent from the group for the second half of the fix: the
 * exempt check beats `FOCUSED_NAV_IDS`, so an entry still DECLARING `artifacts`
 * gets pulled into the restored group. Packs was that entry, and it renders in
 * this harness (`labsNav` is seeded on), so its absence here is a real read.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";

/**
 * Nav labels and the design-system group slot, pinned as literals rather than
 * imported: a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load. Drift
 * is caught first by the renderer suite, which imports the nav model for real.
 */
const ARTIFACTS_GROUP_LABEL = "Artifacts";
const ARTIFACTS_MEMBER_LABELS = ["Sessions", "Branches"] as const;
const LABS_ONLY_LABEL = "Packs";
const SIDEBAR_GROUP_SLOT = '[data-slot="sidebar-group"]';

test("the launched desktop shell renders the Artifacts nav group over Sessions and Branches", async () => {
  test.setTimeout(180_000);

  const { page, pageErrors, cleanup } = await launchDesktopApp({
    userDataPrefix: "desktop-artifacts-nav-section-e2e-",
  });

  try {
    const artifactsToggle = page.getByRole("button", {
      name: ARTIFACTS_GROUP_LABEL,
      exact: true,
    });
    await expect(artifactsToggle).toBeVisible({ timeout: 30_000 });
    // The group ships open, so its members are reachable without a click.
    await expect(artifactsToggle).toHaveAttribute("aria-expanded", "true");

    const artifactsGroup = page
      .locator(SIDEBAR_GROUP_SLOT)
      .filter({ has: artifactsToggle });

    for (const label of ARTIFACTS_MEMBER_LABELS) {
      await expect(
        artifactsGroup.getByRole("link", { name: label, exact: true })
      ).toBeVisible();
    }
    await expect(
      artifactsGroup.getByRole("link", { name: LABS_ONLY_LABEL, exact: true })
    ).toHaveCount(0);

    await artifactsToggle.click();
    await expect(artifactsToggle).toHaveAttribute("aria-expanded", "false");
    for (const label of ARTIFACTS_MEMBER_LABELS) {
      await expect(
        artifactsGroup.getByRole("link", { name: label, exact: true })
      ).toHaveCount(0);
    }

    // Reopening rules out a disclosure that only ever destroys its content.
    await artifactsToggle.click();
    await expect(artifactsToggle).toHaveAttribute("aria-expanded", "true");
    for (const label of ARTIFACTS_MEMBER_LABELS) {
      await expect(
        artifactsGroup.getByRole("link", { name: label, exact: true })
      ).toBeVisible();
    }

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});
