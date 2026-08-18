/**
 * ISS-5464: cross-adapter E2E for the component detail's Sessions truncation
 * notice at the DESKTOP host. The web twin is
 * `e2e/agent-detail-sessions-truncation.spec.ts`.
 *
 * The Sessions tab is rendered by the SHARED
 * `packages/app/agents/components/workspace/detail-sessions-tab.tsx`, which the
 * Electron renderer mounts through `src/renderer/components/agents/
 * agent-detail-view.tsx` — so `packages/app/AGENTS.md` ("E2E Coverage for UI
 * Surfaces") owes this adapter its own regression, and the jsdom tests inject
 * props directly and therefore never touch either real reader.
 *
 * WHAT THIS ADAPTER PROVES THAT NO OTHER TEST CAN
 * -----------------------------------------------
 * The notice's unknown-total arm used to key on
 * `AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`, a constant only the CLOUD read
 * applies. Desktop hydrates `sessionsTab` through
 * `getSharedAgentSessionsWithLocCostByIds` (`src/main/session/
 * shared-agent-sessions-api.ts`), which returns every id it can hydrate and caps
 * at NOTHING — so on this surface a delivered count equal to the cloud's bound
 * meant only "this component has that many hydrated sessions", and the tab
 * announced a truncation that had not happened.
 *
 * That is a DESKTOP-ONLY failure. It cannot be reproduced on the web twin, whose
 * producer really does cap; and it cannot be reproduced in jsdom, where the
 * payload is handed in rather than read. Only this spec drives the real local
 * reader, so only this spec can prove the false positive is gone.
 *
 * The assertion is live, not vacuous: it fails the moment the renderer goes back
 * to inferring truncation from `sessionsTab.length` against a constant instead of
 * reading the producer's explicit `sessionsTabTruncated`. Every case first
 * asserts a seeded session row is on screen, so a Sessions tab that failed to
 * mount cannot make the absence assertion pass for the wrong reason.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import { AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS } from "@repo/api/src/types/agent-component-invocation.ts";
import {
  gotoHash,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";
import { waitForAgentComponentsSchema } from "./helpers/seed-agent-components-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

const COMPONENT_KEY = "iss-5464-desktop-complete";
const COMPONENT_NAME = "ISS-5464 Desktop Complete";
const COMPONENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  COMPONENT_KEY
);

/**
 * Exactly the CLOUD payload bound
 * (`AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`), deliberately hard-coded
 * rather than imported.
 *
 * Importing it would make this spec track the constant, and tracking the
 * constant is precisely the bug: the number has no meaning on this surface. What
 * is being asserted is that a desktop payload of THIS size — the one value that
 * used to trip the old inference — says nothing, because the desktop reader
 * capped nothing to produce it.
 */
const SESSIONS_AT_THE_CLOUD_BOUND = 50;

/** Any "Showing N of M sessions" shape, so a rewording still fails the assertion. */
const ANY_TRUNCATION_NOTICE = /Showing \d[\d,]* of [\d,]+\+? sessions/;
/** The pre-fix string. Must never appear again on either surface. */
const RETIRED_NOTICE = /total unavailable/i;

/**
 * ISS-5520 (codex P1 + wongk review, #4716) — the Evidence tab at THIS adapter.
 *
 * `packages/app/AGENTS.md` ("Cover every adapter that mounts the surface") owes
 * the Evidence caption a regression on each shell that mounts `AgentDetail`, and
 * before this change no desktop e2e opened the Evidence tab at all — so the
 * whole tab could regress here without turning anything red.
 *
 * The state under test needs the LOCAL reader's own row bound to bind while its
 * count keeps counting: `readAgentComponentInvocationPage` takes `LIMIT 500`
 * over the rows and a bare uncapped `COUNT(*)` beside it, then derives
 * `hasMore: total > rows.length`. One invocation past that bound is therefore
 * the smallest corpus that produces `hasMore: true` over an exactly-known total
 * — the combination that used to print "Showing 50 of 501+ invocations" for a
 * population the query had counted precisely. Seeding 500 or fewer would leave
 * `hasMore` false and the assertion would pass with the `+` logic restored.
 */
const INVOCATIONS_ONE_PAST_THE_READ_BOUND =
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS + 1;

/** The client render cap (`AGENTS_PAGE_SIZE`), hard-coded like the bound above. */
const RENDERED_INVOCATIONS = 50;

/** The shipped caption, pinned so a regression cannot be silent. */
const EVIDENCE_NOTICE = `Showing ${RENDERED_INVOCATIONS} of ${INVOCATIONS_ONE_PAST_THE_READ_BOUND} invocations`;
/** The stats strip above the table, which must name the same population. */
const EVIDENCE_STATS_STRIP = `${INVOCATIONS_ONE_PAST_THE_READ_BOUND} recorded`;
/** Any floor-marked Evidence total. This is the regression, in any wording. */
const FLOOR_MARKED_EVIDENCE = /Showing [\d,]+ of [\d,]+\+ invocations/;
/** The empty state the tab shows when the reader returns no page at all. */
const EVIDENCE_UNAVAILABLE = "Evidence unavailable";

function sessionRowName(index: number): string {
  return `ISS-5464 desktop session ${index + 1}`;
}

/**
 * A component whose local usage is COMPLETE at the cloud's bound: every session
 * that invoked it is hydratable, so `sessionsTab` carries all of them and
 * `sessionsTabTruncated` is false.
 */
function completeCorpus(sessionCount: number): AgentComponentUsageCorpus {
  const sessions = Array.from({ length: sessionCount }, (_unused, index) => ({
    sessionId: `iss-5464-desktop-session-${index}`,
    // The Sessions tab renders the projected `row.name` verbatim, so the row is
    // locatable by text ONLY if the session carries a real name.
    name: sessionRowName(index),
    linesAdded: 10,
    linesRemoved: 2,
    costUsd: 1,
  }));
  return {
    sessions,
    components: [
      {
        id: "iss-5464-desktop-component",
        key: COMPONENT_KEY,
        name: COMPONENT_NAME,
        usage: sessions.map((session) => ({
          sessionId: session.sessionId,
          invocations: 3,
        })),
      },
    ],
  };
}

/**
 * A component whose invocation corpus runs one row PAST the local reader's row
 * bound, on a single session — so `readAgentComponentInvocationPage` delivers
 * 500 rows against a `COUNT(*)` of 501.
 */
function heavyInvocationCorpus(invocations: number): AgentComponentUsageCorpus {
  const session = {
    sessionId: "iss-5520-desktop-session",
    name: sessionRowName(0),
    linesAdded: 10,
    linesRemoved: 2,
    costUsd: 1,
  };
  return {
    sessions: [session],
    components: [
      {
        id: "iss-5520-desktop-component",
        key: COMPONENT_KEY,
        name: COMPONENT_NAME,
        usage: [{ sessionId: session.sessionId, invocations }],
      },
    ],
  };
}

test.describe("Agent detail Evidence total, desktop adapter (ISS-5520)", () => {
  test("states the EXACT invocation total when the local row read was bounded", async () => {
    await withSeededDesktop(
      heavyInvocationCorpus(INVOCATIONS_ONE_PAST_THE_READ_BOUND),
      async (page) => {
        await gotoHash(page, `#/agents/${COMPONENT_SLUG}`);

        // Gate on the detail actually resolving before touching the tab.
        await expect(page.getByText(sessionRowName(0)).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        await page.getByRole("tab", { name: "Evidence" }).click();

        // Positive control: the local reader returned a real page and the grid
        // mounted it. Without this the absence assertions below would pass
        // against the "Evidence unavailable" empty state — the exact false green
        // that `total === 0` short-circuit produced.
        await expect(page.getByText(EVIDENCE_UNAVAILABLE)).toHaveCount(0);
        await expect(
          page.getByText(EVIDENCE_STATS_STRIP, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The fix: the row read WAS bounded (`hasMore` is true), but the
        // `COUNT(*)` beside it was not, so the population is stated exactly.
        await expect(page.getByText(EVIDENCE_NOTICE)).toBeVisible();
        await expect(page.getByText(FLOOR_MARKED_EVIDENCE)).toHaveCount(0);
      }
    );
  });
});

test.describe("Agent detail Sessions truncation, desktop adapter (ISS-5464)", () => {
  test("does not announce a truncation the local reader never made", async () => {
    await withSeededDesktop(
      completeCorpus(SESSIONS_AT_THE_CLOUD_BOUND),
      async (page) => {
        await gotoHash(page, `#/agents/${COMPONENT_SLUG}`);

        // Positive control: the Sessions tab really mounted seeded rows, so the
        // absence assertion below cannot pass against an empty state.
        await expect(page.getByText(sessionRowName(0)).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The whole point: nothing was dropped, so nothing is claimed.
        await expect(page.getByText(ANY_TRUNCATION_NOTICE)).toHaveCount(0);
        await expect(page.getByText(RETIRED_NOTICE)).toHaveCount(0);
      }
    );
  });

  test("stays silent for a small complete payload too", async () => {
    // The control that proves the assertion above is about the BOUND and not
    // about the notice being globally unreachable on this surface.
    await withSeededDesktop(completeCorpus(4), async (page) => {
      await gotoHash(page, `#/agents/${COMPONENT_SLUG}`);

      await expect(page.getByText(sessionRowName(0)).first()).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(page.getByText(ANY_TRUNCATION_NOTICE)).toHaveCount(0);
    });
  });
});

/**
 * Launch once to migrate the store, seed with the app DOWN, then relaunch and
 * run. Mirrors `agents-loc-per-dollar-display.spec.ts` — a running app does not
 * reliably observe a test-process write, while reading the committed schema
 * across processes is fine.
 */
async function withSeededDesktop(
  corpus: AgentComponentUsageCorpus,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const prefix = "iss-5464-desktop";
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
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponentUsage(userDataDir, corpus);

    const { page, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // NOT optional, and the reason this spec is a detail-route adapter rather
      // than a grid one: during the boot window the renderer is served by a
      // DISABLED db responder, and the query client caches that empty answer
      // FOREVER. Navigating to the detail hash before the real local responder
      // is live therefore pins a permanent "Component not found" — an empty page
      // on which the truncation-absence assertions below would pass vacuously,
      // which is exactly the false green this spec exists to rule out. Polling
      // the real `listAgentComponents` IPC proves the responder is live before
      // any navigation. (Same gate `agents-loc-per-dollar-display.spec.ts` takes
      // before opening the Agents grid.)
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
