import { SessionTraceThrottleSourceType } from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { JsonArrayIncompleteReason } from "./coercion";
import {
  resetUnreadableTraceSourceEmissionBudget,
  UNREADABLE_SESSION_TRACE_SOURCES_EVENT,
} from "./session-trace-source-reads";
import {
  corruptAgentRosterOrgBudget,
  corruptAgentRosterThrottle,
} from "./synced-agent-roster-telemetry";

const mockWarn = vi.fn();

function sessionBranchSourceLink(branchName: string) {
  return {
    branchParticipation: BranchParticipationKind.Wrote,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      id: `branch-${branchName}`,
      name: branchName,
      type: ArtifactType.Branch,
      branch: {
        repository: { fullName: "closedloop-ai/closedloop-ai" },
      },
    },
  };
}

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
  },
}));

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
 * ISS-6978, through the production read path: `parseJsonArray` now reads a
 * persisted JSON array member by member, EXCEPT at the four fallback-tier call
 * sites that still need empty to mean "run my own derived fallback".
 *
 * Lives beside `projections.test.ts` rather than inside it: that file is on the
 * `noExcessiveLinesPerFile` shrink-only grandfather list.
 */
describe("agentSessionsService persisted JSON array reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // All three budgets are process-local and deliberately survive a read, so a
    // window another case (or another file in this worker) already spent must
    // not suppress this case's event. The trace-source one is load-bearing for
    // the negative assertion below: without it, a regression that starts
    // emitting on a whole column reads as silence.
    corruptAgentRosterThrottle.clear();
    corruptAgentRosterOrgBudget.clear();
    resetUnreadableTraceSourceEmissionBudget();
  });
  it("keeps the readable members of a partially corrupt persisted array (ISS-6978)", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            pullRequests: [
              { num: 41, title: "First PR", status: "merged" },
              { num: 42, title: "" },
              { num: 43, title: "Third PR", status: "open" },
            ],
            artifact: {
              organizationId: "org-1",
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: {
                id: "project-1",
                name: "Agent Platform",
                slug: "agent-platform",
              },
              sourceLinks: [sessionBranchSourceLink("feat/iss-6978")],
            },
            phaseLoopbacks: [
              { from: "ship" },
              { from: "ship", to: "build", label: "reopen", depth: 1 },
            ],
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // Which members survived, not merely that something did — the unreadable
    // member sits BETWEEN two readable ones so a head-or-tail-only read fails.
    expect(result?.prs?.map((pr) => pr.num)).toEqual([41, 43]);
    expect(result?.phaseLoopbacks).toEqual([
      { from: "ship", to: "build", label: "reopen", depth: 1 },
    ]);
  });
  it("still collapses the four fallback-tier arrays whole (ISS-6978 exception)", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            // `phases` is TAIL-sensitive: `currentPhaseLabel` reads `.at(-1)` as
            // the current phase, so the unreadable member is deliberately the
            // NEWEST one — the case a member-wise read would misreport as
            // "current phase: Plan" on a session that has moved on.
            phases: [
              {
                key: "plan",
                label: "Plan",
                dur: "2m",
                cost: "$0.10",
                cOut: 1,
                cCache: 0,
                cIn: 2,
              },
              { key: "ship", label: "Ship" },
            ],
            activityBuckets: [
              {
                label: "plan",
                cIn: 1,
                cOut: 1,
                cCache: 0,
                total: 2,
                toolStart: 0,
                tl0: 0,
                byModel: {},
              },
              { label: "bad bucket" },
            ],
            markers: [
              { kind: "commit", x: 10, t: "17:00", label: "commit", tl: 0 },
              { kind: "commit", x: 200 },
            ],
            throttles: [
              { x0: 10, t0: "17:00", t1: "17:05", durMin: 5, tl: 0 },
              { x0: 500 },
            ],
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // These four consumers read empty as "no server data, run my own COMPLETE
    // derived fallback". Serving a partial authoritative array there would
    // suppress the richer fallback, or (for `phases`) name a stale phase as
    // current — a user-visible trade escalated on ISS-6978, not decided here.
    // If this test goes red, that decision was made by accident.
    expect(result).toMatchObject({
      activityBuckets: [],
      markers: [],
      throttles: [],
      phases: [],
    });
  });
  it("serves the readable trace sources of a corrupt column and raises the monitored event once", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            artifactId: SESSION_ID,
            throttleSources: [
              READABLE_THROTTLE_SOURCE,
              // Two unreadable members, so a counter that never accumulates
              // (or resets per member) reports 1 and fails.
              { sourceType: SessionTraceThrottleSourceType.ApiError },
              { provider: "anthropic" },
              SECOND_READABLE_THROTTLE_SOURCE,
            ],
            correctionSources: "not-json",
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: SESSION_ID,
      organizationId: "org-1",
    });

    expect(result?.throttleSources?.map((source) => source.provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    // ONE trace-source event for the whole read — the contract this test's name
    // states: the per-field fold reports every unreadable column in a single
    // emission, never one per field or per member.
    //
    // Scoped to that event name rather than counting every `log.warn` (ISS-6890,
    // #5209 review). The shared fixture carries `agentCount: 2` beside
    // `agents: []`, and the detail read now RECONCILES the roster against that
    // stored count, so it correctly raises its own separate
    // `agent_session_roster_unreadable` event for the same record. A bare
    // call-count was an over-broad proxy for "this event fired once"; the scoped
    // assertion still fails on a second trace-source emission or a per-member
    // one, which is what ISS-6978 pinned here.
    expect(
      mockWarn.mock.calls.filter(
        ([event]) => event === UNREADABLE_SESSION_TRACE_SOURCES_EVENT
      )
    ).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(
      UNREADABLE_SESSION_TRACE_SOURCES_EVENT,
      {
        organizationId: "org-1",
        sessionId: SESSION_ID,
        fields: [
          {
            field: "throttleSources",
            reason: JsonArrayIncompleteReason.UnreadableMembers,
            unreadableMembers: 2,
          },
          {
            field: "correctionSources",
            reason: JsonArrayIncompleteReason.UnreadableValue,
          },
        ],
      }
    );
  });
  it("stays off the monitored channel for a session whose trace columns are whole", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            throttleSources: [READABLE_THROTTLE_SOURCE],
          })
        ),
      },
    });

    await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(
      mockWarn.mock.calls.filter(
        ([event]) => event === UNREADABLE_SESSION_TRACE_SOURCES_EVENT
      )
    ).toHaveLength(0);
  });
});

const SESSION_ID = "0196f2df-5b7d-7e72-9e4c-8d8af9fba001";
const READABLE_THROTTLE_SOURCE = {
  sourceType: SessionTraceThrottleSourceType.ProviderRateLimit,
  provider: "anthropic",
  observedAt: "2026-05-20T17:02:00.000Z",
};
const SECOND_READABLE_THROTTLE_SOURCE = {
  sourceType: SessionTraceThrottleSourceType.UsageLimit,
  provider: "openai",
  observedAt: "2026-05-20T17:04:00.000Z",
};
