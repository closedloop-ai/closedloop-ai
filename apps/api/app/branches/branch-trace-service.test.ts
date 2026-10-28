import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAgentSessionDetailInputs: vi.fn(),
  projectAgentSessionDetail: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service/session-detail-read", () => ({
  readAgentSessionDetailInputs: mocks.readAgentSessionDetailInputs,
  projectAgentSessionDetail: mocks.projectAgentSessionDetail,
}));

import {
  branchTraceService,
  type QualifyingBranchTraceSession,
} from "./branch-trace-service";

const { buildCompleteBranchTrace, findQualifyingBranchTraceSessions } =
  branchTraceService;

describe("Branch trace service", () => {
  beforeEach(() => {
    mocks.readAgentSessionDetailInputs.mockReset();
    mocks.projectAgentSessionDetail.mockReset();
    // The read resolves a projection input per requested id; the projection is
    // what turns one into a detail. Both defaults are overridden per case.
    mocks.readAgentSessionDetailInputs.mockImplementation(
      async ({ ids }: { ids: string[] }) => ids.map((id) => projectionInput(id))
    );
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) =>
        detail(record.artifactId)
    );
  });

  it("enumerates all identities, dedupes newest evidence, and tie-breaks by id", async () => {
    const rows = [
      link("session-b", "2026-08-01T00:00:00.000Z"),
      link("session-a", "2026-08-01T00:00:00.000Z"),
      link("session-a", "2026-07-01T00:00:00.000Z"),
      link("session-c", "2026-06-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"),
    ].reverse();
    const findMany = vi.fn().mockResolvedValue(rows);

    const result = await findQualifyingBranchTraceSessions(
      { artifactLink: { findMany } } as never,
      "org-1",
      "branch-1"
    );

    expect(result.map((entry) => entry.identity.artifactId)).toEqual([
      "session-c",
      "session-a",
      "session-b",
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { branchParticipationObservedAt: "desc" },
          { createdAt: "desc" },
          { sourceId: "asc" },
          { id: "asc" },
        ],
      })
    );
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
  });

  it("excludes explicit and metadata-derived Reviewed links from trace membership", async () => {
    const findMany = vi.fn().mockResolvedValue([
      link("session-wrote", "2026-08-04T00:00:00.000Z", undefined, {
        branchParticipation: BranchParticipationKind.Wrote,
      }),
      link("session-reviewed", "2026-08-03T00:00:00.000Z", undefined, {
        branchParticipation: BranchParticipationKind.Reviewed,
      }),
      link("session-metadata-reviewed", "2026-08-02T00:00:00.000Z", undefined, {
        metadata: { branchParticipation: BranchParticipationKind.Reviewed },
      }),
      link("session-legacy", "2026-08-01T00:00:00.000Z"),
    ]);

    const result = await findQualifyingBranchTraceSessions(
      { artifactLink: { findMany } } as never,
      "org-1",
      "branch-1"
    );

    expect(result.map((entry) => entry.identity.artifactId)).toEqual([
      "session-wrote",
      "session-legacy",
    ]);
  });

  /**
   * ISS-9112: `BRANCH_TRACE_SESSION_CONCURRENCY = 4` bounded how many detail
   * reads ran AT ONCE; it never bounded how many ran. A branch with 125 linked
   * sessions issued 125 of them, each a per-session round trip. The population
   * is now resolved by ONE read whatever its size.
   *
   * The expected count is the literal 1 — not a value derived from the
   * population or from the code under test. If the hydration ever goes back to
   * asking per session, every row of this table fails.
   */
  it.each([0, 1, 30, 31, 125])(
    "hydrates the complete %i-Session population in one read",
    async (count) => {
      const result = await buildCompleteBranchTrace(
        "org-1",
        qualifyingSessions(count)
      );

      expect(result.qualifyingSessionCount).toBe(count);
      expect(result.sessions).toHaveLength(count);
      expect(mocks.readAgentSessionDetailInputs).toHaveBeenCalledTimes(1);
      expect(mocks.readAgentSessionDetailInputs).toHaveBeenCalledWith(
        {
          organizationId: "org-1",
          ids: qualifyingSessions(count).map(
            (session) => session.identity.artifactId
          ),
        },
        { includeActivitySegments: false, includeAuthoritativeCost: false }
      );
      expect(result.completeness.state).toBe(
        BranchTraceCompletenessState.Complete
      );
    }
  );

  it("preserves deterministic identity order when the read returns another order", async () => {
    mocks.readAgentSessionDetailInputs.mockImplementation(
      async ({ ids }: { ids: string[] }) =>
        [...ids].reverse().map((id) => projectionInput(id))
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(4)
    );

    expect(result.sessions.map((entry) => entry.identity.artifactId)).toEqual([
      "session-000",
      "session-001",
      "session-002",
      "session-003",
    ]);
  });

  it("keeps a projection fault inside its own session rather than failing the trace", async () => {
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) => {
        if (record.artifactId === "session-001") {
          throw Object.assign(new Error("hidden"), { status: 403 });
        }
        return detail(record.artifactId);
      }
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(3)
    );

    expect(result.sessions.map((entry) => entry.state)).toEqual([
      BranchTraceSessionHydrationState.Loaded,
      BranchTraceSessionHydrationState.Unavailable,
      BranchTraceSessionHydrationState.Loaded,
    ]);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("reports every identity as unavailable when the shared read itself fails", async () => {
    mocks.readAgentSessionDetailInputs.mockRejectedValue(
      Object.assign(new Error("hidden"), { status: 401 })
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(3)
    );

    expect(
      result.sessions.map((entry) =>
        entry.state === BranchTraceSessionHydrationState.Unavailable
          ? entry.reason
          : entry.state
      )
    ).toEqual([
      BranchTraceUnavailableReason.Authentication,
      BranchTraceUnavailableReason.Authentication,
      BranchTraceUnavailableReason.Authentication,
    ]);
    expect(result.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Unavailable
    );
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("retains loaded rows and typed identities across mixed hydration failures", async () => {
    // ISS-9112: a session the shared read did not return is `NotFound`; the rest
    // are classified from the fault its own projection raised, which is why that
    // boundary stayed per session when the read stopped being one.
    mocks.readAgentSessionDetailInputs.mockImplementation(
      async ({ ids }: { ids: string[] }) =>
        ids
          .filter((id) => id !== "session-001")
          .map((id) => projectionInput(id))
    );
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) => {
        const id = record.artifactId;
        if (id === "session-002") {
          throw Object.assign(new Error("hidden"), {
            name: "AbortError",
            status: 401,
          });
        }
        if (id === "session-003") {
          throw Object.assign(new Error("hidden"), { status: 403 });
        }
        if (id === "session-004") {
          throw Object.assign(new Error("hidden"), { name: "AbortError" });
        }
        if (id === "session-005") {
          return { ...detail(id), startedAt: "not-a-date" };
        }
        if (id === "session-006") {
          return { ...detail(id), turnItems: [{ type: "future-turn" }] };
        }
        return detail(id);
      }
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(7)
    );

    expect(result.qualifyingSessionCount).toBe(7);
    expect(result.sessions).toHaveLength(7);
    expect(result.sessions.map((entry) => entry.state)).toEqual([
      BranchTraceSessionHydrationState.Loaded,
      BranchTraceSessionHydrationState.Unavailable,
      BranchTraceSessionHydrationState.Unavailable,
      BranchTraceSessionHydrationState.Unavailable,
      BranchTraceSessionHydrationState.Unavailable,
      BranchTraceSessionHydrationState.Unavailable,
      BranchTraceSessionHydrationState.Loaded,
    ]);
    expect(
      result.sessions.flatMap((entry) =>
        entry.state === BranchTraceSessionHydrationState.Unavailable
          ? [entry.reason]
          : []
      )
    ).toEqual([
      BranchTraceUnavailableReason.NotFound,
      BranchTraceUnavailableReason.Authentication,
      BranchTraceUnavailableReason.Permission,
      BranchTraceUnavailableReason.Cancelled,
      BranchTraceUnavailableReason.Malformed,
    ]);
    expect(result.items.some((item) => item.sessionId === "session-000")).toBe(
      true
    );
    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(result.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("ISS-5075: reports a trace built from a truncated Session as incomplete, not complete", async () => {
    // The session hydrates fine, so count-based completeness sees nothing wrong
    // — but its event stream hit the detail read's row ceiling, so it contributes
    // only a prefix of its turns. Asserting `complete` over that would be a
    // stronger claim than the uncapped read this replaced ever made.
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) =>
        record.artifactId === "session-001"
          ? { ...detail(record.artifactId), eventsTruncated: true }
          : detail(record.artifactId)
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(3)
    );

    // Every session loaded — only the truncation makes this incomplete.
    expect(result.sessions).toHaveLength(3);
    expect(
      result.sessions.every(
        (session) => session.state === BranchTraceSessionHydrationState.Loaded
      )
    ).toBe(true);
    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(result.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    // Stage review: incomplete-because-truncated must be distinguishable from
    // incomplete-because-a-session-failed-to-hydrate — the two need different
    // words on screen, and the state alone cannot tell them apart.
    expect(result.completeness.eventsTruncated).toBe(true);
    expect(result.aggregateCompleteness.eventsTruncated).toBe(true);
  });

  it("ISS-5075: omits the truncation flag when a hydration failure is what made the trace incomplete", async () => {
    mocks.readAgentSessionDetailInputs.mockImplementation(
      async ({ ids }: { ids: string[] }) =>
        ids
          .filter((id) => id !== "session-001")
          .map((id) => projectionInput(id))
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(3)
    );

    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(result.completeness.eventsTruncated).toBeUndefined();
  });

  it("ISS-9723: keeps a Session's readable items when one item cannot be parsed", async () => {
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) =>
        record.artifactId === "session-000"
          ? {
              ...detail(record.artifactId),
              turnItems: [
                sayTurn("before the bad extent", 1000),
                unreadableToolsTurn(2000),
                sayTurn("after the bad extent", 3000),
              ],
            }
          : detail(record.artifactId)
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(2)
    );

    const partial = result.sessions[0];
    expect(partial.state).toBe(BranchTraceSessionHydrationState.Loaded);
    expect(
      partial.state === BranchTraceSessionHydrationState.Loaded
        ? partial.unreadableItemCount
        : null
    ).toBe(1);
    // The good extents survive: this is the half of the ruling that changes what
    // the reader gets.
    expect(
      result.items.flatMap((item) =>
        item.type === "say" && item.sessionId === "session-000"
          ? [item.text]
          : []
      )
    ).toEqual(["before the bad extent", "after the bad extent"]);
    // The unparseable one is dropped, never repaired into a plausible value.
    expect(
      result.items.some(
        (item) => item.type === "tools" && item.sessionId === "session-000"
      )
    ).toBe(false);
    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(result.completeness.eventsTruncated).toBeUndefined();
  });

  it("ISS-9723: reports a Session whose every turn is unreadable without dropping it", async () => {
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) => ({
        ...detail(record.artifactId),
        turnItems: [unreadableToolsTurn(1000), unreadableToolsTurn(2000)],
      })
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(1)
    );

    const only = result.sessions[0];
    expect(only.state).toBe(BranchTraceSessionHydrationState.Loaded);
    expect(
      only.state === BranchTraceSessionHydrationState.Loaded
        ? only.unreadableItemCount
        : null
    ).toBe(2);
    // Its session-boundary marker is real evidence and still parses, so the
    // Session is present in the trace and openly missing both of its turns.
    expect(result.items.map((item) => item.type)).toEqual(["sessionstart"]);
    expect(result.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
  });

  /**
   * ISS-9723 (#6884 review, davetho) — the drop site the schema partition
   * cannot see.
   *
   * `buildMergedTrace` discards a turn whose `t` will not parse before it ever
   * becomes a `MergedTraceItem`, so this item reaches no schema. Before the
   * builder reported its own discards, this trace returned `Complete` with no
   * count while a readable sibling of the dropped turn stayed on screen —
   * "nothing was unreadable" and "an unreadable item was removed upstream"
   * answering identically, which is the collapse this ticket exists to end.
   */
  it("ISS-9723: counts a turn the builder discarded for an unreadable stamp", async () => {
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) =>
        record.artifactId === "session-000"
          ? {
              ...detail(record.artifactId),
              turnItems: [
                sayTurn("before the unstamped turn", 1000),
                unstampedSayTurn("the turn nothing can place", 2000),
              ],
            }
          : detail(record.artifactId)
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(2)
    );

    const partial = result.sessions[0];
    expect(partial.state).toBe(BranchTraceSessionHydrationState.Loaded);
    expect(
      partial.state === BranchTraceSessionHydrationState.Loaded
        ? partial.unreadableItemCount
        : null
    ).toBe(1);
    // The readable sibling still renders — this is a partial Session, not a
    // withheld one — and the unplaceable turn is simply absent.
    expect(
      result.items.flatMap((item) =>
        item.type === "say" && item.sessionId === "session-000"
          ? [item.text]
          : []
      )
    ).toEqual(["before the unstamped turn"]);
    // The assertion that actually reddens without the builder's report: a trace
    // that dropped an item may not call itself Complete.
    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    expect(result.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
  });

  /**
   * The two drop sites are counted from ONE total per Session, not two competing
   * ones. A Session losing a turn at each site must disclose 2 — a fix that
   * overwrote the builder's seed instead of adding to it would report 1 here and
   * still pass the single-site cases above.
   */
  it("ISS-9723: totals both drop sites into one per-Session count", async () => {
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) =>
        record.artifactId === "session-000"
          ? {
              ...detail(record.artifactId),
              turnItems: [
                sayTurn("the readable one", 1000),
                unstampedSayTurn("dropped by the builder", 2000),
                unreadableToolsTurn(3000),
              ],
            }
          : detail(record.artifactId)
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(2)
    );

    const partial = result.sessions[0];
    expect(
      partial.state === BranchTraceSessionHydrationState.Loaded
        ? partial.unreadableItemCount
        : null
    ).toBe(2);
  });

  it("ISS-9723: omits the drop count and stays complete when every item parses", async () => {
    mocks.projectAgentSessionDetail.mockImplementation(
      ({ record }: { record: { artifactId: string } }) => ({
        ...detail(record.artifactId),
        turnItems: [sayTurn("all readable", 1000)],
      })
    );

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(2)
    );

    expect(
      result.sessions.every(
        (session) =>
          session.state === BranchTraceSessionHydrationState.Loaded &&
          session.unreadableItemCount === undefined
      )
    ).toBe(true);
    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Complete
    );
  });

  it("marks all-failed aggregate evidence unavailable instead of complete-empty", async () => {
    mocks.readAgentSessionDetailInputs.mockResolvedValue([]);

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(2)
    );

    expect(result.items).toEqual([]);
    expect(result.qualifyingSessionCount).toBe(2);
    expect(result.aggregateCompleteness.state).toBe(
      BranchTraceCompletenessState.Unavailable
    );
  });

  it("does not project a population whose request was cancelled during the read", async () => {
    const controller = new AbortController();
    mocks.readAgentSessionDetailInputs.mockImplementation(
      ({ ids }: { ids: string[] }) => {
        controller.abort();
        return Promise.resolve(ids.map((id) => projectionInput(id)));
      }
    );

    await expect(
      buildCompleteBranchTrace(
        "org-1",
        qualifyingSessions(12),
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.projectAgentSessionDetail).not.toHaveBeenCalled();
  });

  it("does not read at all when the request was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildCompleteBranchTrace(
        "org-1",
        qualifyingSessions(3),
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.readAgentSessionDetailInputs).not.toHaveBeenCalled();
  });
});

function qualifyingSessions(count: number): QualifyingBranchTraceSession[] {
  return Array.from({ length: count }, (_, index) => {
    const artifactId = `session-${index.toString().padStart(3, "0")}`;
    return {
      observedAtMs: Date.parse("2026-08-01T00:00:00.000Z") - index,
      identity: {
        artifactId,
        name: `Session ${index}`,
        slug: `SES-${index}`,
        navigableRef: `SES-${index}`,
        externalSessionId: `external-${index}`,
      },
    };
  });
}

function link(
  artifactId: string,
  createdAt: string,
  branchParticipationObservedAt?: string,
  overrides: {
    branchParticipation?: BranchParticipationKind | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  return {
    branchParticipation: overrides.branchParticipation ?? null,
    id: `link-${artifactId}-${createdAt}`,
    sourceId: artifactId,
    createdAt: new Date(createdAt),
    branchParticipationObservedAt: branchParticipationObservedAt
      ? new Date(branchParticipationObservedAt)
      : null,
    metadata: overrides.metadata ?? {},
    source: {
      id: artifactId,
      name: artifactId,
      slug: artifactId.toUpperCase(),
      session: { artifactId, externalSessionId: `external-${artifactId}` },
    },
  };
}

/** The shape `readAgentSessionDetailInputs` resolves, as this suite needs it. */
function projectionInput(id: string) {
  return { record: { artifactId: id } };
}

const TRACE_START_MS = Date.parse("2026-08-01T00:00:00.000Z");

function sayTurn(text: string, offsetMs: number) {
  const tMs = TRACE_START_MS + offsetMs;
  return {
    type: "say",
    t: new Date(tMs).toISOString(),
    tMs,
    cum: 0,
    actor: { name: "agent" },
    text,
  };
}

/**
 * ISS-9723 (#6884 review, davetho): a turn whose `t` will not parse.
 *
 * A DIFFERENT drop site from {@link unreadableToolsTurn} below, and the reason
 * this fixture exists: `buildMergedTrace` discards this one itself, so it never
 * reaches `mergedTraceItemSchema` and the schema partition cannot count it. Its
 * `tMs` is deliberately sound — only the ISO stamp the builder parses is bad —
 * so nothing else about the turn explains the loss.
 */
function unstampedSayTurn(text: string, offsetMs: number) {
  return {
    type: "say",
    t: "not-a-timestamp",
    tMs: TRACE_START_MS + offsetMs,
    cum: 0,
    actor: { name: "agent" },
    text,
  };
}

/**
 * A `tools` turn the merged-trace contract cannot parse. `NaN` is what an absent
 * or unparseable stamp from a version-skewed producer folds to, and Zod 4's
 * `z.number()` refuses it — which is exactly the item that used to classify this
 * whole Session `Malformed`.
 */
function unreadableToolsTurn(offsetMs: number) {
  const tMs = TRACE_START_MS + offsetMs;
  return {
    type: "tools",
    t: new Date(tMs).toISOString(),
    tMs,
    endMs: Number.NaN,
    summary: "read files",
    hasFail: false,
    failN: 0,
    items: [],
  };
}

function detail(id: string) {
  return {
    id,
    name: id,
    slug: id.toUpperCase(),
    externalSessionId: `external-${id}`,
    harness: "codex",
    model: "gpt",
    primaryModel: "gpt",
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    turnItems: [],
  };
}
