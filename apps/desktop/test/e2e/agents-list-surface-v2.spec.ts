/**
 * ISS-9398: the DESKTOP Agents route reaches `AgentsListSurfaceV2` through the
 * shipped shell when `agent-ops-complete-surface` is on, and keeps the
 * `AgentsGroupedList` composition when it is off.
 *
 * The renderer suite drives `AgentsView` directly, which cannot answer whether
 * the v2 branch is REACHABLE from `App.tsx` or merely exported — ISS-8977
 * shipped a shell with zero production consumers and a jsdom render would have
 * been green through it. Here the route table, the lazy chunk, the real local
 * agent-components IPC over a seeded SQLite corpus and the real flag resolution
 * all run.
 *
 * Both flag states are launched from the SAME seed for the same reason the web
 * spec drives both: "the v2 branch renders" is only half the claim, and a shell
 * that mounted it unconditionally would satisfy the ON case alone.
 *
 * The ON case also covers the host-specific capability. Desktop is the shell
 * that HAS a local pack runtime, so its plugin-management region must exist
 * under the Plugins tab — the mirror of the web spec's absence assertion, and
 * the reason neither is vacuous.
 *
 * A third case FOLLOWS a v2 row into the detail route (davetho review on PR
 * #6803). Mounting the surface is not the whole claim: `getComponentHref` is
 * host-supplied now — desktop's is `agentDetailHref`, web's builds a Next
 * path — so a broken or mismatched href leaves both cases above green while
 * every row goes nowhere. The existing desktop detail specs cannot cover it:
 * they `gotoHash` a hand-built route, which is precisely the hop this ticket
 * moved into the surface. Web twin: `e2e/agents-list-surface-v2.spec.ts`.
 *
 * The two test ids are pinned as literals rather than imported, and the flag key
 * is not: a `@repo/app/...` subpath does not resolve under Playwright's ESM
 * loader and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load, while
 * `@repo/api/src/types/*.ts` resolves — eighteen sibling specs import from it.
 * So the key comes from its canonical module and only the two `@repo/app`
 * literals are restated. Their drift is caught by the renderer suite
 * (`agents-v2-mount.test.tsx`), which imports both for real.
 *
 * `V2_SURFACE_TEST_ID` — `AGENTS_LIST_SURFACE_V2_TEST_ID`.
 * `PLUGIN_MANAGEMENT_TEST_ID` — `AGENTS_PLUGIN_MANAGEMENT_TEST_ID`.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run with a fresh CODEX_HOME:
 *     `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- agents-list-surface-v2.spec.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import { AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/agent-ops-complete-surface-flag.ts";
// ISS-9282: the shared 390px band check, taken by relative path the way
// `responsive-pages.spec.ts` takes it (it imports nothing but Playwright).
import {
  clickRowLinkInScrollBand,
  NARROW_VIEWPORT_390,
} from "../../../../e2e/helpers/list-surface-row-link";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

const V2_SURFACE_TEST_ID = "agents-list-surface-v2";
const PLUGIN_MANAGEMENT_TEST_ID = "agents-plugin-management";
/** `AGENTS_LIST_SURFACE_V2_SCROLL_TEST_ID`, a literal for the same reason. */
const V2_SCROLL_TEST_ID = "agents-list-surface-v2-scroll";
/**
 * `AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY`. Its home is `@repo/app`, which this
 * loader cannot import; sibling specs restate it the same way.
 */
const AGENTS_SURFACE_HONESTY_FLAG_KEY = "agents-surface-honesty";
/** The Components card's info trigger (`MetricCard` names it `About <label>`). */
const COMPONENTS_CARD_INFO_NAME = "About Components";

const WIDE_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;
const AGENTS_SEARCH_LABEL = "Search components";
const PLUGINS_TAB_LABEL = "Plugins";

const SUBAGENT_NAME = "iss-9398-orchestrator";
const PLUGIN_NAME = "iss-9398-release-notes";

// The identity the detail route resolves, built with the SAME function the
// production slug is built with rather than restated as a literal — a hand-typed
// `subagent::…` here would pass while production emitted something else.
const SUBAGENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  SUBAGENT_NAME
);
const NOT_FOUND_TITLE = "Component not found";
/**
 * The KPI cards the pinned strip settles to: Components, Invocations, LOC / $
 * and Authors. `metric-card-hide-unavailable` is not seeded, so LOC / $ renders
 * even without a measured ratio; the web twin pins the same four.
 */
const SEEDED_CARD_COUNT = 4;

const SEEDED_COMPONENTS: AgentComponentProvenanceSeed[] = [
  {
    componentKind: AgentComponentKind.Subagent,
    externalId: SUBAGENT_NAME,
    harness: Harness.Claude,
    id: SUBAGENT_NAME,
  },
  {
    componentKind: AgentComponentKind.Plugin,
    externalId: PLUGIN_NAME,
    harness: Harness.Claude,
    id: PLUGIN_NAME,
  },
];

test.describe("Agents list surface v2 (ISS-9398)", () => {
  test("mounts the complete surface, with its plugin-management region, when the gate is on", async () => {
    test.setTimeout(300_000);

    await withSeededDesktopProfile(
      { flagOn: true, prefix: "iss-9398-on" },
      async (page) => {
        await openSeededAgentsCatalog(page, SUBAGENT_NAME);
        await expect(page.getByText(SUBAGENT_NAME).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(page.getByTestId(V2_SURFACE_TEST_ID)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The management region is desktop's declared local-runtime capability.
        // Asserted through the seeded Plugins tab, so the region's presence sits
        // beside a rendered inventory rather than on an empty tab.
        await openSeededAgentsCatalog(page, PLUGIN_NAME);
        await page.getByLabel(PLUGINS_TAB_LABEL).click();
        await expect(page.getByText(PLUGIN_NAME).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(page.getByTestId(PLUGIN_MANAGEMENT_TEST_ID)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
      }
    );
  });

  test("follows a v2 row into the agent detail route", async () => {
    test.setTimeout(300_000);

    await withSeededDesktopProfile(
      { flagOn: true, prefix: "iss-9398-detail" },
      async (page) => {
        await openSeededAgentsCatalog(page, SUBAGENT_NAME);
        await expect(page.getByTestId(V2_SURFACE_TEST_ID)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The href is asserted BEFORE the click, so a failure names the defect
        // — the host built the wrong URL — rather than reporting a detail view
        // that never appeared. The seeded row's `id` is the bare name, so an
        // href built from the id cannot satisfy this.
        const rowLink = page.getByRole("link", { name: SUBAGENT_NAME }).first();
        await expect(rowLink).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // `#`-prefixed: the renderer is a HASH router, and its adapter stores
        // every href in `location.hash` (`desktop-adapter.tsx:216` returns
        // `` `#${href}` `` for anything not already prefixed). So
        // `agentDetailHref` yields `/agents/<slug>` and what a row actually
        // renders is `#/agents/<slug>`. Pinning the rendered form is the point
        // — it is the string the shell navigates on.
        await expect(rowLink).toHaveAttribute(
          "href",
          `#/agents/${encodeURIComponent(SUBAGENT_SLUG)}`
        );
        await rowLink.click();

        // Arriving, not merely navigating: the not-found card renders at this
        // same route, so the resolved <h1> is what separates them. Exact, so a
        // longer heading containing this string cannot satisfy it.
        await expect(
          page.getByRole("heading", { exact: true, name: SUBAGENT_NAME })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(page.getByText(NOT_FOUND_TITLE)).toHaveCount(0);
      }
    );
  });

  /**
   * ISS-9282, the Electron twin of the web 390px case: with the KPI strip
   * pinned above the rows' scroll region, the strip stays one rank and the
   * region keeps a usable row. The rank is the half that reddens if the strip
   * goes back to its two-up grid; the click is the half that proves the row is
   * hit-testable rather than merely present.
   */
  test("390px keeps the pinned KPI strip to one rank above a usable row band", async () => {
    test.setTimeout(300_000);

    await withSeededDesktopProfile(
      { flagOn: true, metricsPinned: true, prefix: "iss-9282-narrow" },
      async (page) => {
        await openSeededAgentsCatalog(page, SUBAGENT_NAME);
        await expect(page.getByTestId(V2_SURFACE_TEST_ID)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await page.setViewportSize(NARROW_VIEWPORT_390);

        const strip = page
          .getByRole("button", { name: COMPONENTS_CARD_INFO_NAME })
          .locator("xpath=ancestor::*[@data-density][1]");
        await expect
          .poll(() =>
            strip.evaluate((row) => {
              const tops = Array.from(row.children, (card) =>
                Math.round(card.getBoundingClientRect().top)
              );
              return {
                // Every card is still rendered: nothing was dropped to buy the fix.
                cards: row.children.length,
                ranks: new Set(tops).size,
                scrollsItself: row.scrollWidth > row.clientWidth,
              };
            })
          )
          .toEqual({ cards: SEEDED_CARD_COUNT, ranks: 1, scrollsItself: true });

        await clickRowLinkInScrollBand(
          page
            .getByTestId(V2_SCROLL_TEST_ID)
            .getByRole("link", { exact: true, name: SUBAGENT_NAME }),
          V2_SCROLL_TEST_ID
        );
        await expect(
          page.getByRole("heading", { exact: true, name: SUBAGENT_NAME })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      }
    );
  });

  test("keeps the existing workspace when the gate is off", async () => {
    test.setTimeout(300_000);

    await withSeededDesktopProfile(
      { flagOn: false, prefix: "iss-9398-off" },
      async (page) => {
        await openSeededAgentsCatalog(page, SUBAGENT_NAME);
        // Same anchor as the ON case: the seeded row is already on screen, so
        // the surface being absent is the DEFAULT branch rendering rather than a
        // list that never loaded.
        await expect(page.getByText(SUBAGENT_NAME).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(page.getByTestId(V2_SURFACE_TEST_ID)).toHaveCount(0);
      }
    );
  });
});

/** Open the Agents catalog and narrow it to one seeded component by name. */
async function openSeededAgentsCatalog(
  page: Page,
  needle: string
): Promise<void> {
  await page.setViewportSize(WIDE_VIEWPORT);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  await gotoNav(page, "agents");
  const search = page.getByLabel(AGENTS_SEARCH_LABEL);
  await expect(search).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await search.fill(needle);
}

/**
 * Launch twice against one isolated profile: migrate, seed while stopped, then
 * relaunch so the production local component source reads the rows at boot.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones.
 */
async function withSeededDesktopProfile(
  {
    flagOn,
    metricsPinned = false,
    prefix,
  }: { flagOn: boolean; metricsPinned?: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, {
        [AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY]: true,
        [AGENTS_SURFACE_HONESTY_FLAG_KEY]: metricsPinned,
      });
    }
  };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponents(userDataDir, SEEDED_COMPONENTS);

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
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
