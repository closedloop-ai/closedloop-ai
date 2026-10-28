import { AgentComponentFindingsDisposition } from "@repo/api/src/types/agent-component-findings-disposition";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
} from "@repo/api/src/types/agent-component-invocation";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import type { StagedInvocationRow } from "./component-invocation-helpers";
import {
  mapInvocationCreate,
  toSyncItem,
} from "./component-invocation-wire-row";

const externalSessionId = "session-1";

/**
 * ISS-10718's `succeeded` only rides a Hook firing (`SUCCESS_BEARING_INVOCATION_KINDS`),
 * and none of the fields this file exercises are kind-gated, so Hook is the one
 * kind every case below can share.
 */
function baseItem(): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: "invocation-1",
    sourceSessionId: externalSessionId,
    kind: AgentComponentInvocationKind.Hook,
    componentKey: "post-tool-use",
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
 * The row shape ingest reads back, built the same way the sibling round-trip
 * suite (`component-invocation-wire-row.test.ts`) does: run the item through
 * the real `mapInvocationCreate` and reshape its output into a
 * `StagedInvocationRow`, rather than hand-rolling the persisted values.
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
    usageMeasurement: created.usageMeasurement,
    linesAdded: created.linesAdded,
    linesRemoved: created.linesRemoved,
    succeeded: created.succeeded,
    findingsEmitted: created.findingsEmitted,
    findingsInvalidated: created.findingsInvalidated,
    attributionSource: created.attributionSource,
    findingsDisposition: created.findingsDisposition,
  };
}

describe("toSyncItem optional-field presence", () => {
  it("emits every producer-optional wire field once its stored column is populated", () => {
    const item: AgentComponentInvocationSyncItem = {
      ...baseItem(),
      childSessionId: "child-session-1",
      parentExternalInvocationId: "parent-invocation-1",
      externalAgentId: "agent-1",
      rawName: "PostToolUse",
      providerInvocationId: "provider-invocation-1",
      sourceModifiedAt: "2026-08-01T00:00:00.000Z",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repositoryCommit: "a".repeat(40),
      packId: "pack-1",
      succeeded: true,
      attributionSource: AgentComponentInvocationAttributionSource.HarnessOtel,
    };

    const roundTripped = toSyncItem(persistedRow(item));

    expect(roundTripped).toEqual(item);
    expect(Object.hasOwn(roundTripped, "childSessionId")).toBe(true);
    expect(Object.hasOwn(roundTripped, "parentExternalInvocationId")).toBe(
      true
    );
    expect(Object.hasOwn(roundTripped, "externalAgentId")).toBe(true);
    expect(Object.hasOwn(roundTripped, "rawName")).toBe(true);
    expect(Object.hasOwn(roundTripped, "providerInvocationId")).toBe(true);
    expect(Object.hasOwn(roundTripped, "sourceModifiedAt")).toBe(true);
    expect(Object.hasOwn(roundTripped, "repositoryFullName")).toBe(true);
    expect(Object.hasOwn(roundTripped, "repositoryCommit")).toBe(true);
    expect(Object.hasOwn(roundTripped, "packId")).toBe(true);
    expect(Object.hasOwn(roundTripped, "succeeded")).toBe(true);
    expect(Object.hasOwn(roundTripped, "attributionSource")).toBe(true);
  });

  it("round-trips the ISS-11325 findings disposition beside its counts, and omits it when absent", () => {
    const withDisposition: AgentComponentInvocationSyncItem = {
      ...baseItem(),
      findingsEmitted: 3,
      findingsInvalidated: 1,
      findingsDisposition: AgentComponentFindingsDisposition.CarriedForward,
    };

    const roundTripped = toSyncItem(persistedRow(withDisposition));

    expect(roundTripped).toEqual(withDisposition);
    expect(roundTripped.findingsDisposition).toBe("carried-forward");
    expect(Object.hasOwn(roundTripped, "findingsDisposition")).toBe(true);

    // The withheld shape: a reason and NO counts, which is the row the whole
    // column exists for. It must survive the trip without the projection
    // inventing a pair to go with the label.
    const withheld: AgentComponentInvocationSyncItem = {
      ...baseItem(),
      findingsDisposition: AgentComponentFindingsDisposition.WithheldByteGated,
    };
    const withheldRoundTripped = toSyncItem(persistedRow(withheld));
    expect(withheldRoundTripped).toEqual(withheld);
    expect(Object.hasOwn(withheldRoundTripped, "findingsEmitted")).toBe(false);

    // ABSENT STAYS ABSENT: an older Desktop sends no disposition, the column is
    // NULL, and the key must be OMITTED rather than serialized as null — which
    // would also change the generation hash the cloud recomputes.
    const bare = toSyncItem(persistedRow(baseItem()));
    expect(Object.hasOwn(bare, "findingsDisposition")).toBe(false);
  });

  it("persists and reads back a null invokedAt as an explicit key, not an omission", () => {
    // `invokedAt` alone is nullable rather than optional (a minimal harness
    // may prove an occurrence with no invocation timestamp), so both the
    // write-side ternary and the read-side nullish-coalesce have a NULL arm
    // distinct from every other optional field's omission arm above.
    const item: AgentComponentInvocationSyncItem = {
      ...baseItem(),
      invokedAt: null,
    };

    const created = mapInvocationCreate("generation-1", "part-1", item);
    expect(created.invokedAt).toBeNull();

    const roundTripped = toSyncItem(persistedRow(item));

    expect(roundTripped.invokedAt).toBeNull();
    expect(Object.hasOwn(roundTripped, "invokedAt")).toBe(true);
    expect(roundTripped).toEqual(item);
  });
});
