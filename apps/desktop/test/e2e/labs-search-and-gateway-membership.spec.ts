/**
 * ISS-8759 (desktop mirror, operator direction 2026-09-03) — the launched-app
 * regression for WHERE the Search control and the moved Gateway queues live.
 *
 * `labs-nav-reload.spec.ts` observes only `Insights`, which was already a Labs
 * destination before this move: it stays green whether Search and the queues sit
 * inside Labs or remain outside it, so it cannot witness this change at all
 * (davetho, PR #6573). The renderer suite asserts containment, but the desktop
 * contract wants the UI change proven through Electron.
 *
 * What makes each case FAIL is the ABSENCE asserted before the section is
 * opened. If Search stayed pinned above the nav — where it lived before the move
 * — or if Approvals/Requests kept their own `gateway` group, they would be on
 * screen with Labs still collapsed and the first assertion of each case would
 * red. A test that only looked for them AFTER expanding would pass against the
 * whole move reverted, which is precisely the false-green being closed here.
 *
 * The Labs section ships CLOSED (ISS-4478, reaffirmed by the operator
 * 2026-09-03: "Labs ships closed under the PostHog FF"), and the collapsible
 * unmounts its body, so "collapsed" really means "not in the DOM".
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";

const LABS_SECTION_NAME = "Labs";

/**
 * Everything is scoped to the sidebar. The Sessions surface carries its own
 * search field and its own row links, so an unscoped `Search` / `Approvals`
 * lookup would resolve against the page content and stop measuring the sidebar.
 */
function sidebar(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]');
}

function labsToggle(page: Page): Locator {
  return sidebar(page).getByRole("button", { name: LABS_SECTION_NAME });
}

function sidebarSearchBox(page: Page): Locator {
  return sidebar(page).getByRole("textbox", { name: "Search" });
}

function sidebarLink(page: Page, name: string): Locator {
  return sidebar(page).getByRole("link", { exact: true, name });
}

test.describe("desktop Labs holds the Search control and the Gateway queues", () => {
  test("keeps Search and the moved queues out of the DOM until Labs is opened", async () => {
    // No `beforeLaunch`: the harness seeds `labsNav` ON, which is the state this
    // case needs — the container gate open, the section merely collapsed.
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-membership-e2e-",
    });

    try {
      // The section is present and CLOSED. Waiting on the toggle first is what
      // makes the absences below mean "collapsed" rather than "shell not up
      // yet".
      await expect(labsToggle(page)).toBeVisible({ timeout: 30_000 });
      await expect(labsToggle(page)).toHaveAttribute("aria-expanded", "false");

      // The load-bearing assertions. Each one reds if that control is rendered
      // outside the Labs section.
      await expect(sidebarSearchBox(page)).toHaveCount(0);
      await expect(sidebarLink(page, "Approvals")).toHaveCount(0);
      await expect(sidebarLink(page, "Requests")).toHaveCount(0);

      await labsToggle(page).click();
      await expect(labsToggle(page)).toHaveAttribute("aria-expanded", "true");

      // …and all three arrive together with the section body.
      await expect(sidebarSearchBox(page)).toBeVisible({ timeout: 30_000 });
      await expect(sidebarLink(page, "Approvals")).toBeVisible();
      await expect(sidebarLink(page, "Requests")).toBeVisible();
      // A peer that was already a Labs destination before this move. Its
      // presence proves the section really expanded, so the three assertions
      // above are measuring membership and not a section that happened to open.
      await expect(sidebarLink(page, "Insights")).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("takes Search and the moved queues away again when Labs is collapsed", async () => {
    // Operator ruling 2026-09-01: "search should not be visible when Labs is not
    // present or collapsed." Re-collapsing is the half a first-load check cannot
    // see, because the section starts closed.
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-membership-collapse-e2e-",
    });

    try {
      await expect(labsToggle(page)).toBeVisible({ timeout: 30_000 });
      await labsToggle(page).click();
      await expect(sidebarSearchBox(page)).toBeVisible({ timeout: 30_000 });
      await expect(sidebarLink(page, "Approvals")).toBeVisible();

      await labsToggle(page).click();
      await expect(labsToggle(page)).toHaveAttribute("aria-expanded", "false");

      await expect(sidebarSearchBox(page)).toHaveCount(0);
      await expect(sidebarLink(page, "Approvals")).toHaveCount(0);
      await expect(sidebarLink(page, "Requests")).toHaveCount(0);
      // The shell is still up and the nav still works — the controls went with
      // the section, the sidebar did not collapse or crash.
      await expect(sidebarLink(page, "Sessions")).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
