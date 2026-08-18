/**
 * ISS-4972: cross-adapter E2E for the Agents LOC/$ display polish at the
 * DESKTOP host. The web twin is `e2e/agents-loc-per-dollar-display.spec.ts`.
 *
 * ISS-4866 shipped three halves together, and both surfaces they touch — the
 * Agents workspace (`AgentsGroupedList`) and the Sessions summary strip
 * (`SessionsSummaryCards`) — are SHARED components that mount on the Electron
 * renderer as well as the web app. ISS-5366 retired both
 * `agents-loc-per-dollar-display` and `agents-count-column-alignment` to their
 * enabled state, so this spec now seeds no Labs flag at all: it proves the
 * polish reaches the packaged renderer unconditionally, which is what the
 * retirement claims and what a web-only spec can never show.
 *
 * WHAT THIS ADAPTER CAN REACH, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------------------
 * The desktop Agents inventory is served by the LOCAL IPC
 * `AgentComponentsDataSource` (`src/main/dashboard/shared-agent-components-api.ts`),
 * which reads `agent_components` + `agent_component_session_usage` and computes
 * each row's LOC/$ from its invoking sessions' local-git LOC and cost.
 *
 * ISS-5364 corrected what used to be said here. The old wording — "there is no
 * agent-component seed helper in `test/e2e/helpers/`" — stopped being true when
 * ISS-5029 landed `seed-agent-components-db.ts`. The accurate statement is
 * narrower: a DETAIL-page seeder existed, and it writes no
 * `agent_component_session_usage` rows at all, so every list-level aggregate
 * (`invocations`, `sessions`, `locPerDollar`) came back `0 / 0 / —` on every
 * row. ISS-5364 added `seed-agent-component-usage-db.ts`, which seeds the
 * inventory rows, the usage rows, and the invoking sessions' authored-commit
 * LOC and priced spend together, so this adapter can now put genuinely
 * DIFFERENT per-row aggregates on screen.
 *
 * The ISS-4866 column-precision (`12.00`) and `< 0.01` assertions (spec items 2
 * and 3) still live on the WEB twin: those need a specific sub-threshold ratio,
 * which the web reaches by mocking the `/agent-components` read directly, while
 * here it would have to be arrived at through the real LOC-over-cost division.
 * What this adapter asserts instead is what it genuinely reaches in the packaged
 * renderer: the retired metric-mode picker (item 1), the merged-scope Sessions
 * card label (item 4), and — since ISS-5364 — the ISS-5333 header-alignment
 * regression, measured against a real layout engine.
 *
 * With no gate left there is no flag-off arm to prove each locator can fail, so
 * each assertion is anchored on a POSITIVE precondition first — the Agents
 * search box for the picker, a visible merged-scope label for the Sessions card,
 * a mounted column header and two resolved rows for the alignment cases — so a
 * surface that never mounted fails rather than satisfying an absence assertion
 * vacuously.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { LOC_PER_DOLLAR_MERGED_LABEL } from "@repo/api/src/utils/loc-per-dollar.ts";
import {
  gotoNav,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  expectRightEdgesAligned,
  gridCellIn,
  gridHeaderLabel,
  gridRowWithText,
} from "./helpers/grid-layout-measure";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

/**
 * Wider than {@link DESKTOP_VIEWPORT} for the alignment cases only. `GridTable`
 * falls back to a narrow card list below a container-width threshold, and the
 * alignment under test exists ONLY on the grid path — the desktop shell spends
 * part of the width on its sidebar, so the default viewport leaves less room for
 * nine data columns than the web twin's 1280 does. Every alignment case still
 * asserts the column HEADER is present before measuring, so a card fallback
 * fails loudly rather than measuring the wrong layout.
 */
const ALIGNMENT_VIEWPORT = { height: 1000, width: 1680 };

const MOUNT_TIMEOUT_MS = 30_000;

// The Agents toolbar's search box. Asserted before every picker check so an
// Agents workspace that failed to mount cannot make a "the picker is absent"
// assertion pass vacuously.
const AGENTS_SEARCH_LABEL = "Search components";

const METRIC_MODE_VALUE_INDEX_LABEL = "Value Index";
// The retired metric-mode picker was the only `Select` in the Agents toolbar —
// the search box is a `searchbox`, and the time-window / filter / view controls
// are buttons and popovers. Scoped by the design-system slot rather than the
// generic combobox role so renderer chrome cannot satisfy it.
const SELECT_TRIGGER_SELECTOR = '[data-slot="select-trigger"]';

// Seeded so the Sessions summary strip mounts against a real corpus rather than
// an empty one (same mechanism as `sessions-summary-strip-baseline.spec.ts`).
const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: 3 },
  (_value, index) => ({
    estimatedCost: 12.5 + index,
    name: `ISS-4972 loc-per-dollar display ${index + 1}`,
    sessionId: `iss-4972-loc-per-dollar-${index + 1}`,
  })
);

// ISS-5364: the two rows the ISS-5333 alignment case measures across.
const VALUE_COMPONENT_NAME = "acme/iss-5333-value";
const UNAVAILABLE_COMPONENT_NAME = "acme/iss-5333-unavailable";

/**
 * ISS-5364: the inventory corpus behind the ISS-5333 case.
 *
 * Both components carry REAL, and different, invocation and session counts, so
 * the count column has values of differing rendered width to align against.
 * They differ in the Metric column by their SPEND, not their churn: the
 * unavailable row's invoking session has authored LOC but no `token_usage` row,
 * so `locPerDollarFromLines` has no denominator and returns null (never a
 * fabricated 0) and the Metric cell renders its em-dash.
 *
 * `agent-component-usage-read-path.test.ts` runs this exact corpus shape through
 * the production `listAgentComponentsLocal` and asserts the projected
 * `invocations` / `sessions` / `locPerDollar`, so a change to a read predicate
 * that quietly empties this corpus fails there — headless, in seconds — instead
 * of turning these layout assertions into ones that cannot fail.
 */
const ALIGNMENT_CORPUS: AgentComponentUsageCorpus = {
  sessions: [
    {
      costUsd: 4,
      linesAdded: 900,
      linesRemoved: 100,
      sessionId: "iss-5333-priced-session",
    },
    {
      // No `costUsd` — the unavailable-metric control.
      linesAdded: 40,
      linesRemoved: 10,
      sessionId: "iss-5333-unpriced-session",
    },
  ],
  components: [
    {
      id: "iss-5333-value",
      key: "iss-5333-value",
      name: VALUE_COMPONENT_NAME,
      // Four digits against the unavailable row's one, so the two count cells
      // have visibly different widths and a shared right edge is real evidence.
      usage: [{ invocations: 1234, sessionId: "iss-5333-priced-session" }],
    },
    {
      id: "iss-5333-unavailable",
      key: "iss-5333-unavailable",
      name: UNAVAILABLE_COMPONENT_NAME,
      usage: [{ invocations: 8, sessionId: "iss-5333-unpriced-session" }],
    },
  ],
};

test.describe("Agents LOC/$ display polish (ISS-4866/ISS-4972)", () => {
  test("retires the metric picker and names the merged Sessions card", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { prefix: "iss-4972-unconditional" },
      async (page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);

        await gotoNav(page, "agents");
        await expect(page.getByLabel(AGENTS_SEARCH_LABEL)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // (1) The retired picker: its second option rendered the identical
        // value, and the column header already names the metric it shows. The
        // search-box assertion above is this absence check's precondition — it
        // proves the toolbar this `Select` would live in actually rendered.
        await expect(page.locator(SELECT_TRIGGER_SELECTOR)).toHaveCount(0);
        await expect(
          page.getByText(METRIC_MODE_VALUE_INDEX_LABEL, { exact: true })
        ).toHaveCount(0);

        // (4) The merged-scope card names the population it computes over, in
        // the packaged renderer with no Labs flag seeded at all — the second
        // surface a web-only spec can never exercise.
        await gotoNav(page, "sessions");
        await expect(
          page.getByText(LOC_PER_DOLLAR_MERGED_LABEL, { exact: true }).first()
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      }
    );
  });
});

/**
 * ISS-5333 at the DESKTOP host (ISS-5364). The web twin's describe block is
 * "Agents right-aligned header labels (ISS-5333)".
 *
 * `packages/app/AGENTS.md` requires a UI bug fix to ship an e2e regression on
 * EVERY adapter that mounts the surface, and `AgentsGroupedList` mounts on the
 * Electron renderer as well as the web app. This half could not be written until
 * ISS-5364 gave the desktop corpus real per-row usage aggregates: the two
 * defects ISS-5333 fixed are only observable across rows whose values differ.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT A CLASS ASSERTION
 * ----------------------------------------------------
 * Both defects were INVISIBLE to `toHaveClass("justify-end")`. The class was on
 * the header cell the whole time; a sortable header wraps its label in a
 * `flex-1` button that consumed the cell, so the cell had no free space to
 * distribute and the label provably never moved. The sibling vitest suite
 * (`agents-count-column-alignment.test.tsx`) replaced that assertion with a
 * predicate that EXECUTES the flexbox rule over the DOM, because jsdom has no
 * layout engine. Here there is a real one, so this measures the thing itself:
 * bounding boxes, in a driven browser.
 *
 * ISS-5366 REMOVED THE SECOND CASE THIS BLOCK USED TO CARRY, AND WHY
 * -----------------------------------------------------------------
 * A companion case ("leaves the metric column ragged while only the count gate
 * is on") existed to prove the two keys could not be conflated: it drove
 * `agents-count-column-alignment` ON with `agents-loc-per-dollar-display` OFF
 * and asserted the Metric column had NOT moved. ISS-5366 retired BOTH keys to
 * enabled, so that mixed state is no longer reachable and the case could only be
 * kept by asserting something now false. It is deleted rather than skipped, in
 * line with every other flag-off arm this retirement removes. No unique coverage
 * is lost: its one assertion about the unavailable dash is the same pair the
 * surviving case measures, in the aligned direction that is now always correct.
 *
 * WHAT THIS ADAPTER STILL CANNOT REACH
 * ------------------------------------
 * The web twin also asserts the em-dash in the COUNT columns lands under the
 * digits it stands in for. That case is unreachable on desktop at ANY seeding,
 * and not for want of a fixture: `listAgentComponentsLocal` projects absent
 * usage as `invocations: resolved?.invocations ?? 0`, so a desktop row with no
 * usage renders the NUMBER 0, never null, and `NumberCell` renders its em-dash
 * only on `value === null`. Asserting it here would be an assertion that cannot
 * fail. The Metric column's em-dash IS reachable — `locPerDollar` is genuinely
 * nullable on this surface — so the dash-alignment assertion below rides on that
 * column, over a row whose invoking session carries no priced spend.
 */
test.describe("Agents right-aligned header labels, desktop adapter (ISS-5333)", () => {
  test("lands the header label and the unavailable dash on the column's values", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      {
        components: ALIGNMENT_CORPUS,
        prefix: "iss-5333",
      },
      async (page) => {
        const { valueRow, unavailableRow } = await openAgentsGrid(page);

        // A SORTABLE count column — the arm that silently did not move, because
        // its label lives inside a button that consumed the cell.
        await expectRightEdgesAligned(
          gridHeaderLabel(page, "invocations"),
          gridCellIn(valueRow, "invocations")
        );

        // The Metric column, whose header also carries a help icon. Before the
        // fix the icon and the caret were the rightmost things in the cell and
        // the label landed inboard of its own digits; they now LEAD the label.
        await expectRightEdgesAligned(
          gridHeaderLabel(page, "metric"),
          gridCellIn(valueRow, "metric")
        );

        // The unavailable metric dash sits under the digits it stands in for.
        await expectRightEdgesAligned(
          gridCellIn(unavailableRow, "metric"),
          gridCellIn(valueRow, "metric")
        );
      }
    );
  });
});

/**
 * Navigate to the Agents grid and resolve the two seeded rows.
 *
 * `waitForLocalAgentComponentList` FIRST, and it is not optional: the boot
 * window serves a disabled DB responder whose empty list the query client caches
 * forever, so navigating early pins an empty Agents workspace and every
 * measurement below fails against a frozen page rather than a wrong one.
 *
 * Then asserts the column HEADER is present before any measurement: `GridTable`
 * falls back to a narrow card list below a container-width threshold, and the
 * alignment under test exists only on the grid path, so a card fallback must
 * fail here rather than silently yield boxes from the wrong layout.
 */
async function openAgentsGrid(
  page: Page
): Promise<{ valueRow: Locator; unavailableRow: Locator }> {
  await page.setViewportSize(ALIGNMENT_VIEWPORT);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  await gotoNav(page, "agents");
  await expect(page.getByLabel(AGENTS_SEARCH_LABEL)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  await expect(
    page.locator('[role="columnheader"][data-column-id="invocations"]')
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

  const valueRow = gridRowWithText(page, VALUE_COMPONENT_NAME);
  const unavailableRow = gridRowWithText(page, UNAVAILABLE_COMPONENT_NAME);
  await expect(valueRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(unavailableRow).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  return { unavailableRow, valueRow };
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Sessions IPC source
 * reads the seeded corpus at boot. ISS-5366: no Labs flag is seeded — neither
 * gate this spec used to drive still exists.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only rows are the seeded ones (mirrors
 * `sessions-column-fold.spec.ts`).
 */
async function withSeededDesktopProfile(
  {
    prefix,
    components,
  }: {
    prefix: string;
    /**
     * ISS-5364: the agent-component inventory corpus, seeded only when a case
     * needs list-level aggregates. Omitted by the ISS-4972 case, which asserts
     * toolbar/label state and wants the inventory left as it was.
     */
    components?: AgentComponentUsageCorpus;
  },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));

  try {
    const first = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(userDataDir, SEEDED_SESSIONS);
    if (components) {
      await seedAgentComponentUsage(userDataDir, components);
    }

    const { page, cleanup } = await launchDesktopApp({
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
