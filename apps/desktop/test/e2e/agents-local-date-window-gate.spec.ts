/**
 * ISS-6888 — the desktop date-window rollout gate, through the LAUNCHED app.
 *
 * WHY A LAUNCHED-APP CASE (whitlockk review on #6725)
 * ----------------------------------------------
 * `agents-date-window-gate.test.tsx` renders `DesktopAgentsDateWindowGate`
 * under `AppCoreStoryProviders` and asserts both arms of the gate. That covers
 * the gate IN ISOLATION and nothing else: the wrapper's position in `App.tsx`
 * and the path the PostHog assignment takes to `DesktopFeatureFlagProvider` are
 * both outside its tree, so BOTH of its arms stay green if the wrapper moves
 * above the real adapter or the assignment never arrives — the exact false
 * green that shipped once already in this change's own history, where the gate
 * sat inside `DesktopAppCoreProvider` and read the static all-off adapter
 * forever.
 *
 * Only a launched app can fail on that, so this spec drives the real chain:
 * seeded PostHog assignment → `DesktopFeatureFlagProvider` → the gate wrapping
 * the Agents route → the local source's `honorsDateWindow` declaration → the
 * shared list's two window-relative reads → pixels.
 *
 * WHAT THE SEEDED CORPUS PROVES
 * -----------------------------
 * Two EPOCHS, which is what makes both halves of the capability observable at
 * once and neither assertion satisfiable by a reader that ignored its window:
 *
 *   in-window   1 component, invoked 2 days ago  → inside "Last 30 days"
 *   prior       2 components, invoked 45 days ago → inside the PRECEDING window
 *
 * With the gate OPEN the summary cards compare 1 against 2 and render a real
 * −50% captioned "vs prev 30 days", and the two idle components keep their
 * Source options as zero-count entries. With it CLOSED the delta is absent
 * entirely (never a fabricated 0%) and the idle options are withheld. One
 * flag is the only difference between the two cases.
 *
 * The prior population is deliberately LARGER than the current one: a baseline
 * of equal size would render 0%, which is indistinguishable from the fabricated
 * 0% the closed arm exists to prevent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AGENTS_LOCAL_DATE_WINDOW_FLAG_KEY } from "../../../../packages/api/src/types/agents-local-date-window-flag";
import {
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  selectDesktopDateRange,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";
import { waitForAgentComponentsSchema } from "./helpers/seed-agent-components-db";

/**
 * The BOUNDED page-data read, which is the branch that carries both window
 * asks in ONE request (`prevStart`/`prevEnd` and `unwindowedFacetUniverse`).
 *
 * Seeded as a LITERAL for the reason its sibling specs spell it out: the
 * canonical constant lives behind an extension-less `@repo/api/src/types/...`
 * specifier that Playwright's ESM loader cannot resolve, and a spec-level
 * import failure aborts the WHOLE desktop-e2e suite at load time. Pinned
 * against the canonical constant by `labs-setting-key-ledger.test.ts`.
 *
 * The gate under test is NOT spelled that way: `agents-local-date-window` has
 * no Labs alias (Labs toggles are retired; ISS-8753 made the renderer resolve
 * the signed-in user's PostHog assignment), and its own flag-key module is
 * dependency-free, so it is imported for real above.
 */
const BOUNDED_PAGE_DATA_FLAG_KEY = "agents-bounded-page-data";

const AGENTS_SEARCH_LABEL = "Search components";
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const IN_WINDOW_DAYS_AGO = 2;
const PRIOR_DAYS_AGO = 45;
/**
 * Anchored to the RUN CLOCK, never to a literal. A pinned calendar date ages
 * out of the rolling 30-day window and reds this spec from some future UTC
 * midnight onward, which reads as a render regression rather than as a stale
 * fixture. Nothing below asserts a date.
 */
const NOW_MS = Date.now();
const IN_WINDOW_ISO = new Date(
  NOW_MS - IN_WINDOW_DAYS_AGO * DAY_MS
).toISOString();
const PRIOR_ISO = new Date(NOW_MS - PRIOR_DAYS_AGO * DAY_MS).toISOString();

/** The one component invoked inside the selected window. */
const IN_WINDOW_KEY = "iss6888-in-window";
/** The two invoked only in the PRECEDING window, and idle in the current one. */
const IDLE_KEYS = ["iss6888-idle-a", "iss6888-idle-b"] as const;

/**
 * The Source facet lists a component's org-identity slug (`kind::key` rendered
 * as `kind:key`), not its repo URL — read off the launched app rather than
 * assumed, because a facet option addressed by the wrong string would make the
 * withheld-option assertion pass for the wrong reason.
 */
const sourceOption = (key: string) => new RegExp(`^subagent:${key}\\b`);

/** The Source facet GROUP row, which opens the option list. */
const SOURCE_FACET_GROUP = /^Source/;

/** The caption the delta chip carries once a real baseline exists. */
const DELTA_CAPTION = "vs prev 30 days";
/** The magnitude of that delta for this corpus: 1 component against 2. */
const DELTA_MAGNITUDE = "50%";

function corpusAt(
  keys: readonly string[],
  label: string
): AgentComponentUsageCorpus {
  return {
    components: keys.map((key, index) => ({
      id: key,
      key,
      name: `ISS-6888 ${label} ${index}`,
      usage: [{ invocations: index + 1, sessionId: `${key}-session` }],
    })),
    sessions: keys.map((key) => ({
      costUsd: 10,
      linesAdded: 100,
      linesRemoved: 0,
      name: `ISS-6888 ${label} session`,
      sessionId: `${key}-session`,
    })),
  };
}

/**
 * The Components summary card, anchored on its own info trigger.
 *
 * `About <label>` is emitted only by `MetricCard`, so this cannot resolve the
 * narrow `AgentCard` fallback (which renders the bare label inside its own
 * `data-slot="card"`) one container breakpoint away. Same anchor the sibling
 * LOC/$ spec uses.
 */
function componentsCard(page: Page) {
  return page
    .getByRole("button", { name: "About Components" })
    .locator("xpath=ancestor::*[@data-slot='card'][1]");
}

/**
 * Launch once to migrate the store, seed BOTH epochs with the app down, then
 * relaunch and run. A running app does not reliably observe a test-process
 * write. The flags are seeded on both launches because the standard seeder
 * rewrites the profile each time.
 */
async function withSeededDesktop(
  dateWindowEnabled: boolean,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const prefix = "iss-6888-gate";
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGates = (dir: string) => {
    seedDesktopFeatureFlags(dir, { [BOUNDED_PAGE_DATA_FLAG_KEY]: true });
    // Desktop renderer flags are assignment-backed after ISS-8753, so the gate
    // under test is opened HERE and not through the Labs registry — the same
    // path a signed-in user's rollout arrives on.
    mergeE2eFeatureFlagAssignment(dir, {
      [AGENTS_LOCAL_DATE_WINDOW_FLAG_KEY]: dateWindowEnabled,
      [BOUNDED_PAGE_DATA_FLAG_KEY]: true,
    });
  };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGates,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponentUsage(
      userDataDir,
      corpusAt([IN_WINDOW_KEY], "in"),
      {
        observedAt: IN_WINDOW_ISO,
      }
    );
    await seedAgentComponentUsage(userDataDir, corpusAt(IDLE_KEYS, "idle"), {
      observedAt: PRIOR_ISO,
    });

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGates,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await run(page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

/** Land on the Agents workspace with the 30-day window selected. */
async function openAgentsInThirtyDayWindow(page: Page): Promise<void> {
  // The boot gate must settle BEFORE navigating, or the disabled-DB responder's
  // empty list is cached and the workspace pins empty.
  await waitForLocalAgentComponentList(page);
  await gotoNav(page, "agents");
  // Positive mount proof, so a navigation failure reports as such instead of as
  // "the delta never appeared".
  await expect(page.getByLabel(AGENTS_SEARCH_LABEL)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  // The workspace mounts on "All time", which has no preceding period at all —
  // neither arm of the gate can render a delta there, so the window is what
  // makes the two cases differ.
  await selectDesktopDateRange(page, DesktopDateRangeLabel.Last30Days);
  // The row the window keeps, which is also the proof the bounds were APPLIED:
  // the two idle components are out of it.
  await expect(componentsCard(page)).toContainText("1", {
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/** Open Filter → Source and leave the option list on screen. */
async function openSourceFacet(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Filter" })
    .filter({ visible: true })
    .click();
  // FilterPopover renders each row as a plain Radix `DropdownMenuItem`, so the
  // group and its options both carry role `menuitem`.
  await page.getByRole("menuitem", { name: SOURCE_FACET_GROUP }).click();
}

test.describe("Agents date-window gate, through the launched app (ISS-6888)", () => {
  test("OPEN: the summary cards compare against the preceding window and idle sources keep their options", async () => {
    // Two full Electron launches (migrate, seed with the app down, relaunch)
    // plus a schema wait, against a 60s config default. The house value for this
    // shape; ~18 sibling call sites use it. Not masking a hang — the case runs
    // in ~11s once mounted.
    test.setTimeout(180_000);
    await withSeededDesktop(true, async (page) => {
      await openAgentsInThirtyDayWindow(page);

      const card = componentsCard(page);
      // A REAL comparison: 1 in-window component against the 2 that were only
      // active in the preceding window.
      await expect(card).toContainText(DELTA_CAPTION, {
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(card).toContainText(DELTA_MAGNITUDE);

      await openSourceFacet(page);
      // The in-window source is offered at its real count...
      await expect(
        page.getByRole("menuitem", { name: sourceOption(IN_WINDOW_KEY) })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      // ...and the unwindowed universe keeps both idle ones listed, so the
      // narrowing that brings their rows back is still reachable.
      for (const key of IDLE_KEYS) {
        await expect(
          page.getByRole("menuitem", { name: sourceOption(key) })
        ).toBeVisible();
      }
      await page.keyboard.press("Escape");
    });
  });

  test("CLOSED: no delta is rendered at all, and the facet menu narrows to the window", async () => {
    // The arm that must not be satisfiable by a gate reading a static all-off
    // adapter — which is why its sibling above is the one that fails when the
    // assignment never reaches `DesktopFeatureFlagProvider`.
    test.setTimeout(180_000);
    await withSeededDesktop(false, async (page) => {
      await openAgentsInThirtyDayWindow(page);

      const card = componentsCard(page);
      // Every absence below is paired with a presence on the SAME locator, so
      // none of them can pass on a card that simply never rendered.
      await expect(card).toContainText("matched by the current filters", {
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(card).not.toContainText(DELTA_CAPTION);
      // Not a fabricated 0% either — the closed arm withholds the comparison,
      // it does not report "no change".
      await expect(card).not.toContainText("%");

      await openSourceFacet(page);
      // Same pairing on the facet menu: the in-window option is on screen, so
      // the withheld ones are absent from a menu that DID render.
      await expect(
        page.getByRole("menuitem", { name: sourceOption(IN_WINDOW_KEY) })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      for (const key of IDLE_KEYS) {
        await expect(
          page.getByRole("menuitem", { name: sourceOption(key) })
        ).toHaveCount(0);
      }
      await page.keyboard.press("Escape");
    });
  });
});
