/**
 * ISS-5529 (#7013 review): cross-adapter E2E for the component-detail Branches
 * tab refusing to deny branches it never measured, at the DESKTOP host. The web
 * twin is `e2e/agent-detail-branches-unmeasured.spec.ts`.
 *
 * The Branches tab is rendered by the SHARED
 * `packages/app/agents/components/workspace/detail-branches-tab.tsx`, which the
 * Electron renderer mounts through `src/renderer/components/agents/
 * agent-detail-view.tsx` — so `packages/app/AGENTS.md` ("E2E Coverage for UI
 * Surfaces") owes this adapter its own regression, and the jsdom suite injects
 * both the payload and the flag as props and therefore touches neither real
 * boundary.
 *
 * WHAT THIS ADAPTER PROVES THAT NO OTHER TEST CAN
 * -----------------------------------------------
 * Two things, and they are independent:
 *
 *  1. THE FLAG. The renderer resolves this key from the signed-in account's
 *     PostHog assignment over the IPC bridge (`DesktopFeatureFlagProvider`), a
 *     path with no counterpart on web. A key that never resolved here would
 *     leave desktop on the flat denial forever while web told the truth — and
 *     since the provider fails CLOSED on every non-answer, that failure is
 *     silent by construction.
 *
 *  2. THE PAYLOAD, and this is the load-bearing half. Desktop's local detail
 *     reader is the canonical unmeasured producer: it emits usage rows shaped
 *     `{ sessionId, invocationCount }` with NO `branchName` key at all
 *     (`shared-agent-components-api.ts`), because it has no branch-attribution
 *     projection, and returns `branchesTab: []` outright. So this surface
 *     reaches the ISS-5529 state through ordinary, real local data rather than
 *     through a skewed or truncated payload — which is exactly the defect as
 *     reported, and only a launched app reading a seeded local store can
 *     observe it rather than assume it.
 *
 * Both sides of the gate are asserted. The toggle-OFF half is load-bearing
 * twice: this ships dark under ISS-4779, so "no perceivable change with the
 * gate off" IS the contract, and it is also what proves the "No branches yet"
 * locator resolves at all — without which the gate-ON absence assertion would
 * pass vacuously against a detail page that simply failed to mount.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import { AGENTS_BRANCH_USAGE_SIGNAL_STATES_FLAG_KEY } from "@repo/api/src/types/agents-branch-usage-signal-states-flag.ts";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";
import { waitForAgentComponentsSchema } from "./helpers/seed-agent-components-db";

const DESKTOP_VIEWPORT = { height: 1000, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

const COMPONENT_KEY = "iss-5529-desktop-unmeasured-branches";
const COMPONENT_NAME = "ISS-5529 Desktop Unmeasured Branches";
const COMPONENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  COMPONENT_KEY
);

/** The honest third state: measured nothing, so it denies nothing. */
const BRANCHES_UNAVAILABLE_TITLE = "Branches unavailable";
const BRANCHES_UNAVAILABLE_BODY =
  "This data source couldn't report the branches for this component.";
/** The denial this local payload cannot support — the reported defect. */
const NO_BRANCHES_TITLE = "No branches yet";
/** The OTHER unavailable arm: attribution exists, rows are not hydrated. */
const BRANCH_DETAILS_UNAVAILABLE_TITLE = "Branch details unavailable";

/**
 * Sessions that really invoked the component, with real cost.
 *
 * The usage is deliberately NON-empty: it proves the Branches tab is unmeasured
 * because the local reader has no branch-attribution projection, not because
 * this corpus has nothing to attribute. An empty corpus would make the
 * unmeasured state indistinguishable from an empty-database artifact — and
 * would in fact be a MEASURED zero, the opposite arm.
 */
function seededCorpus(): AgentComponentUsageCorpus {
  const sessions = Array.from({ length: 3 }, (_unused, index) => ({
    sessionId: `iss-5529-desktop-session-${index}`,
    name: `ISS-5529 desktop session ${index + 1}`,
    linesAdded: 180,
    linesRemoved: 20,
    costUsd: 3.25,
  }));
  return {
    sessions,
    components: [
      {
        id: "iss-5529-desktop-component",
        key: COMPONENT_KEY,
        name: COMPONENT_NAME,
        usage: sessions.map((session) => ({
          sessionId: session.sessionId,
          invocations: 4,
        })),
      },
    ],
  };
}

test.describe("Agent detail Branches tab, desktop gate ON (ISS-5529)", () => {
  test("does not deny branches the local reader never measured", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: true, prefix: "iss-5529-on" },
      async (page) => {
        await openBranchesTab(page);

        // Positive control: the Branches PANEL is what the assertions below
        // read — not a page that failed to mount, and not the Sessions tab's
        // own empty state.
        await expect(tabTrigger(page, "Branches")).toHaveAttribute(
          "aria-selected",
          "true"
        );

        await expect(panelText(page, BRANCHES_UNAVAILABLE_TITLE)).toHaveCount(
          1
        );
        await expect(panelText(page, BRANCHES_UNAVAILABLE_BODY)).toHaveCount(1);

        // The defect: a confident denial from a producer with no branch
        // projection at all.
        await expect(panelText(page, NO_BRANCHES_TITLE)).toHaveCount(0);
        // Nor may it claim branches exist — no row here names one.
        await expect(
          panelText(page, BRANCH_DETAILS_UNAVAILABLE_TITLE)
        ).toHaveCount(0);
      }
    );
  });
});

test.describe("Agent detail Branches tab, desktop gate OFF (ISS-4779 dark launch)", () => {
  test("keeps the shipped denial exactly where it shipped", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: false, prefix: "iss-5529-off" },
      async (page) => {
        await openBranchesTab(page);

        // The defect, rendered on this surface. This is what makes the gate-ON
        // assertions real: the SAME locator resolves here, so its absence there
        // is a suppression and not a dead selector.
        await expect(panelText(page, NO_BRANCHES_TITLE)).toHaveCount(1);
        await expect(panelText(page, BRANCHES_UNAVAILABLE_TITLE)).toHaveCount(
          0
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Navigation and locators
// ---------------------------------------------------------------------------

/**
 * Deep-link to the seeded component's Branches tab and wait for the detail to
 * resolve, so no assertion can pass against a loading state or a "Component not
 * found".
 *
 * Pinned to the PAGE heading three ways, for the reason the
 * `agent-detail-tab-permalink` twin documents: this shell ALSO renders
 * `optimization-analytics-panel.tsx`'s `<h2>Optimization · {name}</h2>` for the
 * same component, and Playwright matches an accessible name as a
 * case-insensitive SUBSTRING unless told otherwise — so an unqualified `{ name }`
 * matches both and throws a strict-mode violation before any assertion runs.
 */
async function openBranchesTab(page: Page): Promise<void> {
  await gotoHash(page, `/agents/${COMPONENT_SLUG}?tab=branches`);
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: COMPONENT_NAME })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
}

function tabTrigger(page: Page, name: string): Locator {
  return page.getByRole("tab", { exact: true, name });
}

/**
 * Text inside the ACTIVE tab panel.
 *
 * Scoped to `role="tabpanel"` so copy rendered anywhere else on the detail (the
 * header, a metric card, another tab's retained DOM) can never stand in for the
 * Branches body — the substitution that would make "the Branches tab said X"
 * true of a page whose panel is blank.
 */
function panelText(page: Page, text: string): Locator {
  return page.getByRole("tabpanel").getByText(text, { exact: true });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Launch once to migrate the store, seed with the app DOWN, then relaunch and
 * run. Mirrors `agent-detail-honesty.spec.ts` — a running app does not reliably
 * observe a test-process write, while reading the committed schema across
 * processes is fine.
 *
 * The gate is seeded on BOTH launches because `seedE2eDesktopSettings` rewrites
 * the settings file each time. CLAUDE_HOME / CODEX_HOME are empty temp dirs so
 * the boot collectors ingest nothing and the only inventory rows are seeded.
 */
async function withSeededDesktop(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
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
        [AGENTS_BRANCH_USAGE_SIGNAL_STATES_FLAG_KEY]: true,
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

    await seedAgentComponentUsage(userDataDir, seededCorpus());

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
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
