/**
 * ISS-4803: cross-adapter E2E for the `agents-type-tab-overflow` gate at the
 * DESKTOP host. The web twin is `e2e/agents-type-tab-overflow.spec.ts`.
 *
 * The Agents catalog (`AgentsGroupedList` → `AgentsTypeTabStrip`) is a SHARED
 * `packages/app` surface the Electron renderer mounts alongside the web app, so
 * ISS-4803 needs coverage on both adapters. The two differ in the dimensions
 * that could break this fix independently:
 *
 *  - The WIDTH. This is a layout fix driven by a measured `ResizeObserver`
 *    width, and the desktop is the surface where that width actually varies:
 *    the window is freely resizable and the sidebar eats ~250px of it, so the
 *    strip's row is narrower here than the same viewport gives the web app. The
 *    defect was reported against exactly this — a resized desktop pane.
 *  - The FLAG. The packaged renderer has no PostHog wiring, so it resolves the
 *    byte-equal key from its own Labs registry instead. A split key would land
 *    the fix on web and leave desktop dark forever.
 *
 * Asserts on ROLES and ACCESSIBLE NAMES only, never on computed styles or
 * geometry — "is this kind reachable, and does selecting it stick" is the
 * user-visible contract, and unlike a computed style it does not depend on which
 * CSS pipeline built the bundle under test.
 *
 * Both cases assert BOTH sides of the gate. The flag-OFF half is load-bearing:
 * this ships dark under the ISS-4779 closed-by-default policy, so "no
 * perceivable change with the toggle off" is the contract — and it is also the
 * POSITIVE CONTROL proving the overflow locator and the per-kind radio locator
 * match real nodes on this screen, so a flag-on "not rendered" assertion cannot
 * pass merely because the selector was dead.
 *
 * No seeded inventory: the strip's segments come from `TYPE_TAB_OPTIONS`, a
 * static array derived from `SCOPED_CORE_KINDS`, so all eight render whatever
 * the catalog contains. CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot
 * collectors ingest nothing and the run cannot be perturbed by whatever the host
 * machine happens to have.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

/**
 * The desktop Labs key gating this pass. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (same note in `agents-source-provenance.spec.ts` and
 * `sessions-column-fold.spec.ts`). The copy is pinned by the ISS-4803 case in
 * `apps/desktop/test/feature-flags-shared-ui.test.ts`, which asserts this exact
 * string against `AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY`, so a rename fails there
 * rather than silently leaving this spec seeding a key nothing reads.
 */
const TYPE_TAB_OVERFLOW_FLAG_KEY = "agents-type-tab-overflow";

/**
 * A resized desktop pane. The Electron window has no `minWidth` and the sidebar
 * eats ~250px, so the strip's row lands near 360px of content here — well under
 * the ~676px the eight-segment strip needs, making the overflow a consequence of
 * arithmetic rather than of a threshold tuned to one machine's chrome.
 */
const NARROW_VIEWPORT = { height: 900, width: 640 };

/** A normal desktop window, where all eight segments fit with room to spare. */
const WIDE_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The trailing kind — last in `KIND_ORDER`, so it is the first thing a narrow
 * row drops and the one the ticket reported as unreachable.
 */
const RE_HOOKS_EXACT = /^Hooks$/;

/** The leading segment; doubles as the proof the strip mounted at all. */
const RE_ALL_EXACT = /^All$/;

/**
 * The overflow control's accessible name (`overflowAriaLabel` in
 * `agents-type-tab-strip.tsx`): a count plus the kinds it hides. Matched as an
 * anchored prefix because WHICH kinds overflow depends on the measured row, but
 * it cannot be satisfied by an unrelated button.
 */
const RE_OVERFLOW_CONTROL = /^\d+ more component types: /;

test.describe("Agents type-tab overflow, Labs gate ON (ISS-4803)", () => {
  test("discloses the kinds a narrow desktop pane cannot fit, and pins the one you pick", async () => {
    test.setTimeout(180_000);

    await withDesktopProfile(
      { flagOn: true, prefix: "iss-4803-on" },
      async (page) => {
        await openAgentsCatalog(page, NARROW_VIEWPORT);

        // (1) The disclosure exists and NAMES what it hides, rather than
        // announcing a bare "+4" nobody can act on.
        const overflowControl = page.getByRole("button", {
          name: RE_OVERFLOW_CONTROL,
        });
        await expect(overflowControl).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // (2) The trailing kind is genuinely off the segmented control — not
        // merely scrolled out of view behind the edge fade.
        await expect(
          page.getByRole("radio", { name: RE_HOOKS_EXACT })
        ).toHaveCount(0);

        // (3) It is reachable through the menu — the whole point of the ticket,
        // since a `ToggleGroup` is one tab stop and Tab never reached it.
        await overflowControl.click();
        const hiddenItem = page.getByRole("menuitem", {
          name: RE_HOOKS_EXACT,
        });
        await expect(hiddenItem).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await hiddenItem.click();

        // (4) The selection is PINNED onto the strip and reads as selected. A
        // segmented control whose selected segment fell into the menu would
        // render every visible segment unselected, which reads as "All" — the
        // UI lying about what the catalog below is filtered to. This is the
        // guarantee the ISS-4803 refit protects at exactly these narrow widths.
        const pinnedTab = page.getByRole("radio", { name: RE_HOOKS_EXACT });
        await expect(pinnedTab).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(pinnedTab).toHaveAttribute("aria-checked", "true");
      }
    );
  });

  test("keeps the whole strip expanded in a normal desktop window", async () => {
    test.setTimeout(180_000);

    // The fix must disclose what does not fit, not collapse a row that does.
    await withDesktopProfile(
      { flagOn: true, prefix: "iss-4803-wide" },
      async (page) => {
        await openAgentsCatalog(page, WIDE_VIEWPORT);

        await expect(
          page.getByRole("radio", { name: RE_HOOKS_EXACT })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          page.getByRole("button", { name: RE_OVERFLOW_CONTROL })
        ).toHaveCount(0);
      }
    );
  });
});

test.describe("Agents type-tab overflow, Labs gate OFF (ISS-4803 dark-launch no-op)", () => {
  test("renders every segment and no disclosure, exactly as it ships today", async () => {
    test.setTimeout(180_000);

    await withDesktopProfile(
      { flagOn: false, prefix: "iss-4803-off" },
      async (page) => {
        // The positive control for the gate-on absence assertions: at the SAME
        // narrow pane every segment is still in the control and there is no
        // overflow button, so both locators are demonstrably live on this
        // screen and fail for the reason under test.
        await openAgentsCatalog(page, NARROW_VIEWPORT);

        // Present in the DOM but clipped inside the scroll track — that IS the
        // shipped behaviour the ticket complains about. That it exists is the
        // flag-off contract; that it could not be reached is the defect.
        await expect(
          page.getByRole("radio", { name: RE_HOOKS_EXACT })
        ).toHaveCount(1);
        await expect(
          page.getByRole("button", { name: RE_OVERFLOW_CONTROL })
        ).toHaveCount(0);
      }
    );
  });
});

/**
 * Navigate to the Agents workspace at `viewport` and prove the strip mounted.
 *
 * The `All` segment is the mount gate: the Agents view lazy-loads its own chunk,
 * so asserting on it before any absence check keeps a workspace that never
 * mounted from being mistaken for a passing "the tab is not rendered"
 * assertion — the failure mode that makes this whole class of test worthless.
 *
 * The viewport is set BEFORE navigating so the strip's `ResizeObserver` reports
 * the intended width on its first measured pass rather than adapting afterwards.
 */
async function openAgentsCatalog(
  page: Page,
  viewport: { height: number; width: number }
): Promise<void> {
  await page.setViewportSize(viewport);
  await gotoNav(page, "agents");
  await expect(page.getByRole("radio", { name: RE_ALL_EXACT })).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/**
 * Launch the built app against a throwaway profile with the Labs gate seeded.
 *
 * One launch is enough here — unlike the provenance twin there is no seeded
 * SQLite inventory to write between boots, because the strip's segments are
 * static and independent of what the catalog holds.
 */
async function withDesktopProfile(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));

  try {
    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: (dir: string) => {
        if (flagOn) {
          seedDesktopFeatureFlags(dir, {
            [TYPE_TAB_OVERFLOW_FLAG_KEY]: true,
          });
        }
      },
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run(page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}
