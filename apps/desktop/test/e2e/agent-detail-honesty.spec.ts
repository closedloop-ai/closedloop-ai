/**
 * ISS-5519: cross-adapter E2E for the `agents-detail-honesty` Labs gate on the
 * component detail metric strip at the DESKTOP host. The web twin is
 * `e2e/agent-detail-honesty.spec.ts`.
 *
 * The metric strip is rendered by the SHARED
 * `packages/app/agents/components/workspace/agent-detail.tsx`, which the Electron
 * renderer mounts through `src/renderer/components/agents/agent-detail-view.tsx`
 * — so `packages/app/AGENTS.md` ("E2E Coverage for UI Surfaces") owes this
 * adapter its own regression, and the jsdom suites inject both the payload and
 * the flag as props and therefore touch neither real boundary.
 *
 * WHAT THIS ADAPTER PROVES THAT NO OTHER TEST CAN
 * -----------------------------------------------
 * Two things, and they are independent:
 *
 *  1. THE FLAG. The packaged renderer has no PostHog wiring, so it resolves this
 *     key from its own Labs registry. A split key — or a shared key that simply
 *     never got registered here — would land the change on web and leave desktop
 *     dark forever, or (worse, since an unregistered shared key falls through to
 *     the build-type default) leak it on desktop while it is hidden on web. Only
 *     a launched app can prove the registered toggle actually drives the render.
 *
 *  2. THE PAYLOAD. "Lines shipped" and "Total cost" reduce over `branchesTab`,
 *     and the desktop detail producer sends `branchesTab: []` OUTRIGHT — it does
 *     not merely send unmeasured rows the way the cloud read does. So on this
 *     surface the two cards are structurally incapable of carrying a value, and
 *     the local reader is the only place that fact can be observed rather than
 *     assumed.
 *
 * Both sides of the gate are asserted. The toggle-OFF half is load-bearing: this
 * ships dark under ISS-4779, so "no perceivable change with the toggle off" is
 * the contract — and it is also what proves the labels resolve at all, without
 * which the toggle-ON absence assertions would pass vacuously against a detail
 * page that simply failed to mount.
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT COVER
 * ------------------------------------------
 * The "Merged PRs" card (ISS-5521, ungated by ISS-6462). The desktop LOCAL
 * component-detail producer spreads `EMPTY_COHORT_DELIVERY_METRICS`
 * (`src/main/dashboard/shared-agent-components-api.ts`), so `mergedPrs` is
 * always `null` here and the card always renders the em-dash — there is no
 * capped count for this surface to disclose, and a seeded one would be a
 * fixture asserting itself. Its coverage is the web twin, which reads a cloud
 * payload that can carry the flag.
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

/**
 * The desktop Labs key gating this pass. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (same note as `agents-source-provenance.spec.ts`). The copy is
 * pinned by the ISS-5518/5519/5521 case in
 * `apps/desktop/test/feature-flags-shared-ui.test.ts`, which asserts this exact
 * string against `AGENTS_DETAIL_HONESTY_FLAG_KEY`, so a rename fails there
 * rather than silently leaving this spec seeding a key nothing reads.
 */
const DETAIL_HONESTY_FLAG_KEY = "agents-detail-honesty";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

/**
 * SUBAGENT specifically, and it is the seed helper's default kind for the same
 * reason: `componentMetrics` renders the "Lines shipped" / "Total cost" pair for
 * this kind alone, and it is also the only kind whose `LOC / $` is verifiable —
 * the adjacency that made the two dashes read as that ratio's missing operands.
 */
const COMPONENT_KEY = "iss-5519-desktop-honest";
const COMPONENT_NAME = "ISS-5519 Desktop Honest";
const COMPONENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  COMPONENT_KEY
);

/** The two cards that reduce over the desktop producer's empty `branchesTab`. */
const LINES_SHIPPED_LABEL = "Lines shipped";
const TOTAL_COST_LABEL = "Total cost";
/** Present in every state — the card the suppression must NOT reach. */
const LOC_PER_DOLLAR_LABEL = "LOC / $";
/** The dash the two render with the toggle closed — the shipped defect. */
const EM_DASH = "—";

function sessionRowName(index: number): string {
  return `ISS-5519 desktop session ${index + 1}`;
}

/**
 * A component with real local usage — sessions that carry lines and cost of
 * their own.
 *
 * The measurements are deliberately NON-zero: they prove the two suppressed
 * cards are empty because the DETAIL PAYLOAD never carries branch measurements,
 * not because this corpus happens to have nothing to measure. A corpus of
 * zero-cost sessions would leave the suppression indistinguishable from an
 * empty-database artifact.
 */
function seededCorpus(): AgentComponentUsageCorpus {
  const sessions = Array.from({ length: 4 }, (_unused, index) => ({
    sessionId: `iss-5519-desktop-session-${index}`,
    // The Sessions tab renders the projected `row.name` verbatim, so the row is
    // locatable by text ONLY if the session carries a real name.
    name: sessionRowName(index),
    linesAdded: 240,
    linesRemoved: 30,
    costUsd: 4.5,
  }));
  return {
    sessions,
    components: [
      {
        id: "iss-5519-desktop-component",
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

test.describe("Agent detail honesty, desktop Labs gate ON (ISS-5519)", () => {
  test("drops the two cards the local detail can never measure", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: true, prefix: "iss-5519-on" },
      async (page) => {
        await openSeededComponentDetail(page);

        // Positive control: the metric strip really mounted. Without a card that
        // IS present, the two absence assertions below would pass against a
        // "Component not found" page just as happily.
        await expect(
          page.getByText(LOC_PER_DOLLAR_LABEL, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The fix: no dashed card sitting beside the ratio pretending to be its
        // unavailable operand.
        await expect(
          page.getByText(LINES_SHIPPED_LABEL, { exact: true })
        ).toHaveCount(0);
        await expect(
          page.getByText(TOTAL_COST_LABEL, { exact: true })
        ).toHaveCount(0);
      }
    );
  });
});

test.describe("Agent detail honesty, desktop Labs gate OFF (ISS-4779 dark-launch no-op)", () => {
  test("keeps both dashed cards exactly where they shipped", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: false, prefix: "iss-5519-off" },
      async (page) => {
        await openSeededComponentDetail(page);

        // The defect, rendered on this surface: both cards present, both dashed,
        // flanking a ratio the page states as a number. This is what makes the
        // gate-ON assertions above real — the labels resolve here, so their
        // absence there is a suppression and not a dead locator.
        const linesCard = metricCard(page, LINES_SHIPPED_LABEL);
        const costCard = metricCard(page, TOTAL_COST_LABEL);
        await expect(linesCard).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(costCard).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(linesCard).toContainText(EM_DASH);
        await expect(costCard).toContainText(EM_DASH);
      }
    );
  });
});

/**
 * Navigate to the seeded component's detail route and wait for it to resolve.
 *
 * The Sessions row gate is not optional: during the boot window the renderer is
 * served by a DISABLED db responder whose empty answer the query client caches
 * FOREVER, so a detail hash opened too early pins a permanent "Component not
 * found" — an empty page on which the absence assertions would pass vacuously.
 * (Same gate `agent-detail-sessions-truncation.spec.ts` takes.)
 */
async function openSeededComponentDetail(page: Page): Promise<void> {
  await gotoHash(page, `#/agents/${COMPONENT_SLUG}`);
  await expect(page.getByText(sessionRowName(0)).first()).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
}

/**
 * The metric card that owns `label`.
 *
 * Anchored on the card ROOT (`data-slot="card"`, from the design-system `Card`)
 * rather than a page-wide text match: the strip renders several dashes side by
 * side, so a bare `getByText("—")` proves nothing about WHICH card is empty.
 * Filtering on an EXACT label text node — not `hasText`, which is a substring
 * match — keeps one label from selecting a card that merely contains it.
 */
function metricCard(page: Page, label: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/**
 * Launch once to migrate the store, seed with the app DOWN, then relaunch and
 * run. Mirrors `agent-detail-sessions-truncation.spec.ts` — a running app does
 * not reliably observe a test-process write, while reading the committed schema
 * across processes is fine.
 *
 * The Labs flag is seeded on BOTH launches because `seedE2eDesktopSettings`
 * rewrites the settings file each time. CLAUDE_HOME / CODEX_HOME are empty temp
 * dirs so the boot collectors ingest nothing and the only inventory rows are the
 * seeded ones.
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
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, { [DETAIL_HONESTY_FLAG_KEY]: true });
    }
  };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
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
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
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
