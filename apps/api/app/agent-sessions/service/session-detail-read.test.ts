import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import { MonitoredTargetDisposition } from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { log } from "@repo/observability/log";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  findAgentSessionDetail,
  readAgentSessionDetailInputs,
  SESSION_DETAIL_READ_BATCH_SIZE,
  SESSION_IDENTITY_READ_BATCH_SIZE,
} from "./session-detail-read";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

/**
 * ISS-9112: hydrating a Session detail used to be three queries PER session —
 * the stored row, its source artifact, and its transcript archive — so the
 * Branch merged trace paid three per linked session and nothing bounded the
 * total. The reads are keyed by session identity, so the whole set is now
 * resolved by three queries whatever its size.
 *
 * The expected counts below are literals written from that contract, not
 * derived from the population or from the code under test. The population sizes
 * bracket the point: one session (the shape every existing caller uses) and a
 * branch-sized set, where the per-session shape would issue 120.
 *
 * The stored-row read is the one that stays chunked — its select carries
 * `events` and `tokenEvents` bounded PER SESSION, so an unchunked `in` over an
 * unbounded population would materialize the whole corpus of relation rows at
 * once. Nothing is dropped; the chunk bounds memory, not the population.
 */

const ORGANIZATION_ID = "org-1";
const SOURCE_ARTIFACT_ID = "0196f2df-5b7d-7e72-9e4c-8d8af9fba0aa";
const SOURCE_LOOP_ID = "0199e7a2-0000-4000-a000-000000007229";

describe("readAgentSessionDetailInputs", () => {
  it.each([
    [1, 1],
    [40, 2],
  ])(
    "resolves a %i-session population in %i stored-row read(s) and one of each companion read",
    async (populationSize, expectedStoredRowReads) => {
      const ids = Array.from(
        { length: populationSize },
        (_unused, index) => `session-${index}`
      );
      const sessionDetailFindMany = vi
        .fn()
        .mockImplementation(
          async ({ where }: { where: { artifactId: { in: string[] } } }) =>
            where.artifactId.in.map(sessionRecord)
        );
      const artifactFindMany = vi.fn().mockResolvedValue([]);
      const transcriptFindMany = vi.fn().mockResolvedValue([]);
      installDb({
        sessionDetail: { findMany: sessionDetailFindMany },
        artifact: { findMany: artifactFindMany },
        sessionTranscript: { findMany: transcriptFindMany },
      });

      const inputs = await readAgentSessionDetailInputs(
        { organizationId: ORGANIZATION_ID, ids },
        { includeActivitySegments: false, includeAuthoritativeCost: false }
      );

      expect(inputs.map((input) => input.record.artifactId)).toEqual(ids);
      // The stored-row read is chunked (its select is wide), so it costs one read
      // per chunk — never one per session. The companion reads are one each for
      // the whole population, whatever its size.
      expect(sessionDetailFindMany).toHaveBeenCalledTimes(
        expectedStoredRowReads
      );
      expect(artifactFindMany).toHaveBeenCalledTimes(1);
      expect(transcriptFindMany).toHaveBeenCalledTimes(1);
    }
  );

  it("asks for every session's stored row under one org-scoped predicate", async () => {
    const sessionDetailFindMany = vi
      .fn()
      .mockResolvedValue([sessionRecord("session-0")]);
    installDb({
      sessionDetail: { findMany: sessionDetailFindMany },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await readAgentSessionDetailInputs({
      organizationId: ORGANIZATION_ID,
      ids: ["session-0", "session-1", "session-0"],
    });

    expect(sessionDetailFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          // Duplicated ids collapse — a Branch can link the same session twice.
          artifactId: { in: ["session-0", "session-1"] },
          artifact: { is: { organizationId: ORGANIZATION_ID } },
        },
      })
    );
  });

  it("routes each session's transcript rows to that session", async () => {
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            sessionRecord("session-0"),
            sessionRecord("session-1"),
          ]),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([transcriptRow("session-1", "main")]),
      },
    });

    const inputs = await readAgentSessionDetailInputs({
      organizationId: ORGANIZATION_ID,
      ids: ["session-0", "session-1"],
    });

    expect(
      inputs.map((input) => input.transcriptRows.map((row) => row.fileKey))
    ).toEqual([[], ["main"]]);
  });

  it("chunks the companion predicates, and still resolves every session", async () => {
    const populationSize = SESSION_IDENTITY_READ_BATCH_SIZE * 2 + 1;
    const ids = Array.from(
      { length: populationSize },
      (_unused, index) => `session-${index}`
    );
    const artifactFindMany = vi.fn().mockResolvedValue([]);
    const transcriptFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockImplementation(
            async ({ where }: { where: { artifactId: { in: string[] } } }) =>
              where.artifactId.in.map(sessionRecord)
          ),
      },
      artifact: { findMany: artifactFindMany },
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const inputs = await readAgentSessionDetailInputs(
      { organizationId: ORGANIZATION_ID, ids },
      { includeActivitySegments: false, includeAuthoritativeCost: false }
    );

    // The chunk bounds the STATEMENT, not the population: every requested
    // session is still resolved.
    expect(inputs.map((input) => input.record.artifactId)).toEqual(ids);
    const expectedChunks = Math.ceil(
      populationSize / SESSION_IDENTITY_READ_BATCH_SIZE
    );
    expect(transcriptFindMany).toHaveBeenCalledTimes(expectedChunks);
    expect(widestTranscriptPredicate(transcriptFindMany)).toBeLessThanOrEqual(
      SESSION_IDENTITY_READ_BATCH_SIZE
    );
    // The source ids collapse to one distinct artifact here, so the id list
    // cannot be read for chunk width — the call count is what proves the loop.
    expect(artifactFindMany).toHaveBeenCalledTimes(expectedChunks);
  });

  it("abandons the remaining chunks when the caller aborts mid-read", async () => {
    const controller = new AbortController();
    const sessionDetailFindMany = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve([sessionRecord("session-0")]);
    });
    installDb({
      sessionDetail: { findMany: sessionDetailFindMany },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await expect(
      readAgentSessionDetailInputs(
        {
          organizationId: ORGANIZATION_ID,
          ids: Array.from(
            { length: SESSION_DETAIL_READ_BATCH_SIZE * 3 },
            (_unused, index) => `session-${index}`
          ),
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow();
    // Three chunks were due; the abort landed during the first, so the other
    // two must never have been issued.
    expect(sessionDetailFindMany).toHaveBeenCalledTimes(1);
  });

  /**
   * ISS-7229 wiring, at the call site ISS-9112 moved it to. The precedence
   * itself is pinned by `authoritative-cost-detail-resolution.test.ts`; what
   * these two cases pin is that this read HANDS the stored column to the
   * resolver. Dropping `storedCostUsd` from the call leaves that suite green
   * while every desktop-reported figure silently reverts to the loop-event
   * answer, which is the regression #6406 exists to prevent.
   */
  it("serves the stored column and never reads loop events for it", async () => {
    const loopEventFindFirst = vi.fn().mockResolvedValue(null);
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            sessionRecordWithStoredCost("session-0", 1.234_567),
          ]),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      loopEvent: { findFirst: loopEventFindFirst },
    });

    const inputs = await readAgentSessionDetailInputs({
      organizationId: ORGANIZATION_ID,
      ids: ["session-0"],
    });

    expect(inputs[0]?.authoritativeCostUsd).toBe(1.234_567);
    expect(loopEventFindFirst).not.toHaveBeenCalled();
  });

  it("keeps a stored ZERO, which is a reported measurement and not an absence", async () => {
    const loopEventFindFirst = vi.fn().mockResolvedValue(null);
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([sessionRecordWithStoredCost("session-0", 0)]),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      loopEvent: { findFirst: loopEventFindFirst },
    });

    const inputs = await readAgentSessionDetailInputs({
      organizationId: ORGANIZATION_ID,
      ids: ["session-0"],
    });

    expect(inputs[0]?.authoritativeCostUsd).toBe(0);
    expect(loopEventFindFirst).not.toHaveBeenCalled();
  });

  it("reports an empty column as unknown without reading loop events (ISS-12435)", async () => {
    const loopEventFindFirst = vi.fn().mockResolvedValue(null);
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([sessionRecordWithStoredCost("session-0", null)]),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      loopEvent: { findFirst: loopEventFindFirst },
    });

    const inputs = await readAgentSessionDetailInputs({
      organizationId: ORGANIZATION_ID,
      ids: ["session-0"],
    });

    expect(inputs[0]?.authoritativeCostUsd).toBeNull();
    expect(loopEventFindFirst).not.toHaveBeenCalled();
  });

  it("reads nothing for an empty population", async () => {
    const sessionDetailFindMany = vi.fn().mockResolvedValue([]);
    installDb({ sessionDetail: { findMany: sessionDetailFindMany } });

    const inputs = await readAgentSessionDetailInputs({
      organizationId: ORGANIZATION_ID,
      ids: [],
    });

    expect(inputs).toEqual([]);
    expect(sessionDetailFindMany).not.toHaveBeenCalled();
  });
});

describe("findAgentSessionDetail untracked repositories (PLN-2061 M5)", () => {
  it("carries the session's untracked-repository targets", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([sessionRecord("session-0")]),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: "retained-1",
          after: {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: "prisma/prisma-engines",
            prNumber: 5860,
            url: "https://github.com/prisma/prisma-engines/pull/5860",
            eventKind: MonitoredSessionActivityEventKind.AgentAction,
            occurredAt: "2026-08-31T15:25:46.000Z",
            completeness: BranchActivityEvidenceCompleteness.Complete,
            disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
          },
        },
      ]),
    });

    const detail = await findAgentSessionDetail({
      id: "session-0",
      organizationId: ORGANIZATION_ID,
    });

    expect(detail?.untrackedRepositoryTargets).toEqual([
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "prisma/prisma-engines",
        prNumber: 5860,
        url: "https://github.com/prisma/prisma-engines/pull/5860",
      },
    ]);
  });

  it("omits the key when the session has none", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([sessionRecord("session-0")]),
      },
    });

    const detail = await findAgentSessionDetail({
      id: "session-0",
      organizationId: ORGANIZATION_ID,
    });

    expect(detail).not.toBeNull();
    expect(detail ?? {}).not.toHaveProperty("untrackedRepositoryTargets");
  });

  it("still serves the session, without the key, when that read fails", async () => {
    const logError = vi.spyOn(log, "error").mockImplementation(() => undefined);
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([sessionRecord("session-0")]),
      },
      $queryRaw: vi.fn().mockRejectedValue(new Error("pool timeout")),
    });

    try {
      const detail = await findAgentSessionDetail({
        id: "session-0",
        organizationId: ORGANIZATION_ID,
      });

      expect(detail?.id).toBe("session-0");
      expect(detail ?? {}).not.toHaveProperty("untrackedRepositoryTargets");
    } finally {
      logError.mockRestore();
    }
  });
});

function sessionRecord(artifactId: string): Record<string, unknown> {
  return buildSessionDetailRecord({
    artifactId,
    externalSessionId: `external-${artifactId}`,
    sourceArtifactId: SOURCE_ARTIFACT_ID,
  });
}

/**
 * A session whose stored `authoritative_cost_usd` is what the caller says, as
 * the driver hands it back: a Decimal, not a number. The `@repo/database` mock
 * this suite installs carries no `Prisma.Decimal`, and the resolver only ever
 * calls `toNumber()` on the value, so that one method is the whole stand-in — a
 * real Decimal would add arithmetic nothing here reads.
 */
function sessionRecordWithStoredCost(
  artifactId: string,
  storedCostUsd: number | null
): Record<string, unknown> {
  return {
    ...sessionRecord(artifactId),
    sourceLoopId: SOURCE_LOOP_ID,
    authoritativeCostUsd:
      storedCostUsd === null ? null : { toNumber: () => storedCostUsd },
  };
}

/** The most session identities any one transcript statement's `OR` carried. */
function widestTranscriptPredicate(
  transcriptFindMany: ReturnType<typeof vi.fn>
): number {
  return Math.max(
    ...transcriptFindMany.mock.calls.map(
      (call) => (call[0] as { where: { OR: unknown[] } }).where.OR.length
    )
  );
}

function transcriptRow(artifactId: string, fileKey: string) {
  return {
    fileKey,
    uploadStatus: "uploaded",
    uploadedAt: new Date("2026-05-20T17:05:00.000Z"),
    lastObservedAt: new Date("2026-05-20T17:05:00.000Z"),
    permanentFailureReason: null,
    computeTargetId: "target-1",
    externalSessionId: `external-${artifactId}`,
  };
}
