import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  agentComponentInvocationGenerationHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncItemSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import type { StagedInvocationRow } from "./component-invocation-helpers";
import {
  mapInvocationCreate,
  toSyncItem,
} from "./component-invocation-wire-row";

const externalSessionId = "session-1";

/**
 * FEA-3981 (ISS-4976). Ingest re-derives `externalGenerationId` from the rows it
 * just persisted and rejects the whole generation when it does not match the id
 * the producer sent. So the wire -> row -> wire round trip has to be exact, not
 * merely lossless in the fields a reader happens to look at: a telemetry column
 * dropped from the select, widened differently, or written back as `null`
 * instead of an omitted key produces a different canonical JSON and turns every
 * generation carrying it into a permanent `generation_conflict`.
 */
describe("component invocation wire <-> row round trip", () => {
  it("round-trips per-invocation telemetry byte-identically", () => {
    const item = itemWithTelemetry();
    const parsed = agentComponentInvocationSyncItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);

    const roundTripped = toSyncItem(persistedRow(item));

    expect(roundTripped).toEqual(item);
    expect(preimage(roundTripped)).toBe(preimage(item));
  });

  it("preserves omission for an old producer that sends no telemetry", () => {
    const item = baseItem();
    expect(agentComponentInvocationSyncItemSchema.safeParse(item).success).toBe(
      true
    );

    const created = mapInvocationCreate("generation-1", "part-1", item);
    // An absent optional field persists as NULL, never as a serialized null.
    expect(created.model).toBeNull();
    expect(created.inputTokens).toBeNull();
    expect(created.estimatedCost).toBeNull();
    expect(created.footprintTokens).toBeNull();

    const roundTripped = toSyncItem(persistedRow(item));

    expect(roundTripped).toEqual(item);
    expect(Object.hasOwn(roundTripped, "model")).toBe(false);
    expect(Object.hasOwn(roundTripped, "inputTokens")).toBe(false);
    expect(Object.hasOwn(roundTripped, "estimatedCost")).toBe(false);
    expect(Object.hasOwn(roundTripped, "footprintTokens")).toBe(false);
    expect(preimage(roundTripped)).toBe(preimage(item));
  });

  it("keeps the generation identity of an old payload unchanged", () => {
    // The identity is a hash of the item set, so a build that adds telemetry
    // re-identifies the generation and restages it. A build that adds NOTHING
    // must hash exactly as it did before the fields existed.
    expect(preimage(baseItem())).toBe(
      agentComponentInvocationGenerationHashPreimage({
        externalSessionId,
        items: [
          {
            externalInvocationId: "invocation-1",
            sourceSessionId: externalSessionId,
            kind: AgentComponentInvocationKind.Tool,
            componentKey: "Read",
            relationship: AgentComponentInvocationRelationship.Direct,
            invokedAt: "2026-08-03T16:00:00.000Z",
            sequence: 0,
            anchor: {
              kind: AgentComponentInvocationAnchorKind.Event,
              eventId: "event-1",
            },
            status: AgentComponentInvocationAttributionStatus.Unresolved,
            evidenceClass: AgentComponentInvocationEvidenceClass.None,
          },
        ],
      })
    );
  });

  it("maps a cost the persisted scale would round back to the sent value", () => {
    const item = { ...itemWithTelemetry(), estimatedCost: 0.000_001 };

    expect(toSyncItem(persistedRow(item)).estimatedCost).toBe(0.000_001);
  });
});

describe("component invocation telemetry boundary schema", () => {
  it("rejects a cost the persisted numeric(14, 6) column would round", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...itemWithTelemetry(),
      estimatedCost: 0.123_456_7,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a cost beyond what the persisted column can hold", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...itemWithTelemetry(),
      estimatedCost: 100_000_000,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects negative and fractional token counts", () => {
    for (const inputTokens of [-1, 1.5]) {
      expect(
        agentComponentInvocationSyncItemSchema.safeParse({
          ...itemWithTelemetry(),
          inputTokens,
        }).success
      ).toBe(false);
    }
  });

  it("rejects a token count past the safe-integer range", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...itemWithTelemetry(),
      footprintTokens: Number.MAX_SAFE_INTEGER + 2,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown field rather than silently dropping it", () => {
    // The strict boundary is why the keys-covered guard in the schema module
    // exists: a field added to the sync item and not to the schema would reject
    // the ENTIRE part here, taking the whole generation down with it.
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...baseItem(),
      someFutureTelemetryField: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it("still accepts telemetry on a non-versionable tool occurrence", () => {
    // Footprint tokens are computed for every kind, so the provenance-evidence
    // guard must not treat telemetry as version attribution.
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...baseItem(),
      footprintTokens: 512,
    });

    expect(parsed.success).toBe(true);
  });
});

function preimage(item: AgentComponentInvocationSyncItem): string {
  return agentComponentInvocationGenerationHashPreimage({
    externalSessionId,
    items: [item],
  });
}

function baseItem(): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: "invocation-1",
    sourceSessionId: externalSessionId,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-08-03T16:00:00.000Z",
    sequence: 0,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

/**
 * ISS-4976 (@wongk review): the model, the four token counts, and the cost are
 * per-SUBAGENT-TURN usage in both Prisma schemas, so only a subagent invocation
 * may carry them. `footprintTokens` is the kind-agnostic footprint metric.
 */
function itemWithTelemetry(): AgentComponentInvocationSyncItem {
  return {
    ...baseItem(),
    kind: AgentComponentInvocationKind.Subagent,
    model: "claude-opus-5",
    inputTokens: 12_345,
    outputTokens: 678,
    cacheReadTokens: 90_123,
    cacheWriteTokens: 0,
    estimatedCost: 1.234_567,
    footprintTokens: 4096,
  };
}

/**
 * The row shape ingest reads back: token counts widen to `BigInt`, the cost
 * lands in a `numeric(14, 6)` Decimal, and absent optionals are NULL.
 */
function persistedRow(
  item: AgentComponentInvocationSyncItem
): StagedInvocationRow {
  const created = mapInvocationCreate("generation-1", "part-1", item);
  return {
    id: "row-1",
    externalInvocationId: created.externalInvocationId,
    sourceSessionId: created.sourceSessionId,
    childSessionId: created.childSessionId,
    parentExternalInvocationId: created.parentExternalInvocationId,
    externalAgentId: created.externalAgentId,
    componentKind: created.componentKind,
    componentKey: created.componentKey,
    rawName: created.rawName,
    normalizedName: created.normalizedName,
    relationship: created.relationship,
    invokedAt: created.invokedAt,
    sequence: created.sequence,
    anchor: created.anchor,
    providerInvocationId: created.providerInvocationId,
    attributionStatus: created.attributionStatus,
    evidenceClass: created.evidenceClass,
    definitionHash: created.definitionHash,
    normalizerContractVersion: created.normalizerContractVersion,
    definitionContent: created.definitionContent,
    definitionFormat: created.definitionFormat,
    sourcePath: created.sourcePath,
    sourceModifiedAt: created.sourceModifiedAt,
    capturedAt: created.capturedAt,
    repositoryFullName: created.repositoryFullName,
    repositoryCommit: created.repositoryCommit,
    packId: created.packId,
    branchName: created.branchName,
    model: created.model,
    inputTokens: created.inputTokens,
    outputTokens: created.outputTokens,
    cacheReadTokens: created.cacheReadTokens,
    cacheWriteTokens: created.cacheWriteTokens,
    estimatedCost:
      created.estimatedCost === null
        ? null
        : new Prisma.Decimal(created.estimatedCost.toFixed(6)),
    footprintTokens: created.footprintTokens,
  };
}
