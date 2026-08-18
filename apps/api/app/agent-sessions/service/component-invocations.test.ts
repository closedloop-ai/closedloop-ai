import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { SourceAccessState, SourceOccurrenceType } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  });
  const withDb = Object.assign(vi.fn(), { tx: mocks.tx });
  return {
    Prisma: { sql },
    SourceAccessState: { accessible: "accessible" },
    SourceOccurrenceType: {
      local: "local",
      repository: "repository",
      pack: "pack",
    },
    withDb,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError },
}));

vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  EXTERNAL_SESSION_ID,
  type GenerationRow,
  generationId,
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  resolutionUpdatesFrom,
  SESSION_ID,
  SOURCE_UPDATED_AT,
  sha256,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { agentComponentInvocationsService } from "./component-invocations";

/** Bind the shared in-memory store to THIS file's hoisted `withDb.tx` spy. */
const installStatefulDb: (
  input?: Parameters<typeof installStatefulDbStore>[1]
) => ReturnType<typeof installStatefulDbStore> = (input) =>
  installStatefulDbStore(mocks.tx, input);

function ingest(part: AgentComponentInvocationSyncPart) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORGANIZATION_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });
}

describe("agentComponentInvocationsService.ingestPart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
    mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
      "source-occurrence-1"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a part whose shared canonical hash does not match before opening a transaction", async () => {
    const part = buildPart({ allItems: [buildItem()] });
    part.partHash = "0".repeat(64);

    const result = await ingest(part);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    });
    expect(mocks.tx).not.toHaveBeenCalled();
  });

  it("scopes session resolution through the authenticated org and compute target", async () => {
    const { db } = installStatefulDb({ sessionExists: false });

    const result = await ingest(buildPart({ allItems: [buildItem()] }));

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.SessionMissing,
    });
    expect(db.sessionDetail.findFirst).toHaveBeenCalledWith({
      where: {
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
        artifact: { organizationId: ORGANIZATION_ID },
      },
      select: { artifactId: true },
    });
  });

  it("stages an incomplete generation without replacing the active generation", async () => {
    const activeGeneration = buildActiveGeneration({
      externalGenerationId: "a".repeat(64),
      sourceUpdatedAt: "2026-07-22T11:00:00.000Z",
    });
    const { db, generations } = installStatefulDb({ activeGeneration });
    const first = buildItem({
      externalInvocationId: "invocation-1",
      sequence: 0,
    });
    const second = buildItem({
      externalInvocationId: "invocation-2",
      sequence: 1,
    });

    const result = await ingest(
      buildPart({
        allItems: [first, second],
        items: [first],
        partCount: 2,
      })
    );

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    expect(activeGeneration.activeAt).not.toBeNull();
    expect(generations).toHaveLength(2);
    expect(
      db.agentComponentInvocationGeneration.updateMany
    ).not.toHaveBeenCalled();
  });

  it("removes only expired incomplete generations inside the locked session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const first = buildItem({
      externalInvocationId: "invocation-1",
      sequence: 0,
    });
    const second = buildItem({
      externalInvocationId: "invocation-2",
      sequence: 1,
    });
    const currentPart = buildPart({
      allItems: [first, second],
      items: [first],
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T13:00:00.000Z",
      sourceSequence: 2,
    });
    const oldTimestamp = new Date("2026-07-22T12:00:00.000Z");
    const freshTimestamp = new Date("2026-07-24T00:00:00.000Z");
    const { db, generations } = installStatefulDb({
      generations: [
        buildGenerationFixture({
          id: "stale-incomplete",
          externalGenerationId: "stale-incomplete-generation",
          updatedAt: oldTimestamp,
        }),
        buildGenerationFixture({
          id: "active-generation",
          externalGenerationId: "active-generation",
          activeAt: oldTimestamp,
          completedAt: oldTimestamp,
          updatedAt: oldTimestamp,
        }),
        buildGenerationFixture({
          id: "completed-generation",
          externalGenerationId: "completed-generation",
          completedAt: oldTimestamp,
          updatedAt: oldTimestamp,
        }),
        buildGenerationFixture({
          id: "current-incomplete",
          externalGenerationId: currentPart.externalGenerationId,
          sourceUpdatedAt: new Date(currentPart.sourceUpdatedAt),
          sourceSequence: currentPart.sourceSequence,
          expectedPartCount: currentPart.partCount,
          updatedAt: oldTimestamp,
        }),
        buildGenerationFixture({
          id: "fresh-incomplete",
          externalGenerationId: "fresh-incomplete-generation",
          updatedAt: freshTimestamp,
        }),
      ],
    });

    const result = await ingest(currentPart);

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    expect(generations.map((generation) => generation.id)).toEqual([
      "active-generation",
      "completed-generation",
      "current-incomplete",
      "fresh-incomplete",
    ]);
    expect(
      db.agentComponentInvocationGeneration.deleteMany
    ).toHaveBeenCalledWith({
      where: {
        agentSessionId: SESSION_ID,
        externalGenerationId: { not: currentPart.externalGenerationId },
        activeAt: null,
        completedAt: null,
        updatedAt: { lt: new Date("2026-07-23T12:00:00.000Z") },
      },
    });
    expect(
      db.agentComponentInvocationGeneration.upsert.mock.invocationCallOrder[0]
    ).toBeGreaterThan(
      db.agentComponentInvocationGeneration.deleteMany.mock
        .invocationCallOrder[0] ?? 0
    );
  });

  it("activates only after every immutable part arrives and treats an identical retry as a no-op", async () => {
    const activeGeneration = buildActiveGeneration({
      externalGenerationId: "a".repeat(64),
      sourceUpdatedAt: "2026-07-22T11:00:00.000Z",
    });
    const { generations, invocations } = installStatefulDb({
      activeGeneration,
    });
    const first = buildItem({
      externalInvocationId: "invocation-1",
      sequence: 0,
    });
    const second = buildItem({
      externalInvocationId: "invocation-2",
      sequence: 1,
    });
    const part0 = buildPart({
      allItems: [first, second],
      items: [first],
      partCount: 2,
    });
    const part1 = buildPart({
      allItems: [first, second],
      items: [second],
      partIndex: 1,
      partCount: 2,
    });

    await ingest(part0);
    const activated = await ingest(part1);
    const retried = await ingest(part1);

    expect(activated).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(retried).toEqual(activated);
    expect(invocations).toHaveLength(2);
    expect(activeGeneration.activeAt).toBeNull();
    const newGeneration = generations.find(
      (row) => row.externalGenerationId === part0.externalGenerationId
    );
    expect(newGeneration?.activeAt).not.toBeNull();
    expect(newGeneration?.completedAt).not.toBeNull();
    expect(generations).toHaveLength(1);
  });

  it("reactivates recurring content with newer freshness and retains only the active generation", async () => {
    const { generations, invocations } = installStatefulDb();
    const first = buildItem();
    const second = buildItem({
      externalInvocationId: "invocation-2",
      sequence: 1,
    });

    const firstActivation = await ingest(
      buildPart({
        allItems: [first],
        sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
        sourceSequence: 1,
      })
    );
    const secondActivation = await ingest(
      buildPart({
        allItems: [first, second],
        sourceUpdatedAt: "2026-07-22T12:01:00.000Z",
        sourceSequence: 2,
      })
    );
    const recurringActivation = await ingest(
      buildPart({
        allItems: [first],
        sourceUpdatedAt: "2026-07-22T12:02:00.000Z",
        sourceSequence: 3,
      })
    );

    expect(firstActivation.ok).toBe(true);
    expect(secondActivation.ok).toBe(true);
    expect(recurringActivation).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.externalGenerationId).toBe(generationId([first]));
    expect(generations[0]?.sourceSequence).toBe(3);
    expect(invocations).toHaveLength(1);
  });

  it("lets recurring active content supersede a newer partial generation", async () => {
    const { generations } = installStatefulDb();
    const recurringItem = buildItem({
      externalInvocationId: "recurring-active-invocation",
    });
    const partialFirst = buildItem({
      externalInvocationId: "partial-invocation-1",
      sequence: 0,
    });
    const partialSecond = buildItem({
      externalInvocationId: "partial-invocation-2",
      sequence: 1,
    });

    expect(
      await ingest(
        buildPart({
          allItems: [recurringItem],
          sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
          sourceSequence: 1,
        })
      )
    ).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });

    const partialPart0 = buildPart({
      allItems: [partialFirst, partialSecond],
      items: [partialFirst],
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T12:01:00.000Z",
      sourceSequence: 2,
    });
    const partialPart1 = buildPart({
      allItems: [partialFirst, partialSecond],
      items: [partialSecond],
      partIndex: 1,
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T12:01:00.000Z",
      sourceSequence: 2,
    });
    expect(await ingest(partialPart0)).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });

    const recurringActivation = await ingest(
      buildPart({
        allItems: [recurringItem],
        sourceUpdatedAt: "2026-07-22T12:02:00.000Z",
        sourceSequence: 3,
      })
    );

    expect(recurringActivation).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(await ingest(partialPart1)).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Stale },
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.externalGenerationId).toBe(
      generationId([recurringItem])
    );
    expect(generations[0]?.sourceSequence).toBe(3);
  });

  it("rejects a conflicting retry without appending a second invocation", async () => {
    const { invocations } = installStatefulDb();
    const original = buildPart({ allItems: [buildItem()] });
    await ingest(original);
    const conflictingItem = buildItem({ rawName: "different bytes" });
    const withoutHash = {
      ...original,
      items: [conflictingItem],
    };
    const conflicting = {
      ...withoutHash,
      partHash: sha256(
        agentComponentInvocationSyncPartHashPreimage(withoutHash)
      ),
    };

    const result = await ingest(conflicting);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.PartConflict,
    });
    expect(invocations).toHaveLength(1);
  });

  it("rejects an invocation ID reused by a different part in the same generation", async () => {
    const { invocations, parts } = installStatefulDb();
    const first = buildItem({ sequence: 0 });
    const duplicate = buildItem({ sequence: 1, rawName: "second occurrence" });
    const part0 = buildPart({
      allItems: [first, duplicate],
      items: [first],
      partCount: 2,
    });
    const part1 = buildPart({
      allItems: [first, duplicate],
      items: [duplicate],
      partIndex: 1,
      partCount: 2,
    });

    await ingest(part0);
    const result = await ingest(part1);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
    expect(parts).toHaveLength(1);
    expect(invocations).toHaveLength(1);
  });

  it("acknowledges a delayed older complete generation as stale without rolling active history backward", async () => {
    const activeGeneration = buildActiveGeneration({
      externalGenerationId: "b".repeat(64),
      sourceUpdatedAt: "2026-07-22T13:00:00.000Z",
      dataRevision: 35,
      sourceSequence: 2,
    });
    const { generations } = installStatefulDb({ activeGeneration });

    const result = await ingest(
      buildPart({
        allItems: [buildItem()],
        sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
        sourceSequence: 99,
      })
    );

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Stale },
    });
    expect(activeGeneration.activeAt).not.toBeNull();
    expect(generations).toEqual([activeGeneration]);
  });

  it("acks a superseded partial generation idempotently and allows its content to recur", async () => {
    const { generations, invocations } = installStatefulDb();
    const first = buildItem({
      externalInvocationId: "recurring-invocation-1",
      sequence: 0,
    });
    const second = buildItem({
      externalInvocationId: "recurring-invocation-2",
      sequence: 1,
    });
    const oldPart0 = buildPart({
      allItems: [first, second],
      items: [first],
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
      sourceSequence: 1,
    });
    const oldPart1 = buildPart({
      allItems: [first, second],
      items: [second],
      partIndex: 1,
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
      sourceSequence: 1,
    });

    expect(await ingest(oldPart0)).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    const newerItem = buildItem({
      externalInvocationId: "newer-generation-invocation",
    });
    expect(
      await ingest(
        buildPart({
          allItems: [newerItem],
          sourceUpdatedAt: "2026-07-22T13:00:00.000Z",
          sourceSequence: 2,
        })
      )
    ).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });

    const stale = {
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Stale },
    } as const;

    const recurringPart0 = buildPart({
      allItems: [first, second],
      items: [first],
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T14:00:00.000Z",
      sourceSequence: 3,
    });
    const recurringPart1 = buildPart({
      allItems: [first, second],
      items: [second],
      partIndex: 1,
      partCount: 2,
      sourceUpdatedAt: "2026-07-22T14:00:00.000Z",
      sourceSequence: 3,
    });
    expect((await ingest(recurringPart0)).ok).toBe(true);
    expect(generations.at(-1)?.sourceSequence).toBe(3);
    // A delayed old part remains stale but cannot delete the fresher partial.
    expect(await ingest(oldPart1)).toEqual(stale);
    expect(generations.at(-1)?.sourceSequence).toBe(3);
    expect(await ingest(recurringPart1)).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.externalGenerationId).toBe(
      oldPart0.externalGenerationId
    );
    expect(invocations).toHaveLength(2);
  });

  it("forces non-versionable kinds to unresolved with no definition/source links", async () => {
    const tool = buildItem({
      kind: AgentComponentInvocationKind.Tool,
      componentKey: "Read",
      status: AgentComponentInvocationAttributionStatus.Unresolved,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-tool-1",
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: "Read",
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [tool] }));

    expect(result.ok).toBe(true);
    const updates = resolutionUpdatesFrom(db.$executeRaw);
    expect(updates).toEqual([
      expect.objectContaining({
        agentComponentId: "component-tool-1",
        attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
        definitionVersionId: null,
        sourceOccurrenceId: null,
      }),
    ]);
    expect(mocks.ensureDefinitionVersion).not.toHaveBeenCalled();
  });

  it("ensures exact definition content and records only genuine collector provenance", async () => {
    const content = "# Code review\n\nReview only real bugs.\n";
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: AgentComponentInvocationKind.Skill,
    });
    const capturedAt = "2026-07-22T11:58:00.000Z";
    const item = buildItem({
      status: AgentComponentInvocationAttributionStatus.Matched,
      evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
      definitionContent: content,
      definitionFormat: "md",
      definitionHash: fingerprint.definitionHash,
      normalizerContractVersion: fingerprint.normalizerContractVersion,
      sourcePath: "/synthetic/skills/code-review/SKILL.md",
      capturedAt,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-skill-1",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(mocks.ensureDefinitionVersion).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        componentKind: AgentComponentInvocationKind.Skill,
        content,
        format: "md",
        observedAt: new Date(capturedAt),
      })
    );
    expect(mocks.recordDefinitionSourceOccurrence).toHaveBeenCalledWith(db, {
      organizationId: ORGANIZATION_ID,
      definitionVersionId: "definition-version-1",
      occurrenceType: SourceOccurrenceType.local,
      accessState: SourceAccessState.accessible,
      computeTargetId: COMPUTE_TARGET_ID,
      installPath: "/synthetic/skills/code-review/SKILL.md",
      observedAt: new Date(capturedAt),
    });
    expect(resolutionUpdatesFrom(db.$executeRaw)).toEqual([
      expect.objectContaining({
        agentComponentId: "component-skill-1",
        attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
        definitionVersionId: "definition-version-1",
        sourceOccurrenceId: "source-occurrence-1",
      }),
    ]);
  });

  it("resolves repeated exact definition and source evidence with one registry write", async () => {
    const content = "# Code review\n\nReview only real bugs.\n";
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: AgentComponentInvocationKind.Skill,
    });
    const first = buildItem({
      externalInvocationId: "invocation-1",
      sequence: 0,
      status: AgentComponentInvocationAttributionStatus.Matched,
      evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
      definitionContent: content,
      definitionFormat: "md",
      definitionHash: fingerprint.definitionHash,
      normalizerContractVersion: fingerprint.normalizerContractVersion,
      sourcePath: "/synthetic/skills/code-review/SKILL.md",
      capturedAt: "2026-07-22T11:58:00.000Z",
    });
    const second = buildItem({
      ...first,
      externalInvocationId: "invocation-2",
      sequence: 1,
      anchor: { kind: "event", eventId: "event-2" },
      capturedAt: "2026-07-22T11:59:00.000Z",
    });
    installStatefulDb();

    const result = await ingest(buildPart({ allItems: [first, second] }));

    expect(result.ok).toBe(true);
    expect(mocks.ensureDefinitionVersion).toHaveBeenCalledOnce();
    expect(mocks.recordDefinitionSourceOccurrence).toHaveBeenCalledOnce();
    expect(mocks.ensureDefinitionVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        observedAt: new Date("2026-07-22T11:59:00.000Z"),
      })
    );
    expect(mocks.recordDefinitionSourceOccurrence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        observedAt: new Date("2026-07-22T11:59:00.000Z"),
      })
    );
  });

  it("does not mint provenance from transcript-only definition evidence", async () => {
    const content = "Transcript-provided definition";
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: AgentComponentInvocationKind.Skill,
    });
    const item = buildItem({
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionContent: content,
      definitionHash: fingerprint.definitionHash,
      normalizerContractVersion: fingerprint.normalizerContractVersion,
    });
    installStatefulDb();

    await ingest(buildPart({ allItems: [item] }));

    expect(mocks.ensureDefinitionVersion).toHaveBeenCalledOnce();
    expect(mocks.recordDefinitionSourceOccurrence).not.toHaveBeenCalled();
  });
});

describe("agentComponentInvocationsService.relinkActiveForComputeTarget", () => {
  it("runs one set-based repair with authenticated org and target scope", async () => {
    const { db } = installStatefulDb();
    db.$queryRaw.mockResolvedValueOnce([{ count: 2n }]);

    const count =
      await agentComponentInvocationsService.relinkActiveForComputeTarget({
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
      });

    expect(count).toBe(2);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const statement = db.$queryRaw.mock.calls[0]?.[0] as {
      values: unknown[];
    };
    expect(statement.values).toEqual([
      ORGANIZATION_ID,
      COMPUTE_TARGET_ID,
      AgentComponentInvocationAttributionStatus.Unmatched,
      AgentComponentInvocationAttributionStatus.Matched,
      AgentComponentInvocationAttributionStatus.Ambiguous,
      COMPUTE_TARGET_ID,
      ORGANIZATION_ID,
    ]);
  });
});

function buildActiveGeneration(input: {
  externalGenerationId: string;
  sourceUpdatedAt: string;
  dataRevision?: number;
  sourceSequence?: number;
}): GenerationRow {
  return {
    id: "active-generation",
    agentSessionId: SESSION_ID,
    externalGenerationId: input.externalGenerationId,
    sourceUpdatedAt: new Date(input.sourceUpdatedAt),
    dataRevision: input.dataRevision ?? 35,
    sourceSequence: input.sourceSequence ?? 1,
    expectedPartCount: 1,
    activeAt: new Date("2026-07-22T13:00:00.000Z"),
    completedAt: new Date("2026-07-22T13:00:00.000Z"),
    updatedAt: new Date("2026-07-22T13:00:00.000Z"),
  };
}

function buildGenerationFixture(
  overrides: Partial<GenerationRow> &
    Pick<GenerationRow, "id" | "externalGenerationId">
): GenerationRow {
  const { id, externalGenerationId, ...optionalOverrides } = overrides;
  return {
    id,
    agentSessionId: SESSION_ID,
    externalGenerationId,
    sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
    dataRevision: 35,
    sourceSequence: 1,
    expectedPartCount: 1,
    activeAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...optionalOverrides,
  };
}
