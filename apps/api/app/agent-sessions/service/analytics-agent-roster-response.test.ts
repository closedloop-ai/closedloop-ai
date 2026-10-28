/**
 * ISS-6890 (#5209 review): the analytics RESPONSE must not publish a partial
 * agent-type population as an exact one.
 *
 * These drive `getAnalytics` — the served boundary — rather than the pure fold,
 * because the defect the reviewer named is a property of what leaves the
 * service: `byAgentType` counted 2 for a valid/invalid/valid roster while the
 * response carried nothing saying so, and the analytics UI renders that sum as
 * the total number of agents. The fold's own cases live in
 * `analytics-agent-roster.test.ts`.
 *
 * A separate file from `analytics-aggregation.test.ts` so that suite is not
 * grown further (AGENTS.md → "File Size and Organization").
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildAnalyticsSessionRecord,
  buildPersistedAgent,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import type { AnalyticsSessionRecord } from "./records";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

/**
 * `getAnalytics` reads the Repository breakdown as its own `groupBy` (ISS-6823)
 * and the session population as ONE keyset-paged `findMany` (ISS-9113). A page
 * shorter than `ANALYTICS_QUERY_BATCH_SIZE` ends that walk, so the single-row
 * page below is the only session read these cases issue; the trailing
 * `mockResolvedValue([])` covers the other models, not a second session page.
 */
function installAnalyticsDb(agents: unknown) {
  const findMany = vi
    .fn()
    .mockResolvedValueOnce([
      buildAnalyticsSessionRecord(
        1,
        // The point of these cases is a stored blob the schema does NOT model,
        // which the record's own JSON type cannot express.
        { agents } as Partial<AnalyticsSessionRecord>
      ),
    ])
    .mockResolvedValue([]);
  installDb({
    sessionDetail: buildAgentSessionDbMock({ findMany }),
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
    },
  });
}

function readAnalytics() {
  return agentSessionsService.getAnalytics({
    organizationId: "org-1",
    filters: {},
  });
}

describe("getAnalytics agent-roster completeness (ISS-6890, #5209 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the shortfall beside a MIXED roster's partial agent-type counts", async () => {
    // The reviewer's exact case: valid / invalid / valid. `byAgentType` counts
    // 2, and before this change the response said nothing at all about the
    // third — the UI summed 2 and called it the total agents.
    installAnalyticsDb([
      buildPersistedAgent({
        externalAgentId: "agent-1",
        subagentType: "reviewer",
        status: "completed",
      }),
      { externalAgentId: "agent-2", name: "" },
      buildPersistedAgent({
        externalAgentId: "agent-3",
        subagentType: "reviewer",
        status: "completed",
      }),
    ]);

    const analytics = await readAnalytics();

    expect(analytics.byAgentType).toEqual([
      expect.objectContaining({ agentType: "reviewer", count: 2 }),
    ]);
    expect(analytics.agentRosterIncomplete).toEqual({
      unreadableAgents: 1,
      affectedSessions: 1,
    });
  });

  it("carries an UNKNOWN shortfall when the whole stored roster is unreadable", async () => {
    // Nothing survives and the number lost is unknowable, so the response says
    // the population is short WITHOUT inventing a figure — the same `null`
    // semantics `AgentSessionDetail.rosterIncomplete` uses for one session.
    installAnalyticsDb({ not: "an array" });

    const analytics = await readAnalytics();

    expect(analytics.byAgentType).toEqual([]);
    expect(analytics.agentRosterIncomplete).toEqual({
      unreadableAgents: null,
      affectedSessions: 1,
    });
  });

  it("OMITS the field from the response when every roster read whole", async () => {
    // Absence is the contract's ONLY encoding of "complete" (root AGENTS.md →
    // Cross-Repo Compatibility). Serializing a `null` or a zero here would ship
    // a third state, and a client predating the field could not tell it from a
    // caveat that applies.
    installAnalyticsDb([
      buildPersistedAgent({
        externalAgentId: "agent-1",
        subagentType: "reviewer",
        status: "completed",
      }),
    ]);

    const analytics = await readAnalytics();

    expect(analytics.byAgentType).toEqual([
      expect.objectContaining({ agentType: "reviewer", count: 1 }),
    ]);
    expect("agentRosterIncomplete" in analytics).toBe(false);
  });
});
