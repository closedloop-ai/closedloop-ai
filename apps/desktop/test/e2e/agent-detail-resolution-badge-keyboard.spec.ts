/**
 * ISS-4562: cross-adapter E2E for the resolution badge's KEYBOARD reach at the
 * DESKTOP host. The web twin is
 * `e2e/agent-detail-resolution-badge-keyboard.spec.ts`.
 *
 * The badge is `packages/app/agents/components/workspace/resolution-badge.tsx`,
 * mounted through the shared `agent-detail.tsx` that the Electron renderer
 * hosts at `src/renderer/components/agents/agent-detail-view.tsx`, so
 * `apps/desktop/AGENTS.md` ("Cross-surface work covers both adapters") owes this
 * adapter its own regression. The fix put a non-interactive `Chip` — a `<span>`
 * — into the tab order (`interactive` + `tabIndex={0}`) so the tooltip's honest
 * description stops being pointer-only.
 *
 * WHY THIS ADAPTER IS NOT A RESTATEMENT OF THE WEB TWIN
 * ----------------------------------------------------
 * The contract under test is TAB ORDER, and tab order is a property of the whole
 * mounted document rather than of the component — so it is exactly the kind of
 * thing that can hold on one shell and not the other. This is a different
 * Chromium embedding, reached through a different router (hash, not the Next App
 * Router), around a different always-mounted chrome (Sidebar, Topbar, command
 * palette), over a different read: `resolved_state` is a real local SQLite
 * column that the seed below writes and the production IPC path returns, not an
 * HTTP payload a route mock fabricates.
 *
 * Note what is NOT a difference here, because an earlier draft of this file
 * claimed it was: the renderer's keep-alive (`App.tsx`) does leave visited NAV
 * views mounted, but `#/agents/<slug>` takes the `detailAgentSlug` branch, which
 * reassigns `content` WHOLESALE rather than layering over that map — the same
 * thing `src/renderer/__tests__/agent-detail-labs-gate.test.tsx` records. So on
 * this route the other views are unmounted, not hidden, and any extra tab stops
 * come from the persistent shell chrome above.
 *
 * ONE case rather than the web twin's two. The Escape-to-dismiss half is pure
 * radix-ui behaviour with no adapter-specific input, and each case here costs two
 * full app launches; the half that can genuinely differ by adapter is whether a
 * `Tab` still reaches the badge in a document holding other views' stops.
 *
 * Nothing here waits on tooltip ANIMATION — the two facts asserted are discrete
 * DOM states (focus landed, `aria-describedby` resolves), which is what keeps a
 * Radix tooltip assertion out of the flaky class ISS-4562 warned about.
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
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedBodylessAgentComponent,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

const COMPONENT_KEY = "iss-4562-keyboard-reach";
const COMPONENT_NAME = "ISS-4562 Keyboard Reach";

const COMPONENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  COMPONENT_KEY
);

/**
 * `inaccessible` — the org holds a definition it could not read. The shared
 * model folds it to the `unavailable` DISPLAY state, whose description is the
 * only place the page says last-known-good was preserved.
 *
 * The const, not the literal: this is the seed INPUT, on the far side of
 * `deriveResolutionDisplay` from the label being asserted, so importing it
 * creates no circularity. That is the opposite of `BADGE_LABEL` /
 * `BADGE_DESCRIPTION` below, which ARE spelled out precisely because importing
 * the map the component reads would make the assertion track any edit to it.
 */
const SEEDED_RESOLVED_STATE = ComponentResolvedState.Inaccessible;

/**
 * The shipped copy, written out rather than imported from
 * `COMPONENT_RESOLUTION_LABELS`. Importing the map the component itself reads
 * would make this spec agree with any edit to it, including one that emptied the
 * description the keyboard path exists to expose.
 */
const BADGE_LABEL = "Unavailable";
const BADGE_DESCRIPTION =
  "The definition body could not be read (permission-denied or removed); last-known-good is preserved.";

/** The styled tooltip body. Radix unmounts it while the tooltip is closed. */
const TOOLTIP_CONTENT = '[data-slot="tooltip-content"]';

/**
 * Clear focus, then report whether the badge is in the tab order at all and how
 * many stops the document holds.
 *
 * `badge` is a discriminated outcome because the two failure modes mean opposite
 * things: `absent` is a dead locator — nothing on screen carries this label, so
 * every later assertion would be vacuous, and a copy change lands here LOUDLY
 * rather than silently retargeting the test — while `not-tabbable` IS the
 * ISS-4562 regression: the chip is on screen and the browser will not stop on it.
 *
 * The badge is found by its rendered LABEL rather than by a `data-slot`. Which
 * slot it carries is an implementation detail of radix-ui's `Slot` prop merge,
 * not a contract: `TooltipTrigger`'s own `data-slot` reaches the `Chip` as a prop
 * and the Chip spreads it AFTER its own, so the shipped DOM says
 * `tooltip-trigger` and never `chip`. The label is what the user sees.
 *
 * Visibility is `getClientRects()`, not `offsetParent`: the latter is null for a
 * `position: fixed` element, which would drop a real tab stop out of the count.
 */
const RESET_FOCUS_AND_LOCATE_BADGE = (label: string) => {
  const TABBABLE =
    "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [contenteditable]:not([contenteditable='false']), audio[controls], video[controls], [tabindex]:not([tabindex='-1'])";
  const visible = (element: HTMLElement) => element.getClientRects().length > 0;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
  const labelled = Array.from(
    document.querySelectorAll<HTMLElement>("span")
  ).filter(
    (element) => element.textContent?.trim() === label && visible(element)
  );
  if (labelled.length === 0) {
    return { badge: "absent", stops: 0 };
  }
  const tabbable = Array.from(
    document.querySelectorAll<HTMLElement>(TABBABLE)
  ).filter(visible);
  const inTabOrder = tabbable.some((element) => labelled.includes(element));
  return {
    badge: inTabOrder ? "tabbable" : "not-tabbable",
    stops: tabbable.length,
  };
};

/**
 * The badge NODE, so focus can be checked by IDENTITY after the walk rather than
 * by comparing rendered text — which would let any other element carrying the
 * same word satisfy the assertion, and would make product copy the thing that
 * chooses what this test is about.
 */
const BADGE_ELEMENT = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("span")).find(
    (element) =>
      element.textContent?.trim() === label &&
      element.getClientRects().length > 0
  ) ?? null;

/** Identity, not equality of text. */
const ACTIVE_ELEMENT_IS = (badge: HTMLElement | null) =>
  badge !== null && document.activeElement === badge;

/**
 * What a screen reader would announce as the focused element's DESCRIPTION:
 * resolve its `aria-describedby` and read the referenced node. `null` when the
 * attribute is absent or dangles — the two ways the description can be on screen
 * and still unreachable.
 */
const ACTIVE_ELEMENT_DESCRIPTION = () => {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  const id = element.getAttribute("aria-describedby");
  if (!id) {
    return null;
  }
  return document.getElementById(id)?.textContent?.trim() ?? null;
};

/**
 * Slack on the loop guard below. `stops` is what a CSS-level predicate believes
 * is tabbable, which is only a LOWER BOUND on the cycle the browser actually
 * walks — so the cap is that count plus room, and its single job is to end the
 * loop when the badge is unreachable.
 */
const TAB_WALK_SLACK = 10;

/**
 * Press `Tab` until the badge holds focus, checked by element IDENTITY.
 *
 * Identity, not text: a walk that stops when the focused element's text matches
 * the label ends early on any other element carrying the same word — and it
 * makes product copy the thing that decides what this test is about. Comparing
 * the NODE cannot be satisfied by a lookalike.
 *
 * A walk rather than an exact count to a measured index: DOM order is not tab
 * order in this shell, and a predicate that mis-counts by one would then fail on
 * a correct page. The count bounds the loop; the identity check is the assertion.
 */
async function tabToBadge(page: Page, stops: number): Promise<boolean> {
  const badge = await page.evaluateHandle(BADGE_ELEMENT, BADGE_LABEL);
  for (let step = 0; step < stops + TAB_WALK_SLACK; step += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(ACTIVE_ELEMENT_IS, badge)) {
      return true;
    }
  }
  return false;
}

test.describe("Resolution badge keyboard reach, desktop (ISS-4562)", () => {
  test("Tab reaches the badge and opens its honest description", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(async (page) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);

      await waitForLocalComponentDetail(page, COMPONENT_SLUG);
      await gotoHash(page, `/agents/${COMPONENT_SLUG}`);

      // Positive control: the badge mounted through the renderer's real local
      // IPC source. Without it every assertion below would be vacuous.
      await expect(page.getByText(BADGE_LABEL, { exact: true })).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });

      // The negative half, on the same locator the positive half uses: with
      // nothing focused the description is not merely hidden, it is unmounted.
      await expect(page.locator(TOOLTIP_CONTENT)).toHaveCount(0);
      expect(await page.evaluate(ACTIVE_ELEMENT_DESCRIPTION)).toBeNull();

      const order = await page.evaluate(
        RESET_FOCUS_AND_LOCATE_BADGE,
        BADGE_LABEL
      );
      expect(
        order.badge,
        "the resolution badge is not a tab stop in the Electron renderer — a keyboard user cannot reach its description (ISS-4562)"
      ).toBe("tabbable");

      expect(
        await tabToBadge(page, order.stops),
        "tabbing to the badge's own position in the renderer's tab order did not focus it"
      ).toBe(true);

      // The description is on screen...
      await expect(page.locator(TOOLTIP_CONTENT)).toBeVisible();
      await expect(page.locator(TOOLTIP_CONTENT)).toContainText(
        BADGE_DESCRIPTION
      );

      // ...and announced, which the visible node alone does not establish.
      await expect
        .poll(() => page.evaluate(ACTIVE_ELEMENT_DESCRIPTION))
        .toBe(BADGE_DESCRIPTION);
    });
  });
});

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local component IPC
 * source reads the seeded inventory at boot.
 *
 * No feature-flag seeding: the badge is ungated, and this spec covers a fix that
 * already shipped unflagged.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory row is the seeded one (mirrors
 * `agent-detail-definition-absence.spec.ts`).
 */
async function withSeededDesktopProfile(
  run: (page: Page) => Promise<void>
): Promise<void> {
  const prefix = "iss-4562-keyboard";
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedBodylessAgentComponent(userDataDir, {
      harness: "claude",
      id: "iss-4562-agent-component",
      key: COMPONENT_KEY,
      kind: AgentComponentKind.Subagent,
      name: COMPONENT_NAME,
      resolvedState: SEEDED_RESOLVED_STATE,
      source: "acme/app",
    });

    const { page, cleanup } = await launchDesktopApp({
      env,
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

/**
 * Block until the launched renderer's OWN local component IPC resolves the
 * seeded slug, BEFORE the detail route is mounted.
 *
 * The main process installs the DISABLED agent-dashboard DB responders at boot
 * and swaps in the real ones once the local db host is up. The disabled `detail`
 * responder fails closed as `null`, which `createLocalAgentComponentsDataSource`
 * raises as a 404 `ApiError` — deliberately excluded from the shared query
 * client's retry — so a detail query landing inside that boot window caches
 * "Component not found" and never refetches. Polling the SAME production IPC
 * channel the view reads through establishes the precondition without stubbing
 * anything (fuller note in `agent-detail-definition-absence.spec.ts`).
 */
async function waitForLocalComponentDetail(
  page: Page,
  slug: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (target) => {
          const detailFn = (
            globalThis as unknown as {
              desktopApi?: {
                db?: {
                  getAgentComponentDetail?: (
                    slug: string
                  ) => Promise<unknown | null>;
                };
              };
            }
          ).desktopApi?.db?.getAgentComponentDetail;
          if (!detailFn) {
            return false;
          }
          try {
            return (await detailFn(target)) != null;
          } catch {
            // The local runtime is still coming up; keep polling.
            return false;
          }
        }, slug),
      { timeout: MOUNT_TIMEOUT_MS }
    )
    .toBe(true);
}
