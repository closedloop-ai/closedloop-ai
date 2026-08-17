import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findSessionDetail: vi.fn() }));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { findSessionDetail: mocks.findSessionDetail },
}));

import {
  branchTraceService,
  type QualifyingBranchTraceSession,
} from "./branch-trace-service";

const { buildCompleteBranchTrace, findQualifyingBranchTraceSessions } =
  branchTraceService;

describe("Branch trace service", () => {
  beforeEach(() => {
    mocks.findSessionDetail.mockReset();
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

  it.each([
    0, 1, 30, 31, 125,
  ])("hydrates the complete %i-Session population with at most four active calls", async (count) => {
    let active = 0;
    let maxActive = 0;
    mocks.findSessionDetail.mockImplementation(async ({ id }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return detail(id);
    });

    const result = await buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(count)
    );

    expect(result.qualifyingSessionCount).toBe(count);
    expect(result.sessions).toHaveLength(count);
    expect(mocks.findSessionDetail).toHaveBeenCalledTimes(count);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result.completeness.state).toBe(
      BranchTraceCompletenessState.Complete
    );
  });

  it("preserves deterministic identity order when hydrations resolve out of order", async () => {
    const resolvers: Array<() => void> = [];
    mocks.findSessionDetail.mockImplementation(
      ({ id }) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve(detail(id)));
        })
    );

    const resultPromise = buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(4)
    );
    await vi.waitFor(() => expect(resolvers).toHaveLength(4));
    for (const resolve of [...resolvers].reverse()) {
      resolve();
    }
    const result = await resultPromise;

    expect(result.sessions.map((entry) => entry.identity.artifactId)).toEqual([
      "session-000",
      "session-001",
      "session-002",
      "session-003",
    ]);
  });

  it("refills the bounded hydration pool without waiting for the slowest peer", async () => {
    const resolvers = new Map<string, () => void>();
    mocks.findSessionDetail.mockImplementation(
      ({ id }) =>
        new Promise((resolve) => {
          resolvers.set(id, () => resolve(detail(id)));
        })
    );

    const resultPromise = buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions(5)
    );
    await vi.waitFor(() => expect(resolvers.size).toBe(4));
    resolvers.get("session-001")?.();
    await vi.waitFor(() => expect(resolvers.size).toBe(5));
    for (const resolve of resolvers.values()) {
      resolve();
    }

    await expect(resultPromise).resolves.toMatchObject({
      qualifyingSessionCount: 5,
    });
  });

  it("retains loaded rows and typed identities across mixed hydration failures", async () => {
    mocks.findSessionDetail.mockImplementation(({ id }) => {
      if (id === "session-001") {
        return null;
      }
      if (id === "session-002") {
        return Promise.reject(
          Object.assign(new Error("hidden"), {
            name: "AbortError",
            status: 401,
          })
        );
      }
      if (id === "session-003") {
        return Promise.reject(
          Object.assign(new Error("hidden"), { status: 403 })
        );
      }
      if (id === "session-004") {
        return Promise.reject(
          Object.assign(new Error("hidden"), { name: "AbortError" })
        );
      }
      if (id === "session-005") {
        return { ...detail(id), startedAt: "not-a-date" };
      }
      if (id === "session-006") {
        return { ...detail(id), turnItems: [{ type: "future-turn" }] };
      }
      return detail(id);
    });

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
    mocks.findSessionDetail.mockImplementation(({ id }) =>
      Promise.resolve(
        id === "session-001"
          ? { ...detail(id), eventsTruncated: true }
          : detail(id)
      )
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
    mocks.findSessionDetail.mockImplementation(({ id }) =>
      Promise.resolve(id === "session-001" ? null : detail(id))
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

  it("marks all-failed aggregate evidence unavailable instead of complete-empty", async () => {
    mocks.findSessionDetail.mockResolvedValue(null);

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

  it("stops scheduling later hydration batches after request cancellation", async () => {
    const controller = new AbortController();
    mocks.findSessionDetail.mockImplementation(({ id }) => {
      if (mocks.findSessionDetail.mock.calls.length === 4) {
        controller.abort();
      }
      return detail(id);
    });

    await expect(
      buildCompleteBranchTrace(
        "org-1",
        qualifyingSessions(12),
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.findSessionDetail).toHaveBeenCalledTimes(4);
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
  branchParticipationObservedAt?: string
) {
  return {
    id: `link-${artifactId}-${createdAt}`,
    sourceId: artifactId,
    createdAt: new Date(createdAt),
    branchParticipationObservedAt: branchParticipationObservedAt
      ? new Date(branchParticipationObservedAt)
      : null,
    source: {
      id: artifactId,
      name: artifactId,
      slug: artifactId.toUpperCase(),
      session: { artifactId, externalSessionId: `external-${artifactId}` },
    },
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
