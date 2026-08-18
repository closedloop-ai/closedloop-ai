/**
 * E2E proof (ISS-5061): the closed-by-default gate on the "Agent Collaboration
 * Network" dashboard row reaches the DESKTOP adapter — the row is ENTIRELY
 * ABSENT with the Labs toggle off, and renders with it on.
 *
 * THIS GATE IS DELIBERATELY RE-INTRODUCED. ISS-5061 first shipped the row
 * closed-by-default; ISS-5280 (#4482) then retired the flag to its enabled state
 * as an approved rollout, deleting the shared key module along with this Labs
 * toggle. The operator has since asked for this ONE flag of that batch to come
 * back, so the row ships gated again, default OFF, on both surfaces. The other
 * ten flags ISS-5280 retired stay retired — this spec is not licence to revive
 * them.
 *
 * The Electron half of the pair; the web half is
 * `e2e/dashboard-agent-collaboration-gate.spec.ts`.
 * `packages/app/AGENTS.md` requires real-surface coverage on every adapter that
 * MOUNTS the surface, and this row is mounted by both — the desktop renderer via
 * `FirstLaunchDashboard` → `DashboardRowContent`, and the web dashboard via
 * `InsightsOverviewDashboard` → the same `DashboardRowContent`. The two shells
 * feed that shared component through DIFFERENT data paths — local SQLite over
 * IPC here, HTTP + the web API client there — and resolve the SAME flag key
 * through DIFFERENT flag ports (the Labs-backed renderer adapter here, PostHog
 * there). One passing therefore tells you nothing about the other: a regression
 * in either port, or in either data path, is invisible from the far side.
 *
 * WHY THE SEED POPULATES THE PIPELINE IN BOTH PASSES. The row carries TWO
 * independent reasons to disappear, and conflating them would make the
 * closed-gate assertion vacuous:
 *   - the GATE (`isDashboardRowEnabled` / `dashboardRowsFor`, plus the render
 *     boundary in `DashboardRowContent`), the subject of this spec; and
 *   - a data-driven filter (`hasAgentPipelineNodes`) that drops the row once the
 *     Agents section resolves with no pipeline NODES, so an install whose
 *     sessions spawn no subagents does not carry a permanent 340px empty card.
 * The `agents` rows below are seeded ONCE, before either gated launch, so both
 * passes read the same non-empty `agentPipeline.nodes`. With data present, the
 * only thing that can remove the row is the gate.
 *
 * WHAT "ABSENT" MEANS HERE, precisely: no card, no skeleton, no grid slot. The
 * closed pass asserts the row's `data-tour` slot is gone AND that neither the
 * graph's own "No agent collaboration data for this period yet." empty state nor
 * the "Agent Collaboration Network" heading is anywhere on the page — a
 * degraded-to-empty-state row would tell the user there is no data when the
 * feature is simply off, which is the exact failure this gate exists to avoid.
 *
 * The neighbouring `models` and `prs` rows are asserted present in BOTH passes.
 * That is what makes the closed-pass absence a targeted gate rather than a
 * broken dashboard — and the models row is a doubly useful anchor, because
 * `ROW_SECTIONS` gives it the SAME single dependency the pipeline row has
 * (`InsightsSection.Agents`). Its chart having painted proves that section is
 * settled, so the missing row cannot be a still-loading skeleton.
 *
 * ON THE INLINE `agents` SEED. Every other table this spec needs has a shared
 * helper and uses it (`seedSessionsList`, `seedModelUsage`, `waitForBranchesSchema`),
 * and the SQLite plumbing here is the shared `desktop-seed-core` primitives, not
 * a re-implementation. Only the one `INSERT INTO agents` has no owning helper
 * today — `seed-agent-components-db.ts` and `seed-agent-component-usage-db.ts`
 * write the component tables, not this one — so it lives here rather than
 * expanding an unrelated module. `sessions-local-attribution-compat.spec.ts` is
 * the precedent for a spec-local seed over those same primitives. The rows are
 * exactly what `local-insights.ts` reads for the pipeline graph: nodes group by
 * `subagent_type`, edges come from the `parent_agent_id` self-join, and both are
 * bounded by the owning session's `started_at`.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect, type Page, test } from "@playwright/test";
import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  dismissDesktopOnboardingOverlay,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  waitForTablesPresent,
} from "./helpers/desktop-seed-core";
import { insightsTrendSeedAt } from "./helpers/insights-trend-seed";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import { seedModelUsage } from "./helpers/seed-model-usage-db";

const SESSION_ID = "iss-5061-agent-collaboration-gate-session";
const SEEDED_DURATION_MS = 30 * 60_000;
// ISS-6268: relative to the run clock, never an absolute date — the Insights
// trend window is a ROLLING 90 days even on "All time", so a literal seed
// silently ages out and empties this chart. Both ends come off ONE base instant
// so the span cannot straddle a millisecond.
const SEEDED_START = insightsTrendSeedAt();
const SEEDED_AT = SEEDED_START.toISOString();
const SEEDED_ENDED_AT = new Date(
  SEEDED_START.getTime() + SEEDED_DURATION_MS
).toISOString();

// The visible `SectionHeader` heading `AgentCollaborationNetwork` draws, and the
// `Graph` primitive's empty message it draws INSTEAD when it has no nodes.
const ROW_HEADING = "Agent Collaboration Network";
const GRAPH_EMPTY_MESSAGE = "No agent collaboration data for this period yet.";

const AGENT_PIPELINE_ROW = '[data-tour="agent-pipeline"]';
const MODELS_ROW = '[data-tour="models"]';
const PRS_ROW = '[data-tour="prs"]';

/** Two models, so the neighbour anchor draws a deterministic band count. */
const MODELS = ["claude-opus-4-5", "gpt-5.4"] as const;

const AGENTS_REQUIRED_TABLES = ["sessions", "agents"] as const;

const ROOT_AGENT_ID = "iss-5061-agent-root";

/**
 * One root agent plus two children that hand off from it.
 *
 * `subagentType` becomes the graph's node identity and `parentAgentId` its
 * edges, so this shape yields three nodes and two weighted hand-offs — a
 * genuinely populated collaboration graph rather than a single orphan node.
 */
type PipelineAgentSeed = {
  id: string;
  subagentType: string;
  parentAgentId: string | null;
};

const PIPELINE_AGENTS: readonly PipelineAgentSeed[] = [
  { id: ROOT_AGENT_ID, subagentType: "orchestrator", parentAgentId: null },
  {
    id: "iss-5061-agent-reviewer",
    subagentType: "code-reviewer",
    parentAgentId: ROOT_AGENT_ID,
  },
  {
    id: "iss-5061-agent-tester",
    subagentType: "test-engineer",
    parentAgentId: ROOT_AGENT_ID,
  },
];

/**
 * Write the `agents` rows the local pipeline rollup reads.
 *
 * Call while the app is DOWN, between launches — the db host runs its migrations
 * asynchronously after launch, so `waitForTablesPresent` is what makes this safe
 * to call right after the first launch closes. `status` is `completed`, which the
 * shared `AGENT_SUCCESS_STATUS_TERMS` LIKE-matching counts as a success, so the
 * nodes carry a real success rate rather than an unfinished 100%.
 */
async function seedPipelineAgents(
  userDataDir: string,
  sessionId: string,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForTablesPresent(
      client,
      AGENTS_REQUIRED_TABLES,
      options.schemaTimeoutMs ?? 30_000
    );

    await client.batch(
      PIPELINE_AGENTS.map((agent) => ({
        sql: `INSERT INTO agents
                (id, session_id, name, subagent_type, type, status,
                 started_at, ended_at, updated_at, parent_agent_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          agent.id,
          sessionId,
          agent.subagentType,
          agent.subagentType,
          agent.subagentType,
          "completed",
          SEEDED_AT,
          SEEDED_ENDED_AT,
          SEEDED_ENDED_AT,
          agent.parentAgentId,
        ],
      })),
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Open the Dashboard and settle it on the SAME insights section the gated row
 * reads.
 *
 * `ROW_SECTIONS` maps both `models` and `agent-pipeline` to
 * `InsightsSection.Agents`, so a painted model chart proves that section has
 * resolved — which is what makes the closed pass's absence assertion a gate
 * result and not a snapshot of a row that had not loaded yet. Recharts animates
 * areas in, so this gates on a retrying count before anything else is read.
 */
async function openDashboard(page: Page): Promise<void> {
  await gotoNav(page, "dashboard");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: "Welcome to Closedloop",
    })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No agent sessions yet")).toHaveCount(0);
  await dismissDesktopOnboardingOverlay(page);
  // Widen to "All time" so the past-dated seed is in range regardless of the
  // run clock.
  await page.locator('[aria-label="All time"]:visible').click();
  await expect(page.locator(`${MODELS_ROW} .recharts-area`)).toHaveCount(
    MODELS.length,
    { timeout: 45_000 }
  );
}

/** The neighbouring rows, asserted in both passes: the gate is targeted. */
async function expectNeighbourRowsPresent(page: Page): Promise<void> {
  await expect(page.locator(MODELS_ROW)).toHaveCount(1);
  await expect(page.locator(PRS_ROW)).toHaveCount(1);
}

test.describe("Dashboard Agent Collaboration Network gate (ISS-5061)", () => {
  test("hides the collaboration row on the desktop dashboard until the Labs toggle opens it", async () => {
    test.setTimeout(300_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5061-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5061-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5061-udd-")
    );

    try {
      // Launch 1 — migrate the schema and skip the first-launch reveal/tour.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await first.page.evaluate(
          ([onboardedKey, tourSeenKey]) => {
            localStorage.setItem(onboardedKey, "1");
            localStorage.setItem(tourSeenKey, "1");
          },
          [dashboardOnboardedStorageKey, dashboardTourSeenStorageKey]
        );
      } finally {
        await first.cleanup();
      }

      // Seed while the app is DOWN: one substantive session, the per-model
      // `token_usage` rows the neighbour anchor needs, and the collaboration
      // agents. Seeded ONCE so both gated launches read identical data.
      await seedSessionsList(userDataDir, [
        { sessionId: SESSION_ID, at: SEEDED_AT, name: "ISS-5061 collab seed" },
      ]);
      await seedModelUsage(userDataDir, {
        models: MODELS,
        sessionId: SESSION_ID,
      });
      await seedPipelineAgents(userDataDir, SESSION_ID);

      // Launch 2 — gate CLOSED. This is the registry default: no
      // `seedDesktopFeatureFlags` call, so the profile resolves the Labs toggle
      // to its shipped OFF value.
      const closed = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openDashboard(closed.page);

        // The row does not exist: no card, no skeleton, no grid slot.
        await expect(closed.page.locator(AGENT_PIPELINE_ROW)).toHaveCount(0);
        // And it did not degrade to the graph's own empty state, which would
        // claim there is no collaboration data when the feature is merely off —
        // the seeded agents are in the database the whole time.
        await expect(closed.page.getByText(GRAPH_EMPTY_MESSAGE)).toHaveCount(0);
        await expect(
          closed.page.getByRole("heading", { name: ROW_HEADING })
        ).toHaveCount(0);
        // The dashboard itself still mounted.
        await expectNeighbourRowsPresent(closed.page);

        expect(closed.pageErrors).toEqual([]);
      } finally {
        await closed.cleanup();
      }

      // Launch 3 — gate OPEN via the desktop Labs registry.
      const open = await launchDesktopApp({
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {
            [AGENT_COLLABORATION_NETWORK_FLAG_KEY]: true,
          });
        },
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openDashboard(open.page);

        // The row exists, and draws its real heading.
        await expect(open.page.locator(AGENT_PIPELINE_ROW)).toHaveCount(1);
        await expect(
          open.page.locator(AGENT_PIPELINE_ROW).getByRole("heading", {
            name: ROW_HEADING,
          })
        ).toBeVisible({ timeout: 30_000 });
        // Still not the empty state: the same seeded agents drove both passes,
        // so launch 2's absence was the gate and nothing else.
        await expect(open.page.getByText(GRAPH_EMPTY_MESSAGE)).toHaveCount(0);
        await expectNeighbourRowsPresent(open.page);

        await open.page.screenshot({
          fullPage: true,
          path: test
            .info()
            .outputPath("dashboard-agent-collaboration-gate.png"),
        });

        expect(open.pageErrors).toEqual([]);
      } finally {
        await open.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
