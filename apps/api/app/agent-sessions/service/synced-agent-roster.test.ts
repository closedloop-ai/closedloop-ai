/**
 * ISS-6890: the detail projection must never serve a plausible EMPTY agent
 * roster that contradicts the session's own stored `agentCount`.
 *
 * These drive `findSessionDetail` (the production entry point) rather than the
 * pure helper, because the contradiction the ticket describes is a property of
 * ONE projected result — the count and the roster ride the same object — and
 * because the monitored diagnostic is wired at that layer, not in the parser.
 */

import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildPersistedAgent,
  buildSessionDetailRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { FIXED_WINDOW_EMISSION_WINDOW_MS } from "@/lib/observability/fixed-window-emission-throttle";
import { agentSessionsService } from "../service";
import {
  CORRUPT_AGENT_ROSTER_EVENT,
  CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET,
  CorruptAgentRosterReason,
  corruptAgentRosterOrgBudget,
  corruptAgentRosterThrottle,
} from "./synced-agent-roster-telemetry";

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

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

/** How many `agent_session_roster_unreadable` events the run has emitted. */
function corruptRosterEmissions() {
  return vi
    .mocked(log.warn)
    .mock.calls.filter(([event]) => event === CORRUPT_AGENT_ROSTER_EVENT);
}

const ORGANIZATION_ID = "org-1";

/**
 * The contradiction ISS-6890 forbids: a positive stored `agentCount` beside an
 * empty served roster with nothing marking the roster incomplete. Asserted from
 * ONE projected result, because the count and the roster ride the same object.
 */
function isFalselyComplete(detail: Awaited<ReturnType<typeof readDetail>>) {
  return (
    detail != null &&
    detail.agentCount > 0 &&
    detail.agents.length === 0 &&
    detail.rosterIncomplete == null
  );
}

function installDetail(agents: unknown, agentCount: number) {
  const record = buildSessionDetailRecord({ agents, agentCount });
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      findFirst: vi.fn().mockResolvedValue(record),
      findUnique: vi.fn().mockResolvedValue(record),
    }),
  });
  return record;
}

function readDetail() {
  return agentSessionsService.findSessionDetail({
    organizationId: ORGANIZATION_ID,
    id: String(buildSessionDetailRecord().artifactId),
  });
}

describe("findSessionDetail agent roster integrity (ISS-6890)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both throttles are process-local and deliberately survive a read, so a
    // leftover window from the previous case would suppress the next one's
    // expected emission.
    corruptAgentRosterThrottle.clear();
    corruptAgentRosterOrgBudget.clear();
  });

  it("serves the readable members of a corrupt roster instead of collapsing the whole population", async () => {
    // The MIXED array is the case: an all-valid fixture passes with or without
    // the per-member read, and an all-invalid one cannot show preservation.
    installDetail(
      [
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        { externalAgentId: "agent-2", name: "" },
        buildPersistedAgent({ externalAgentId: "agent-3" }),
      ],
      3
    );

    const detail = await readDetail();

    expect(detail?.agents.map((agent) => agent.externalAgentId)).toEqual([
      "agent-1",
      "agent-3",
    ]);
    // The corrupt member is REPRESENTED, not silently dropped: the projection
    // says one member is missing rather than presenting two as the whole roster.
    expect(detail?.rosterIncomplete).toEqual({ unreadableAgents: 1 });
    expect(detail?.agentCount).toBe(3);
  });

  it("marks a fully unreadable roster incomplete rather than serving it as empty", async () => {
    installDetail([{ externalAgentId: "agent-2", name: "" }], 1);

    const detail = await readDetail();

    expect(detail?.agents).toEqual([]);
    expect(detail?.agentCount).toBe(1);
    // Without this the response is indistinguishable from "no agent records
    // were captured", which is the empty state the ticket's detail view renders.
    expect(detail?.rosterIncomplete).toEqual({ unreadableAgents: 1 });
    expect(isFalselyComplete(detail)).toBe(false);
  });

  it("marks a roster whose stored blob is not an array incomplete, with the member count UNKNOWN", async () => {
    // The worst case, and the one a bare nullable count would have let read as
    // complete: nothing can be recovered AND the number lost is unknowable.
    installDetail({ not: "an array" }, 3);

    const detail = await readDetail();

    expect(detail?.agents).toEqual([]);
    // One truthy predicate must catch this case, exactly as it catches a
    // partial roster — that is why `rosterIncomplete` is an object.
    expect(Boolean(detail?.rosterIncomplete)).toBe(true);
    // `null`, never 0: 0 would claim a whole roster.
    expect(detail?.rosterIncomplete?.unreadableAgents).toBeNull();
    expect(isFalselyComplete(detail)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      CORRUPT_AGENT_ROSTER_EVENT,
      expect.objectContaining({
        reason: CorruptAgentRosterReason.UnreadableBlob,
        readableAgents: 0,
        unreadableAgents: null,
      })
    );
  });

  it("omits the incompleteness field entirely when the roster is whole", async () => {
    installDetail([buildPersistedAgent({ externalAgentId: "agent-1" })], 1);

    const detail = await readDetail();

    expect(detail?.agents).toHaveLength(1);
    // ABSENCE is the only encoding of "complete" — a serialized falsy value
    // would become a third state every reader has to interpret.
    expect(detail && "rosterIncomplete" in detail).toBe(false);
  });

  it("routes the corruption to the monitored structured-log event with the session and roster context", async () => {
    // The three numbers are deliberately DISTINCT (3 stored / 2 readable /
    // 1 lost) so swapping any pair of emitted fields fails this assertion.
    const record = installDetail(
      [
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        { externalAgentId: "agent-2", name: "" },
        buildPersistedAgent({ externalAgentId: "agent-3" }),
      ],
      3
    );

    await readDetail();

    expect(log.warn).toHaveBeenCalledWith(
      CORRUPT_AGENT_ROSTER_EVENT,
      expect.objectContaining({
        reason: CorruptAgentRosterReason.UnreadableMembers,
        organizationId: ORGANIZATION_ID,
        sessionId: record.artifactId,
        agentCount: 3,
        readableAgents: 2,
        unreadableAgents: 1,
        occurrences: 1,
      })
    );
  });

  it("stays silent on a clean roster, so the event measures corruption and not read traffic", async () => {
    installDetail([buildPersistedAgent({ externalAgentId: "agent-1" })], 1);

    await readDetail();

    expect(corruptRosterEmissions()).toHaveLength(0);
  });

  it("does not report an absent roster as corrupt", async () => {
    // A session that synced no agents at all has an ABSENT column, not a corrupt
    // one. Conflating the two would fire the monitor on every such session.
    installDetail(null, 0);

    const detail = await readDetail();

    expect(detail?.agents).toEqual([]);
    expect(detail && "rosterIncomplete" in detail).toBe(false);
    expect(corruptRosterEmissions()).toHaveLength(0);
  });

  it("emits ONCE for a corrupt session re-read many times, instead of once per request", async () => {
    // The counterfactual for the amplification vector: the stored value never
    // self-heals, so before the throttle every authenticated GET of this one row
    // emitted its own event — an unbounded log stream any caller with access to
    // one affected session could drive by polling. Asserting `1` here fails on
    // the pre-fix code, which emitted `READ_COUNT`.
    const READ_COUNT = 25;
    installDetail(
      [
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        { externalAgentId: "agent-2", name: "" },
      ],
      2
    );

    for (let i = 0; i < READ_COUNT; i += 1) {
      await readDetail();
    }

    expect(corruptRosterEmissions()).toHaveLength(1);
  });

  it("marks a NULL roster incomplete when the session's own agentCount says agents ran", async () => {
    // #5209 review. Read in isolation the column is simply absent, and the
    // parser rightly reports zero unreadable members — but "nothing was ever
    // captured" and "this session has 3 agents" cannot both be true. Before the
    // reconciliation this served `agents: []` beside `agentCount: 3` with
    // nothing marking it, which is the exact contradiction ISS-6890 removes.
    installDetail(null, 3);

    const detail = await readDetail();

    expect(detail?.agents).toEqual([]);
    expect(detail?.agentCount).toBe(3);
    expect(detail?.rosterIncomplete).toEqual({ unreadableAgents: 3 });
    expect(isFalselyComplete(detail)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      CORRUPT_AGENT_ROSTER_EVENT,
      expect.objectContaining({
        reason: CorruptAgentRosterReason.CountShortfall,
        readableAgents: 0,
        unreadableAgents: 3,
      })
    );
  });

  it("marks an EMPTY stored roster incomplete when the session's own agentCount is positive", async () => {
    // An empty array parses perfectly, so nothing in the blob is unreadable —
    // only the cross-check against the surviving count can catch it.
    installDetail([], 2);

    const detail = await readDetail();

    expect(detail?.agents).toEqual([]);
    expect(detail?.rosterIncomplete).toEqual({ unreadableAgents: 2 });
    expect(isFalselyComplete(detail)).toBe(false);
  });

  it("marks a SHORT but entirely valid roster incomplete against the larger stored count", async () => {
    // Every member present is readable, so the parser reports zero failures and
    // the served roster looks whole — while the session says it has five.
    installDetail(
      [
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        buildPersistedAgent({ externalAgentId: "agent-2" }),
      ],
      5
    );

    const detail = await readDetail();

    expect(detail?.agents).toHaveLength(2);
    expect(detail?.rosterIncomplete).toEqual({ unreadableAgents: 3 });
  });

  it("does not invent incompleteness when the roster holds at least as many members as the count", async () => {
    // The counterweight to the three cases above: a count that LAGS the blob is
    // not evidence of loss, and marking it would make the marker meaningless on
    // the sessions that need it.
    installDetail(
      [
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        buildPersistedAgent({ externalAgentId: "agent-2" }),
      ],
      1
    );

    const detail = await readDetail();

    expect(detail?.agents).toHaveLength(2);
    expect(detail && "rosterIncomplete" in detail).toBe(false);
    expect(corruptRosterEmissions()).toHaveLength(0);
  });

  it("reports the LARGER loss when the blob is short AND a member is unreadable", async () => {
    // Two independent signals of loss: the parser lost 1, the count says 3 are
    // missing. The shortfall is a lower bound, never a replacement, so the
    // response reports the larger honest number rather than the parser's alone.
    installDetail(
      [
        buildPersistedAgent({ externalAgentId: "agent-1" }),
        { externalAgentId: "agent-2", name: "" },
      ],
      4
    );

    const detail = await readDetail();

    expect(detail?.agents).toHaveLength(1);
    expect(detail?.rosterIncomplete).toEqual({ unreadableAgents: 3 });
    // The parse failure is still the actionable operator signal, so the reason
    // stays `unreadable_members` rather than being relabelled a shortfall.
    expect(log.warn).toHaveBeenCalledWith(
      CORRUPT_AGENT_ROSTER_EVENT,
      expect.objectContaining({
        reason: CorruptAgentRosterReason.UnreadableMembers,
      })
    );
  });

  it("bounds emissions when a caller cycles MORE distinct sessions than the throttle keyspace holds", async () => {
    // #5209 review, the churn hole. `sessionId` in the key made the bound
    // evictable: cycling one more session than the LRU cap holds evicts each
    // key before it is reused, so every read is a first occurrence and the
    // stream never closes. Memory was bounded; log volume was not.
    //
    // The cap+1 round robin is driven here at a SMALL multiple of the org
    // budget rather than the real 10,001-key LRU cap — the property under test
    // is that a stable `(org, reason)` budget is spent BEFORE the session key is
    // consulted, so churning session identity cannot buy another emission.
    // Without that budget this loop emits once per distinct session.
    const SESSIONS = CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET + 1;

    for (let index = 0; index < SESSIONS; index += 1) {
      const record = buildSessionDetailRecord({
        artifactId: `churn-session-${index}`,
        agents: [{ externalAgentId: "agent-2", name: "" }],
        agentCount: 1,
      });
      installDb({
        sessionDetail: buildAgentSessionDbMock({
          findFirst: vi.fn().mockResolvedValue(record),
          findUnique: vi.fn().mockResolvedValue(record),
        }),
      });
      await agentSessionsService.findSessionDetail({
        organizationId: ORGANIZATION_ID,
        id: String(record.artifactId),
      });
    }

    // Exactly the budget, not once per distinct session: without the stable
    // key this is `SESSIONS`, and it keeps climbing for as long as the caller
    // keeps cycling.
    expect(corruptRosterEmissions()).toHaveLength(
      CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET
    );
  });

  it("keeps the budget-suppressed reads countable rather than dropping them", async () => {
    // Bounding by org must not hide volume either: the occurrences the budget
    // refused are flushed as one rollup on the STABLE key, which carries no
    // sessionId because the suppressed reads did not share one.
    const SESSIONS = CORRUPT_AGENT_ROSTER_ORG_EMISSION_BUDGET + 3;
    for (let index = 0; index < SESSIONS; index += 1) {
      const record = buildSessionDetailRecord({
        artifactId: `budget-session-${index}`,
        agents: [{ externalAgentId: "agent-2", name: "" }],
        agentCount: 1,
      });
      installDb({
        sessionDetail: buildAgentSessionDbMock({
          findFirst: vi.fn().mockResolvedValue(record),
          findUnique: vi.fn().mockResolvedValue(record),
        }),
      });
      await agentSessionsService.findSessionDetail({
        organizationId: ORGANIZATION_ID,
        id: String(record.artifactId),
      });
    }

    // Close the window the way production does — by time passing — through the
    // budget's own injected clock rather than a fake timer.
    const scope = {
      organizationId: ORGANIZATION_ID,
      reason: CorruptAgentRosterReason.UnreadableMembers,
    };
    const rollover = corruptAgentRosterOrgBudget.record(
      [scope.organizationId, scope.reason].join("|"),
      scope,
      Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS
    );

    // The three reads past the budget are exactly the ones the rollup carries,
    // so emitted + flushed equals the reads that happened.
    expect(rollover.flushedSuppressedCount).toBe(3);
  });

  it("keeps the suppressed reads countable rather than dropping them", async () => {
    // Bounding the emission must not hide HOW OFTEN the corrupt row was served:
    // the window's suppressed occurrences are flushed as one aggregate rollup,
    // so the monitor's sum over `occurrences` still reaches the true total.
    const flushed: number[] = [];
    installDetail([{ externalAgentId: "agent-2", name: "" }], 1);

    await readDetail();
    await readDetail();
    await readDetail();

    // Force the window closed the way production does — by time passing — using
    // the throttle's own injected clock rather than a fake timer.
    const parts = {
      organizationId: ORGANIZATION_ID,
      sessionId: String(buildSessionDetailRecord().artifactId),
      reason: CorruptAgentRosterReason.UnreadableMembers,
    };
    const key = [parts.organizationId, parts.sessionId, parts.reason].join("|");
    const rollover = corruptAgentRosterThrottle.record(
      key,
      parts,
      Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS
    );
    flushed.push(rollover.flushedSuppressedCount);

    // One emitted + two suppressed: the rollup carries exactly the two that did
    // not emit, so emitted + flushed equals the three reads that happened.
    expect(flushed).toEqual([2]);
  });
});
