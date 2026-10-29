/**
 * ISS-5309 / ISS-5310 (whitlockk cid 3726730882) — the launched-app regression for
 * the Labs gates.
 *
 * The E2E helper seeds `labsNav` and `agentsNav` ON for every launched app, so
 * every other spec in this suite exercises the gates OPEN and none of them would
 * notice if the gates stopped closing. The desktop renderer rule requires a
 * launched-app regression for a UI fix, so this spec turns the gates off through
 * the same seeded ASSIGNMENT the product resolves its gates from (ISS-8753) and
 * proves the surfaces are actually withdrawn from the real app.
 *
 * `beforeLaunch` runs AFTER `seedE2eDesktopSettings`, so these values overwrite
 * the harness defaults rather than racing them.
 *
 * Every "it is gone" assertion is paired with something that must still be
 * there — the committed Dashboard view, the Sessions nav entry — so a renderer
 * that crashed outright cannot satisfy an absence. ISS-10195 retired the
 * Settings PAGE, so the Account and Relay / Gateway tabs that used to serve as
 * those pairings no longer exist on any gate value.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, type Page, test } from "@playwright/test";
import {
  activeNavPanel,
  gotoHash,
  gotoNavSettled,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

/**
 * The flag keys are literals here, not registry imports, for the load hazard
 * documented in `test/AGENTS.md`: `src/shared/feature-flags.ts` pulls in
 * `@repo/api/src/types/*` subpaths that resolve in the app but NOT under the
 * Playwright spec loader, so importing it aborts the entire suite at collection
 * time with `Cannot find module` and zero `✘` lines. `helpers/desktop-app.ts`
 * seeds these same two keys as literals for the same reason. They are
 * `DESKTOP_LABS_NAV_FEATURE_FLAG_KEY` and `DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY`
 * in that registry, and the renderer suites assert against the constants.
 */
const LABS_NAV_FLAG_KEY = "labsNav";
const AGENTS_NAV_FLAG_KEY = "agentsNav";
/** `DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY`, a literal for the load hazard above. */
const DOCS_HELP_FLAG_KEY = "docsHelp";
/**
 * `DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY`, a literal for the load
 * hazard above. Declared in `packages/app/shared/lib/feature-flags.ts` rather
 * than in the desktop registry — it is resolved from the PostHog assignment, not
 * from a Labs setting — but the loader hazard is the same from a spec.
 */
const LABS_ROUTE_WITHDRAWAL_FLAG_KEY = "desktop-labs-route-withdrawal";

const LABS_SECTION_NAME = "Labs";
const SESSIONS_NAV_NAME = "Sessions";

/**
 * Land on an ungated page with the sidebar mounted, so the absences below are
 * measured against a shell that actually rendered.
 *
 * ISS-10195 retired the workspace-experience gate, which made Settings the
 * modal `DesktopSettingsModalHost` presents rather than a nav page: it has no
 * Topbar label and no tab strip, so neither the "Settings" header text nor the
 * always-present Account tab this spec used as its readiness anchor exists any
 * more. Dashboard is `DEFAULT_NAV_ID` and ungated, and `gotoNavSettled` waits
 * for the shell to COMMIT the view — the same "the app is alive" proof the tab
 * anchor was standing in for, on a surface this spec's subject does not gate.
 */
async function landOnUngatedPage(page: Page): Promise<void> {
  await gotoNavSettled(page, "dashboard");
}

test.describe("desktop Labs gating withdraws its surfaces", () => {
  test("withdraws the Labs nav section when Labs is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [LABS_NAV_FLAG_KEY]: false,
        });
      },
      userDataPrefix: "desktop-labs-off-e2e-",
    });

    try {
      await landOnUngatedPage(page);

      // The section is ABSENT, not merely disabled or empty.
      //
      // ISS-8753 removed the two Settings-tab assertions that used to lead this
      // case. They named the Settings → Labs tab, which this change deletes
      // outright, so as absence checks they had become unfailable — the element
      // they looked for can no longer exist under any gate value, and a
      // permanently-satisfied absence proves nothing about gating. What the
      // `labsNav` container gate still decides, and what this measures, is the
      // sidebar section.
      await expect(
        page.getByRole("button", { name: LABS_SECTION_NAME })
      ).toHaveCount(0);
      // …while the rest of the app is untouched, so a renderer that crashed
      // outright cannot satisfy the absence above. ISS-10195: this used to
      // name the Settings → Relay / Gateway tab, which retired with the
      // Settings PAGE; the sidebar's own Sessions entry is the health anchor
      // the other cases in this file already use, and it sits in the tree the
      // `labsNav` gate actually acts on. `exact` keeps it reading that entry
      // rather than any longer link containing the word.
      await expect(
        page.getByRole("link", { exact: true, name: SESSIONS_NAV_NAME })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("keeps the Labs nav section when Labs is on", async () => {
    // The mirror of the case above. Without it, a regression that dropped the
    // Labs section entirely would satisfy the absence assertion there.
    //
    // ISS-8753 moved this case's subject from the Settings → Labs tab to the
    // sidebar section, because the tab is gone and the section is what `labsNav`
    // still gates. The launched app is seeded with `labsNav` ON by default, so
    // this needs no `beforeLaunch` — that default is exactly the open-gate state
    // under test.
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-on-e2e-",
    });

    try {
      await landOnUngatedPage(page);

      await expect(
        page.getByRole("button", { name: LABS_SECTION_NAME })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("withdraws #/agents and #/agents/:slug when the Agents gate is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        // Labs stays ON so this measures the PER-ITEM gate specifically, rather
        // than the container gate closing over it.
        seedDesktopFeatureFlags(userDataDir, {
          [AGENTS_NAV_FLAG_KEY]: false,
          [LABS_NAV_FLAG_KEY]: true,
        });
      },
      userDataPrefix: "desktop-agents-nav-off-e2e-",
    });

    try {
      // The list tier.
      await gotoHash(page, "/agents");
      await expect(page.getByText("Agents is turned off")).toBeVisible({
        timeout: 30_000,
      });

      // …and the DETAIL tier, which is the bug this covers: the detail override
      // bypassed the list's gate, so a saved `#/agents/<slug>` still mounted the
      // full agent screen out of a section that had been switched off.
      await gotoHash(page, "/agents/reviewer-bot");
      await expect(page.getByText("Agents is turned off")).toBeVisible({
        timeout: 30_000,
      });
      // ISS-8753: one way back, and it goes somewhere that exists. This used to
      // be "Open settings", landing on the Settings → Labs tab; that tab is
      // gone, and a desktop gate now opens only if the signed-in user's PostHog
      // assignment carries it, so the panel names the one destination that IS
      // reachable instead of a control it can no longer promise.
      //
      // The name changed from "Go to Sessions" because the DESTINATION changed,
      // not because this assertion was wrong: `DEFAULT_NAV_ID` is now the
      // canonical Dashboard landing, and the withheld-surface CTA derives both
      // its label and its href from it (`labsPageRecovery` in
      // `labs-gate-surfaces.tsx` builds `Go to ${pageTitleForNav(DEFAULT_NAV_ID)}`
      // and `hrefForNavId(DEFAULT_NAV_ID)`), so its label follows. Dashboard is
      // ungated, so this remains a way OUT of a withdrawn surface rather than a
      // dead or circular link.
      await expect(
        page.getByRole("link", { name: "Go to Dashboard" })
      ).toBeVisible();

      // The shell is healthy — this is a withdrawn destination, not a dead app.
      //
      // `exact` keeps this reading the shell's own Sessions nav item rather than
      // any longer link that merely contains the word. It no longer collides
      // with the recovery action above (that one names Dashboard now), but the
      // health check is only a health check while it resolves the sidebar entry,
      // so the constraint stays.
      await expect(
        page.getByRole("link", { exact: true, name: "Sessions" })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  /**
   * ISS-8759 (desktop mirror, operator direction 2026-09-03) — the Gateway
   * sub-menu folded into Labs, so Approvals and Requests are Labs destinations
   * now. On desktop that is not merely "hidden from the sidebar": a displayed
   * Labs route is unreachable BY HASH while the container gate is closed. That
   * consequence is the operator-approved half of the move, which is exactly why
   * it needs a launched-app regression rather than renderer-only coverage —
   * before the move these two hashes resolved with `labsNav` off, and nothing at
   * this tier would notice if they started resolving again.
   */
  test("withdraws #/approvals and #/requests when Labs is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [LABS_NAV_FLAG_KEY]: false,
        });
      },
      userDataPrefix: "desktop-gateway-labs-off-e2e-",
    });

    try {
      for (const [hashPath, title] of [
        ["/approvals", "Approvals"],
        ["/requests", "Requests"],
      ] as const) {
        await gotoHash(page, hashPath);
        // The turned-off panel NAMES the destination, so this cannot be
        // satisfied by a generic error surface or by the shell silently
        // dropping the user on Sessions.
        await expect(page.getByText(`${title} is turned off`)).toBeVisible({
          timeout: 30_000,
        });
      }

      // The shell is healthy — these are withdrawn destinations, not a dead app.
      // `exact` for the same strict-mode reason as the Agents case above.
      await expect(
        page.getByRole("link", { exact: true, name: "Sessions" })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  /**
   * The mirror, so the absences above cannot pass vacuously against a build
   * where these two routes never resolve at all.
   */
  test("reaches #/approvals and #/requests when Labs is on", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-gateway-labs-on-e2e-",
    });

    try {
      for (const [hashPath, title] of [
        ["/approvals", "Approvals"],
        ["/requests", "Requests"],
      ] as const) {
        await gotoHash(page, hashPath);
        await expect(page.getByText(`${title} is turned off`)).toHaveCount(0);
        await expect(
          page.locator("header").getByText(title, { exact: true })
        ).toBeVisible({ timeout: 30_000 });
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  /**
   * ISS-9731 (codex bot cid 4000956882, whitlockk cid 4000963091) — the launched-app
   * regression for the deep link this change moves off a blank body.
   *
   * The renderer suite (`labs-route-withdrawal.test.tsx`) mounts the shell at
   * each hash, but it injects the assignment as props and drives a jsdom router.
   * Three real boundaries are therefore untested by it and are exactly what this
   * change moves: the hash router resolving `#/help` in the
   * packaged shell, the seeded ASSIGNMENT being served over the IPC bridge, and
   * the provider handing the rollout key to `use-nav-gates.ts`. Any of those can
   * regress while every jsdom case stays green.
   *
   * Labs stays ON so this measures the PER-ITEM gate, as the Agents case above
   * does — with the container gate closed the per-item gate is never reached
   * and this would pass against a shell that had forgotten it.
   */
  test("withdraws #/help when the rollout key is on and its gate is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [LABS_NAV_FLAG_KEY]: true,
          [DOCS_HELP_FLAG_KEY]: false,
          [LABS_ROUTE_WITHDRAWAL_FLAG_KEY]: true,
        });
      },
      userDataPrefix: "desktop-labs-route-withdrawal-on-e2e-",
    });

    try {
      for (const [hashPath, navId, title] of [
        ["/help", "help", "Help"],
      ] as const) {
        await gotoHash(page, hashPath);

        // Scoped to the panel the shell COMMITTED to, for the keep-alive reason
        // `activeNavPanel` documents.
        const panel = activeNavPanel(page, navId);
        await expect(panel).toBeVisible({ timeout: 30_000 });
        // The panel NAMES the destination — this is the state that replaced the
        // blank body, so a shell that still rendered nothing fails here.
        await expect(panel.getByText(`${title} is turned off`)).toBeVisible();
        // …and the route CAME TO REST at the hash the user typed, rather than
        // falling through to another surface.
        expect(await currentHash(page)).toBe(`#${hashPath}`);
      }

      // The shell is healthy — withdrawn destinations, not a dead app. `exact`
      // for the same strict-mode reason as the Agents case above.
      await expect(
        page.getByRole("link", { exact: true, name: "Sessions" })
      ).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  /**
   * The counterfactual, and the closed-by-default half of the contract: with the
   * rollout key OFF this route must rest exactly as it did before
   * ISS-9731 — resolved, titled, and blank. Without this case the assertion
   * above is equally satisfied by a shell that panels unconditionally, which
   * would be UI newly rendered in its DEFAULT state.
   */
  test("leaves #/help blank while the rollout key is off", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [LABS_NAV_FLAG_KEY]: true,
          [AGENTS_NAV_FLAG_KEY]: false,
          [DOCS_HELP_FLAG_KEY]: false,
          [LABS_ROUTE_WITHDRAWAL_FLAG_KEY]: false,
        });
      },
      userDataPrefix: "desktop-labs-route-withdrawal-off-e2e-",
    });

    try {
      for (const [hashPath, title] of [["/help", "Help"]] as const) {
        await gotoHash(page, hashPath);
        // The breadcrumb still names the destination, so the route resolved and
        // this absence is about the BODY rather than about a dead route.
        await expect(
          page.locator("header").getByText(title, { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(`${title} is turned off`)).toHaveCount(0);
      }

      // Agents keeps withdrawing regardless of the key, so this arm cannot have
      // switched the panel off globally (ISS-5310 is not regressed).
      await gotoHash(page, "/agents");
      await expect(page.getByText("Agents is turned off")).toBeVisible({
        timeout: 30_000,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

/**
 * The desktop location, read from `location.hash` inside the renderer rather
 * than from `page.url()`.
 *
 * The renderer is loaded from a `file://` document whose URL carries no app
 * route, so the hash IS the location — the same reason
 * `agent-detail-tab-permalink.spec.ts` and `agents-kind-permalink.spec.ts` read
 * it this way.
 */
async function currentHash(page: Page): Promise<string> {
  return await page.evaluate(() => globalThis.location.hash);
}
