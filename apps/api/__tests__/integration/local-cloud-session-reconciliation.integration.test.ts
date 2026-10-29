/**
 * ISS-9624 (PRD-666), fourth reconciliation family: LOCAL vs CLOUD for the same
 * target. Its three siblings live in `cross-population-reconciliation.integration.test.ts`
 * (summary vs list, analytics rollup vs rows) and
 * `../../app/agent-sessions/service/status-counts.integration.test.ts` (facet vs
 * filtered population).
 *
 * WHAT MAKES THIS PAIR DIFFERENT from the analytics arm next door. That one
 * compares two CLOUD reads of one persisted population. This one compares the
 * DESKTOP's own fold over the wire payload against what the cloud publishes
 * after ingesting that same payload — so the population crossing the wire is
 * part of what is under test, and so are two independently-maintained copies of
 * the same fold:
 *
 *   • `sumTokenUsage` in `apps/desktop/src/main/session/session-usage-totals.ts`
 *     (the desktop list row) and `sumTokenUsage` in
 *     `app/agent-sessions/service/synced-payload.ts` (what ingest writes to the
 *     `sessionDetail` rollup columns the summary then `_sum`s);
 *   • the desktop's `Boolean(event.toolName)` tool-use predicate and the cloud's
 *     `if (!event.toolName)` in `service/analytics-aggregation.ts`.
 *
 * Neither copy is imported by the other and nothing asserted they agree, so a
 * cloud reduce that stopped accumulating `cacheWriteTokens`, or a
 * `normalizeTokenUsage` that lost a duplicate-model row, would under-report on
 * the web while the desktop kept rendering the full number — the exact "two
 * paths meant to be equivalent silently diverge" class the root AGENTS.md names.
 *
 * This arm was unreachable from `apps/api` until ISS-9686 (#6789) broke the
 * import edge that rooted the Engineer server-operations tree in this app's
 * program; `../desktop-session-fold-reachability.test.ts` pins that it stays
 * broken.
 *
 * Seeds are COMMITTED and torn down by `createCommittedTestOrganizationTracker`
 * rather than wrapped in a rollback transaction, for the reason the sibling file
 * states: every read below reaches the database through `withDb`, which hands
 * back the POOLED client, so rows living only inside an uncommitted fixture
 * transaction sit on another connection and are invisible to them.
 */

import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import type { SessionUsageInput } from "@/app/agent-sessions/service/records";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";
import type { SyncedAgentSession } from "../../../desktop/src/main/agent-sync/agent-session-sync-contract.js";
import {
  addTotals,
  countToolUseEvents,
  sumTokenUsage,
  zeroTotals,
} from "../../../desktop/src/main/session/session-usage-totals.js";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

const SESSION_STARTED_AT = "2026-06-10T09:00:00.000Z";
const SESSION_UPDATED_AT = "2026-06-10T11:00:00.000Z";
const EVENT_CREATED_AT = "2026-06-10T10:30:00.000Z";

/**
 * Written from {@link buildTargetSessions}, never read back off it. Deriving
 * these from the fixture would make the pair pure arithmetic: agreement alone
 * cannot catch a change that moves the desktop fold and the cloud fold TOGETHER,
 * which is precisely what a shared-helper refactor across the two copies does.
 *
 * No two carry the same value, so a counter written into the wrong column
 * cannot land on a number that still satisfies its neighbour.
 */
const TARGET_INPUT_TOKENS = 800;
const TARGET_OUTPUT_TOKENS = 100;
const TARGET_CACHE_READ_TOKENS = 1100;
const TARGET_CACHE_WRITE_TOKENS = 40;
const TARGET_SESSION_COUNT = 2;
/** Events the wire carries; strictly more than {@link TARGET_TOOL_USES}. */
const TARGET_WIRE_EVENT_COUNT = 6;
/** The four above that name a tool — one row is `null`, one is `""`. */
const TARGET_TOOL_USES = 4;

/**
 * Carried ONLY by {@link seedForeignOrg}. A read that lost its organization
 * filter folds these in, and because they share no value with the target's
 * counters the overshoot cannot land back on an expected number.
 */
const FOREIGN_INPUT_TOKENS = 111;
const FOREIGN_TOOL_NAME = "WebFetch";
const FOREIGN_TOOL_USES = 1;

type SeededCorpus = {
  organizationId: string;
  foreignOrganizationId: string;
  sessions: SyncedAgentSession[];
};

let corpus: SeededCorpus;

beforeAll(async () => {
  if (hasDatabase) {
    corpus = await seedCorpus();
  }
});

afterAll(() => committedOrganizations.cleanup());

describeIfDb("Local vs Cloud session reconciliation (ISS-9624)", () => {
  it("reconciles the desktop token fold against the cloud's persisted totals", async () => {
    const local = corpus.sessions.reduce((totals, session) => {
      addTotals(totals, sumTokenUsage(session));
      return totals;
    }, zeroTotals());
    const summary = await agentSessionsService.getUsageSummary(
      usageInput(corpus.organizationId)
    );

    expect(
      summary.totalInputTokens,
      "the cloud rollup and the desktop list row must describe one session's usage"
    ).toBe(local.inputTokens);
    expect(summary.totalOutputTokens).toBe(local.outputTokens);
    expect(summary.totalCacheReadTokens).toBe(local.cacheReadTokens);
    // The counter a cloud-side reduce is likeliest to drop: it is last in both
    // copies and the only one the per-model table also subdivides (FEA-3419).
    expect(summary.totalCacheWriteTokens).toBe(local.cacheWriteTokens);

    // Neither side alone: a regression that zeroed BOTH folds would still agree.
    expect(local.inputTokens).toBe(TARGET_INPUT_TOKENS);
    expect(local.outputTokens).toBe(TARGET_OUTPUT_TOKENS);
    expect(local.cacheReadTokens).toBe(TARGET_CACHE_READ_TOKENS);
    expect(local.cacheWriteTokens).toBe(TARGET_CACHE_WRITE_TOKENS);
    expect(summary.totalSessions).toBe(TARGET_SESSION_COUNT);

    // KNOWN-LEGITIMATE DIVERGENCE, and why `estimatedCost` is absent above.
    // The desktop sums raw `estimatedCostUsd` floats; the cloud stores
    // `roundCost(totals.estimatedCost + webSearchCost)`
    // (`service/field-regression-guards.ts`), which both quantizes to 6 decimal
    // places and adds a metadata-derived line item that is in NO
    // `tokenUsageByModel` row. The two are not meant to be equal, so asserting
    // it would be asserting a false invariant. Cost is covered by its own
    // suites.
    //
    // SECOND KNOWN-LEGITIMATE DIVERGENCE, exercised by `beta` below: the cloud
    // MERGES wire rows sharing a model (`normalizeTokenUsage`) before it folds,
    // so the per-model ROW COUNTS legitimately differ. Only the totals
    // reconcile, which is what this pair asserts.

    // ORG SCOPING. Assert the control EXISTS before reading anything into its
    // absence — a foreign seed that silently failed to ingest would satisfy the
    // exclusion while proving nothing.
    const foreign = await agentSessionsService.getUsageSummary(
      usageInput(corpus.foreignOrganizationId)
    );
    expect(
      foreign.totalInputTokens,
      "the foreign-org control must exist for its exclusion to mean anything"
    ).toBe(FOREIGN_INPUT_TOKENS);
    expect(summary.totalInputTokens).not.toBe(
      TARGET_INPUT_TOKENS + FOREIGN_INPUT_TOKENS
    );
  });

  it("reconciles the desktop tool-use fold against the cloud's Tool rollup", async () => {
    const local = corpus.sessions.reduce(
      (running, session) => running + countToolUseEvents(session.events),
      0
    );
    const analytics = await agentSessionsService.getAnalytics(
      usageInput(corpus.organizationId)
    );
    const cloud = analytics.byTool.reduce(
      (running, tool) => running + tool.invocationCount,
      0
    );

    expect(
      cloud,
      "the Tool rollup and the desktop tool-use counter must fold one event population"
    ).toBe(local);
    expect(local).toBe(TARGET_TOOL_USES);
    // The `null` and `""` rows must sit outside BOTH sides, so a pair of
    // predicates that had each degraded to "count every event" could not agree
    // here.
    expect(TARGET_TOOL_USES).toBeLessThan(TARGET_WIRE_EVENT_COUNT);
    // Whole-object, and the per-tool split matters: an equal grand total can
    // hide a session-attribution error. `Bash` is invoked across BOTH sessions
    // and `Read` within one, and their invocation counts differ so the
    // `invocationCount`-desc order is real rather than incidental.
    expect(analytics.byTool).toEqual([
      { toolName: "Bash", invocationCount: 3, errorCount: 0, sessionCount: 2 },
      { toolName: "Read", invocationCount: 1, errorCount: 0, sessionCount: 1 },
    ]);

    // KNOWN-LEGITIMATE DIVERGENCES between these two predicates, neither of
    // which this fixture triggers:
    //   • the cloud collapses repeated `externalEventId`s before persisting
    //     (`dedupeEventsByExternalId`, `service/session-event-persistence.ts`),
    //     so a payload that repeats one would legitimately count twice locally
    //     and once in the cloud. Every id below is distinct.
    //   • a WHITESPACE-ONLY `toolName` is truthy to the desktop's `Boolean()`
    //     but is trimmed to `null` by `nullableTrimmedStringSchema` at the wire
    //     boundary, so the two disagree on that one input. `""` is seeded
    //     instead, which both sides drop, and the whitespace case is reported on
    //     ISS-9624 rather than decided here.

    const foreign = await agentSessionsService.getAnalytics(
      usageInput(corpus.foreignOrganizationId)
    );
    expect(
      foreign.byTool,
      "the foreign-org control must exist for its exclusion to mean anything"
    ).toEqual([
      {
        toolName: FOREIGN_TOOL_NAME,
        invocationCount: FOREIGN_TOOL_USES,
        errorCount: 0,
        sessionCount: 1,
      },
    ]);
    expect(
      analytics.byTool.map((tool) => tool.toolName),
      "a fold that lost `artifact.organizationId` folds the foreign tool in"
    ).not.toContain(FOREIGN_TOOL_NAME);
  });
});

function usageInput(organizationId: string): SessionUsageInput {
  // `quality: "all"`, matching the sibling suite: the list hides idle rows by
  // default while the summary does not, and that difference is a real one this
  // pair is not about.
  return { organizationId, filters: { quality: "all" } };
}

/**
 * The two sessions the target organization receives OVER THE WIRE.
 *
 * | session | token rows                          | events                          |
 * |---------|-------------------------------------|---------------------------------|
 * | alpha   | claude-opus-4, gpt-5.5              | Bash, Bash, Read, null, ""      |
 * | beta    | claude-opus-4 TWICE (merge arm)     | Bash                            |
 *
 * `beta`'s duplicate model is the `normalizeTokenUsage` arm: the cloud merges
 * those two rows before folding and the desktop does not, so the totals agree
 * only if merge-then-sum and sum agree. Its lone `Bash` is what makes that tool
 * span two sessions, so `sessionCount` is not a restatement of the session total.
 */
function buildTargetSessions(): SyncedAgentSession[] {
  return [
    {
      externalSessionId: "iss9624-local-cloud-alpha",
      name: "alpha",
      status: SESSION_STATUS.ACTIVE,
      harness: "claude",
      startedAt: SESSION_STARTED_AT,
      updatedAt: SESSION_UPDATED_AT,
      agents: [],
      events: [
        toolEvent("a1", "Bash"),
        toolEvent("a2", "Bash"),
        toolEvent("a3", "Read"),
        toolEvent("a4", null),
        toolEvent("a5", ""),
      ],
      tokenUsageByModel: [
        {
          model: "claude-opus-4",
          inputTokens: 500,
          outputTokens: 70,
          cacheReadTokens: 900,
          cacheWriteTokens: 30,
          estimatedCostUsd: 1.5,
        },
        {
          model: "gpt-5.5",
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 100,
          cacheWriteTokens: 5,
          estimatedCostUsd: 0.25,
        },
      ],
    },
    {
      externalSessionId: "iss9624-local-cloud-beta",
      name: "beta",
      status: SESSION_STATUS.ACTIVE,
      harness: "claude",
      startedAt: SESSION_STARTED_AT,
      updatedAt: SESSION_UPDATED_AT,
      agents: [],
      events: [toolEvent("b1", "Bash")],
      tokenUsageByModel: [
        {
          model: "claude-opus-4",
          inputTokens: 30,
          outputTokens: 6,
          cacheReadTokens: 40,
          cacheWriteTokens: 2,
          estimatedCostUsd: 0.1,
        },
        {
          model: "claude-opus-4",
          inputTokens: 70,
          outputTokens: 4,
          cacheReadTokens: 60,
          cacheWriteTokens: 3,
          estimatedCostUsd: 0.2,
        },
      ],
    },
  ];
}

async function seedCorpus(): Promise<SeededCorpus> {
  const sessions = buildTargetSessions();
  const organizationId = await ingestInNewOrganization(sessions, "target");
  return {
    organizationId,
    foreignOrganizationId: await seedForeignOrg(),
    sessions,
  };
}

/**
 * The org-scoping control: a SECOND organization carrying one wire session whose
 * token counters and tool name appear nowhere in the target corpus. Without it
 * every agreement above is satisfied by a read that dropped
 * `artifact.organizationId` entirely, because there would be nothing wider for
 * that read to have picked up.
 */
function seedForeignOrg(): Promise<string> {
  return ingestInNewOrganization(
    [
      {
        externalSessionId: "iss9624-local-cloud-foreign",
        name: "foreign",
        status: SESSION_STATUS.ACTIVE,
        harness: "claude",
        startedAt: SESSION_STARTED_AT,
        updatedAt: SESSION_UPDATED_AT,
        agents: [],
        events: [toolEvent("f1", FOREIGN_TOOL_NAME)],
        tokenUsageByModel: [
          {
            model: "claude-opus-4",
            inputTokens: FOREIGN_INPUT_TOKENS,
            outputTokens: 13,
            cacheReadTokens: 222,
            cacheWriteTokens: 9,
            estimatedCostUsd: 0.4,
          },
        ],
      },
    ],
    "foreign"
  );
}

/**
 * Ingest through the REAL cloud ingress contract — the wire parser plus
 * `upsertSessions` — because a fixture written straight to the tables would skip
 * the cloud fold this pair exists to reconcile against.
 *
 * A rejected payload is a thrown fixture-build error, never an assertion: the
 * suites own the behavioural expectations.
 */
async function ingestInNewOrganization(
  sessions: SyncedAgentSession[],
  machineName: string
): Promise<string> {
  const organizationId = await committedOrganizations.create();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    machineName
  );
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000009624",
    syncMode: AgentSessionSyncMode.Backfill,
    sessionCount: sessions.length,
    sessions,
  });
  if (!parsed.ok) {
    throw new Error(
      `${machineName}: fixture failed the cloud ingress contract: ${parsed.reason}`
    );
  }
  await agentSessionsService.upsertSessions(
    { organizationId, userId: user.id, computeTargetId },
    parsed.payload
  );
  return organizationId;
}

function toolEvent(externalEventId: string, toolName: string | null) {
  return {
    externalEventId,
    eventType: "tool_use",
    toolName,
    createdAt: EVENT_CREATED_AT,
  };
}
