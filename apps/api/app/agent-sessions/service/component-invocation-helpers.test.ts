/**
 * ISS-9713 branch coverage for the pure narrowers, comparators, and query
 * builders in component-invocation-helpers.ts. Each case drives the real
 * exported function and asserts an observable return value, thrown error, or
 * (for the query builders) the exact arguments the function passed to its
 * mocked delegate.
 */
import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { SourceAccessState, SourceOccurrenceType } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ackStateForGeneration,
  compareFreshness,
  comparePartFreshness,
  deleteCompletedInactiveGenerations,
  type GenerationRecord,
  genuineSourceOccurrence,
  keepLatestDate,
  persistedAnchor,
  preferredObservedAt,
  type StagedInvocationRow,
  toAttributionStatus,
  toDefinitionComponentKind,
  toEvidenceClass,
  toInvocationKind,
  toInvocationRelationship,
} from "./component-invocation-helpers";

const BASE_GENERATION: GenerationRecord = {
  id: "generation-1",
  agentSessionId: "session-1",
  externalGenerationId: "ext-generation-1",
  sourceUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
  dataRevision: 1,
  sourceSequence: 1,
  expectedPartCount: 1,
  activeAt: null,
  completedAt: null,
};

const BASE_ROW: StagedInvocationRow = {
  id: "invocation-1",
  externalInvocationId: "ext-invocation-1",
  sourceSessionId: "source-session-1",
  childSessionId: null,
  parentExternalInvocationId: null,
  externalAgentId: null,
  componentKind: AgentComponentInvocationKind.Tool,
  componentKey: "my-tool",
  rawName: null,
  normalizedName: null,
  relationship: "direct",
  invokedAt: null,
  sequence: 0,
  anchor: { kind: "session" },
  providerInvocationId: null,
  attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
  evidenceClass: AgentComponentInvocationEvidenceClass.None,
  definitionHash: null,
  normalizerContractVersion: null,
  definitionContent: null,
  definitionFormat: null,
  sourcePath: null,
  sourceModifiedAt: null,
  capturedAt: null,
  repositoryFullName: null,
  repositoryCommit: null,
  packId: null,
  branchName: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimatedCost: null,
  footprintTokens: null,
  usageMeasurement: null,
  linesAdded: null,
  linesRemoved: null,
  succeeded: null,
  findingsEmitted: null,
  findingsInvalidated: null,
  findingsDisposition: null,
  attributionSource: null,
};

describe("ackStateForGeneration", () => {
  it("returns Staged when the generation has never been activated and has not completed", () => {
    const status = ackStateForGeneration({
      ...BASE_GENERATION,
      activeAt: null,
      completedAt: null,
    });

    expect(status).toBe("staged");
  });

  it("returns Stale when the generation has never been activated but has completed", () => {
    const status = ackStateForGeneration({
      ...BASE_GENERATION,
      activeAt: null,
      completedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(status).toBe("stale");
  });
});

describe("compareFreshness", () => {
  it("breaks a sourceUpdatedAt tie by sourceSequence when dataRevision also ties", () => {
    const left: GenerationRecord = {
      ...BASE_GENERATION,
      dataRevision: 5,
      sourceSequence: 2,
    };
    const right: GenerationRecord = {
      ...BASE_GENERATION,
      dataRevision: 5,
      sourceSequence: 7,
    };

    expect(compareFreshness(left, right)).toBe(-5);
  });

  it("breaks a sourceUpdatedAt tie by dataRevision when dataRevision differs", () => {
    const left: GenerationRecord = {
      ...BASE_GENERATION,
      dataRevision: 9,
      sourceSequence: 100,
    };
    const right: GenerationRecord = {
      ...BASE_GENERATION,
      dataRevision: 3,
      sourceSequence: 1,
    };

    expect(compareFreshness(left, right)).toBe(6);
  });
});

describe("genuineSourceOccurrence", () => {
  it("returns a repository occurrence for RepositoryCommit evidence with full evidence fields", () => {
    const observedAt = new Date("2026-01-05T00:00:00.000Z");
    const occurrence = genuineSourceOccurrence(
      {
        ...BASE_ROW,
        evidenceClass: AgentComponentInvocationEvidenceClass.RepositoryCommit,
        repositoryFullName: "org/repo",
        repositoryCommit: "abc123",
        sourcePath: "src/tool.ts",
        capturedAt: observedAt,
      },
      "compute-target-1"
    );

    expect(occurrence).toEqual({
      occurrenceType: SourceOccurrenceType.repository,
      accessState: SourceAccessState.accessible,
      computeTargetId: null,
      installPath: null,
      repoFullName: "org/repo",
      repoPath: "src/tool.ts",
      repoCommit: "abc123",
      observedAt,
    });
  });

  it("returns a pack occurrence for PackMembership evidence with a packId", () => {
    const observedAt = new Date("2026-01-06T00:00:00.000Z");
    const occurrence = genuineSourceOccurrence(
      {
        ...BASE_ROW,
        evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
        packId: "pack-1",
        capturedAt: observedAt,
      },
      "compute-target-1"
    );

    expect(occurrence).toEqual({
      occurrenceType: SourceOccurrenceType.pack,
      accessState: SourceAccessState.accessible,
      computeTargetId: null,
      installPath: null,
      packId: "pack-1",
      observedAt,
    });
  });
});

describe("preferredObservedAt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to the current time when capturedAt, sourceModifiedAt, and invokedAt are all null", () => {
    const now = new Date("2026-03-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const observedAt = preferredObservedAt({
      ...BASE_ROW,
      capturedAt: null,
      sourceModifiedAt: null,
      invokedAt: null,
    });

    expect(observedAt).toEqual(now);
  });
});

describe("persisted-value narrowers", () => {
  it("maps the Subagent definition-backed invocation kind", () => {
    expect(toDefinitionComponentKind("subagent")).toBe("subagent");
  });

  it("throws when a definition-backed invocation kind is not Command, Skill, or Subagent", () => {
    expect(() => toDefinitionComponentKind("tool")).toThrow(
      "Unsupported definition-backed invocation kind: tool"
    );
  });

  it("throws when a persisted invocation kind is not a known value", () => {
    expect(() => toInvocationKind("not-a-real-kind")).toThrow(
      "Invalid persisted invocation kind: not-a-real-kind"
    );
  });

  it("throws when a persisted attribution status is not a known value", () => {
    expect(() => toAttributionStatus("not-a-real-status")).toThrow(
      "Invalid persisted invocation status: not-a-real-status"
    );
  });

  it("throws when a persisted evidence class is not a known value", () => {
    expect(() => toEvidenceClass("not-a-real-evidence")).toThrow(
      "Invalid persisted invocation evidence: not-a-real-evidence"
    );
  });

  it("throws when a persisted invocation relationship is not a known value", () => {
    expect(() => toInvocationRelationship("not-a-real-relationship")).toThrow(
      "Invalid persisted invocation relationship: not-a-real-relationship"
    );
  });

  it("throws when the persisted anchor is not a plain object", () => {
    expect(() => persistedAnchor("not-an-object" as never)).toThrow(
      "Invalid persisted invocation anchor"
    );
  });
});

describe("deleteCompletedInactiveGenerations", () => {
  it("omits the id exclusion filter when there is no active generation to protect", async () => {
    const deleteMany = vi.fn(() => Promise.resolve({ count: 0 }));
    const tx = {
      agentComponentInvocationGeneration: { deleteMany },
    } as unknown as Parameters<typeof deleteCompletedInactiveGenerations>[0];

    await deleteCompletedInactiveGenerations(tx, "session-1", null);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        agentSessionId: "session-1",
        activeAt: null,
        completedAt: { not: null },
      },
    });
  });
});

describe("comparePartFreshness", () => {
  it("breaks a sourceUpdatedAt tie by dataRevision when dataRevision differs", () => {
    const generation: GenerationRecord = {
      ...BASE_GENERATION,
      sourceUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      dataRevision: 2,
      sourceSequence: 1,
    };
    const part = {
      protocolVersion: 1 as const,
      externalSessionId: "ext-session-1",
      externalGenerationId: "ext-generation-1",
      partIndex: 0,
      partCount: 1,
      partHash: "hash-1",
      items: [],
      sourceUpdatedAt: generation.sourceUpdatedAt.toISOString(),
      dataRevision: 9,
      sourceSequence: 1,
    };

    expect(comparePartFreshness(part, generation)).toBe(7);
  });
});

describe("keepLatestDate", () => {
  it("leaves the stored date unchanged when the candidate is not newer", () => {
    const dates = new Map<string, Date>();
    const later = new Date("2026-01-10T00:00:00.000Z");
    const earlier = new Date("2026-01-05T00:00:00.000Z");
    dates.set("key-1", later);

    keepLatestDate(dates, "key-1", earlier);

    expect(dates.get("key-1")).toEqual(later);
  });
});
