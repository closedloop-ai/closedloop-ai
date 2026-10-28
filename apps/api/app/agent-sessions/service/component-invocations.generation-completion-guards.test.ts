import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationKind,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  SESSION_ID,
  SOURCE_UPDATED_AT,
  sha256,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { serializedBytes } from "./component-invocation-helpers";
import { agentComponentInvocationsService } from "./component-invocations";

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

/**
 * A part carrying its own explicit identity rather than one `buildPart`
 * derives from `allItems`, so a fixture can seed a generation row under an
 * arbitrary identity and then send a matching part for it directly.
 */
function buildCustomIdentityPart(input: {
  externalGenerationId: string;
  partIndex: number;
  partCount: number;
  items: AgentComponentInvocationSyncItem[];
}): AgentComponentInvocationSyncPart {
  const withoutHash = {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: EXTERNAL_SESSION_ID,
    externalGenerationId: input.externalGenerationId,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    dataRevision: 35,
    sourceSequence: 1,
    partIndex: input.partIndex,
    partCount: input.partCount,
    items: input.items,
  };
  return {
    ...withoutHash,
    partHash: sha256(agentComponentInvocationSyncPartHashPreimage(withoutHash)),
  };
}

describe("agentComponentInvocationsService.ingestPart generation-completion guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
    mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
      "source-occurrence-1"
    );
  });

  it("returns zero relinked rows when the raw repair query finds no matching invocations", async () => {
    const { db } = installStatefulDb();

    const count =
      await agentComponentInvocationsService.relinkActiveForComputeTarget({
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
      });

    expect(count).toBe(0);
    // The stub's default `$queryRaw` resolves `[]` regardless of args, so a
    // bare zero-count assertion can't tell a correctly org/target-scoped
    // no-match apart from a query that never bound either scope at all.
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const statement = db.$queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
    expect(statement.values).toEqual(
      expect.arrayContaining([ORGANIZATION_ID, COMPUTE_TARGET_ID])
    );
  });

  it("rejects a retry that changes the generation's already-staged declared part count", async () => {
    installStatefulDb();
    const first = buildItem({ externalInvocationId: "inv-1", sequence: 0 });
    const second = buildItem({ externalInvocationId: "inv-2", sequence: 1 });
    const part0 = buildPart({
      allItems: [first, second],
      items: [first],
      partIndex: 0,
      partCount: 2,
    });
    await ingest(part0);

    const conflicting = buildPart({
      allItems: [first, second],
      items: [second],
      partIndex: 1,
      partCount: 3,
    });
    const result = await ingest(conflicting);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
  });

  it("activates a one-part generation that carries zero staged invocations", async () => {
    const { db, invocations } = installStatefulDb();
    const emptyPart = buildPart({ allItems: [], items: [], partCount: 1 });

    const result = await ingest(emptyPart);

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(invocations).toHaveLength(0);
    expect(db.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: SESSION_ID },
      data: { componentInvocationCount: 0 },
      select: { artifactId: true },
    });
  });

  it("rejects a generation whose stored invocation rows disagree with its parts' declared item counts", async () => {
    const part = buildPart({ allItems: [buildItem()], partCount: 1 });
    const corruptGeneration: GenerationRow = {
      id: "corrupt-generation",
      agentSessionId: SESSION_ID,
      externalGenerationId: part.externalGenerationId,
      sourceUpdatedAt: new Date(part.sourceUpdatedAt),
      dataRevision: part.dataRevision,
      sourceSequence: part.sourceSequence,
      expectedPartCount: 1,
      activeAt: null,
      completedAt: null,
      updatedAt: new Date(SOURCE_UPDATED_AT),
    };
    const { parts, invocations } = installStatefulDb({
      generations: [corruptGeneration],
    });
    // Directly seed the part ledger and TWO invocation rows for a part that
    // only ever declared itemCount 1 — storage corruption a defensive
    // re-check catches, never a shape `ingestPart` itself can produce.
    parts.push({
      id: "corrupt-part",
      generationId: "corrupt-generation",
      partIndex: 0,
      partHash: part.partHash,
      itemCount: 1,
      payloadBytes: serializedBytes(part),
    });
    invocations.push(
      {
        id: "ghost-1",
        generationId: "corrupt-generation",
        partId: "corrupt-part",
        externalInvocationId: "ghost-1",
        sequence: 0,
      },
      {
        id: "ghost-2",
        generationId: "corrupt-generation",
        partId: "corrupt-part",
        externalInvocationId: "ghost-2",
        sequence: 1,
      }
    );

    const result = await ingest(part);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
  });

  it("rejects staging a new part once the generation's item cap is already reached", async () => {
    const capGeneration: GenerationRow = {
      id: "cap-generation",
      agentSessionId: SESSION_ID,
      externalGenerationId: "c".repeat(64),
      sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
      dataRevision: 35,
      sourceSequence: 1,
      expectedPartCount: 2,
      activeAt: null,
      completedAt: null,
      updatedAt: new Date(SOURCE_UPDATED_AT),
    };
    const { parts } = installStatefulDb({
      generations: [capGeneration],
    });
    // ISS-12781: a part's items are staged on its ledger row, so the cap reads
    // the ledger's item counts — seed one part already holding the cap.
    parts.push({
      id: "cap-part-0",
      generationId: "cap-generation",
      partIndex: 0,
      partHash: "e".repeat(64),
      itemCount: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
      payloadBytes: 1,
      stagedItems: [],
    });
    const overCapPart = buildCustomIdentityPart({
      externalGenerationId: "c".repeat(64),
      partIndex: 1,
      partCount: 2,
      items: [
        buildItem({
          externalInvocationId: "over-cap-1",
          sequence: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
        }),
        buildItem({
          externalInvocationId: "over-cap-2",
          sequence: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS + 1,
        }),
      ],
    });

    const result = await ingest(overCapPart);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    });
    expect(parts.map((row) => row.id)).toEqual(["cap-part-0"]);
  });

  it("rejects staging a new part once the generation's staged-byte budget is already reached", async () => {
    const bytesGeneration: GenerationRow = {
      id: "bytes-generation",
      agentSessionId: SESSION_ID,
      externalGenerationId: "d".repeat(64),
      sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
      dataRevision: 35,
      sourceSequence: 1,
      expectedPartCount: 2,
      activeAt: null,
      completedAt: null,
      updatedAt: new Date(SOURCE_UPDATED_AT),
    };
    const { parts } = installStatefulDb({ generations: [bytesGeneration] });
    parts.push({
      id: "bytes-part-0",
      generationId: "bytes-generation",
      partIndex: 0,
      partHash: "0".repeat(64),
      itemCount: 1,
      payloadBytes: AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES,
    });
    const overBudgetPart = buildCustomIdentityPart({
      externalGenerationId: "d".repeat(64),
      partIndex: 1,
      partCount: 2,
      items: [buildItem({ externalInvocationId: "over-budget-item" })],
    });

    const result = await ingest(overBudgetPart);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    });
  });

  it("rejects a generation whose staged definition content no longer hashes to its claimed identity", async () => {
    installStatefulDb();
    const item = buildItem({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review",
      definitionContent: "# Code review\n\nReview only real bugs.\n",
      definitionHash: "0".repeat(64),
      normalizerContractVersion: 1,
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
    expect(mocks.ensureDefinitionVersion).not.toHaveBeenCalled();
  });
});
