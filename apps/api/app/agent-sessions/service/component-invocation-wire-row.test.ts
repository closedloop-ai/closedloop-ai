import { createHash } from "node:crypto";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationGenerationHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncItemSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { Prisma } from "@repo/database";
import { SYNTHETIC_GITHUB_TOKEN } from "@repo/lib/security/synthetic-secrets.test-helpers";
import { describe, expect, it } from "vitest";
import {
  hasProjectedIndexKeyShape,
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import type { StagedInvocationRow } from "./component-invocation-helpers";
import {
  countProjectedIndexKeys,
  GenerationHashVerdict,
  generationHashIsVerifiable,
  generationHashVerdict,
  mapInvocationCreate,
  stagedInvocationRow,
  storedExternalInvocationIds,
  toSyncItem,
} from "./component-invocation-wire-row";

const externalSessionId = "session-1";
const INVALID_PERSISTED_MEASUREMENT = /Invalid persisted usage measurement/;

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

  it("round-trips the findings funnel byte-identically", () => {
    const item = itemWithFindings();
    expect(agentComponentInvocationSyncItemSchema.safeParse(item).success).toBe(
      true
    );

    const roundTripped = toSyncItem(persistedRow(item));

    expect(roundTripped).toEqual(item);
    expect(preimage(roundTripped)).toBe(preimage(item));
  });

  it("round-trips a tool result's verdict, and its absence, byte-identically", () => {
    for (const succeeded of [false, true]) {
      const item = { ...baseItem(), succeeded };
      expect(
        agentComponentInvocationSyncItemSchema.safeParse(item).success
      ).toBe(true);
      const roundTripped = toSyncItem(persistedRow(item));
      expect(roundTripped).toEqual(item);
      expect(preimage(roundTripped)).toBe(preimage(item));
    }
    const legacy = toSyncItem(persistedRow(baseItem()));
    expect(Object.hasOwn(legacy, "succeeded")).toBe(false);
  });

  it("round-trips a measured zero as a measurement, not as absence", () => {
    const item = { ...baseItem(), findingsEmitted: 0, findingsInvalidated: 0 };

    const roundTripped = toSyncItem(persistedRow(item));

    expect(roundTripped.findingsEmitted).toBe(0);
    expect(roundTripped.findingsInvalidated).toBe(0);
  });

  it("preserves findings omission for a producer that sends none", () => {
    const created = mapInvocationCreate("generation-1", "part-1", baseItem());
    expect(created.findingsEmitted).toBeNull();
    expect(created.findingsInvalidated).toBeNull();

    const roundTripped = toSyncItem(persistedRow(baseItem()));
    expect(Object.hasOwn(roundTripped, "findingsEmitted")).toBe(false);
    expect(Object.hasOwn(roundTripped, "findingsInvalidated")).toBe(false);
  });

  it("re-emits NEITHER half of a corrupt stored pair", () => {
    // A row seeded outside the boundary (a half-set pair, or an inverted one)
    // must not re-serialize as half a pair: the item schema would reject the
    // whole part and the generation would never drain.
    for (const stored of [
      { findingsEmitted: 10n, findingsInvalidated: null },
      { findingsEmitted: null, findingsInvalidated: 3n },
      { findingsEmitted: 2n, findingsInvalidated: 3n },
    ]) {
      const roundTripped = toSyncItem({
        ...persistedRow(baseItem()),
        ...stored,
      });

      expect(Object.hasOwn(roundTripped, "findingsEmitted")).toBe(false);
      expect(Object.hasOwn(roundTripped, "findingsInvalidated")).toBe(false);
    }
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

/**
 * ISS-8736: the three fields that land on btree index keys are projected at
 * the write (ISS-8069); every other field, and every in-budget value, is stored
 * verbatim so the round trip above stays exact for real producers.
 */
describe("component invocation index-key projection", () => {
  const OVER_BUDGET = "k".repeat(INDEX_KEY_MAX_BYTES + 1);

  it.each(["externalInvocationId", "componentKey", "branchName"] as const)(
    "projects an over-budget %s and counts it",
    (field) => {
      const item = { ...baseItem(), [field]: OVER_BUDGET };

      const created = mapInvocationCreate("generation-1", "part-1", item);
      const {
        generationId: _generationId,
        partId: _partId,
        ...columns
      } = created;

      expect(created[field]).toBe(projectIndexKey(OVER_BUDGET).value);
      expect(hasProjectedIndexKeyShape(String(created[field]))).toBe(true);
      expect(stagedInvocationRow("row-1", item)).toEqual({
        id: "row-1",
        ...columns,
      });
      expect(countProjectedIndexKeys([item])).toBe(1);
    }
  );

  it("stores in-budget keys verbatim and counts nothing", () => {
    const item = { ...baseItem(), branchName: "feat/iss-8736" };

    const row = stagedInvocationRow("row-1", item);

    expect(row).toMatchObject({
      externalInvocationId: item.externalInvocationId,
      componentKey: item.componentKey,
      branchName: "feat/iss-8736",
    });
    expect(countProjectedIndexKeys([item])).toBe(0);
    expect(toSyncItem(persistedRow(item))).toEqual(item);
  });

  it("declares the generation hash unverifiable only when a row holds a projected key", () => {
    const plain = persistedRow(baseItem());
    const projected = persistedRow({
      ...baseItem(),
      componentKey: OVER_BUDGET,
    });

    expect(generationHashIsVerifiable([plain])).toBe(true);
    expect(generationHashIsVerifiable([plain, projected])).toBe(false);
  });

  it("offers every key a row could hold for a wire externalInvocationId", () => {
    expect(storedExternalInvocationIds("invocation-1")).toEqual([
      "invocation-1",
    ]);
    // A row written before ISS-8736 holds the raw form; one written after
    // holds the projection. Both must be found or a duplicate slips in.
    expect(storedExternalInvocationIds(OVER_BUDGET)).toEqual([
      mapInvocationCreate("generation-1", "part-1", {
        ...baseItem(),
        externalInvocationId: OVER_BUDGET,
      }).externalInvocationId,
      OVER_BUDGET,
    ]);
  });
});

describe("ISS-4965: definition content is redacted at the staging write", () => {
  it("stages a raw old-client secret redacted and re-fingerprinted", () => {
    const item = definitionItem(`TOKEN=${SYNTHETIC_GITHUB_TOKEN}`);

    const row = stagedInvocationRow("row-1", item);

    expect(row.definitionContent).toBe(REDACTED_BODY);
    expect(row.definitionHash).toBe(
      definitionItem(REDACTED_BODY).definitionHash
    );
  });

  it("stages clean content verbatim", () => {
    const item = definitionItem("Review only real bugs.");

    const row = stagedInvocationRow("row-1", item);

    expect(row.definitionContent).toBe("Review only real bugs.");
    expect(row.definitionHash).toBe(item.definitionHash);
  });
});

describe("ISS-4965: generationHashVerdict", () => {
  // A current Desktop redacts before hashing, so storage reproduces its id.
  it("verifies a current Desktop's multi-part generation from storage", () => {
    const items = twoDefinitionItems(REDACTED_BODY);

    expect(verdictFor(items, 2)).toBe(GenerationHashVerdict.Verified);
  });

  it("rejects a marker-bearing one-part generation sent under another id", () => {
    const items = twoDefinitionItems(REDACTED_BODY);

    expect(verdictFor(items, 1, "0".repeat(64))).toBe(
      GenerationHashVerdict.Conflict
    );
  });

  it("verifies an older Desktop's one-part generation against the raw wire part", () => {
    const items = twoDefinitionItems(`TOKEN=${SYNTHETIC_GITHUB_TOKEN}`);

    expect(verdictFor(items, 1)).toBe(GenerationHashVerdict.Verified);
  });

  it("cannot verify an older Desktop's multi-part generation", () => {
    const items = twoDefinitionItems(`TOKEN=${SYNTHETIC_GITHUB_TOKEN}`);

    expect(verdictFor(items, 2)).toBe(GenerationHashVerdict.Unverifiable);
  });

  it("rejects a mismatch no redaction explains", () => {
    const items = twoDefinitionItems("Review only real bugs.");

    expect(verdictFor(items, 2, "0".repeat(64))).toBe(
      GenerationHashVerdict.Conflict
    );
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
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    });

    expect(parsed.success).toBe(true);
  });

  it("round-trips the measurement label through the generation hash", () => {
    // ISS-7795. The label rides the same preimage as the numbers it describes,
    // so a row that came back with a different method than the producer sent
    // must fail reconciliation rather than quietly relabel the telemetry.
    const estimated: AgentComponentInvocationSyncItem = {
      ...itemWithTelemetry(),
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
    };

    expect(toSyncItem(persistedRow(estimated))).toEqual(estimated);
    expect(preimage(toSyncItem(persistedRow(estimated)))).toBe(
      preimage(estimated)
    );
    expect(preimage(estimated)).not.toBe(preimage(itemWithTelemetry()));
  });

  it("refuses to reconstruct an item from an unreadable persisted label", () => {
    // A persisted row is a trust boundary the ingest schema never re-checks. A
    // label this build cannot interpret must stop the reconciliation, not be
    // dropped — silently omitting it would reconstruct an item the producer
    // never sent and reject the generation with a misleading conflict.
    const row = {
      ...persistedRow(itemWithTelemetry()),
      usageMeasurement: "guessed",
    };

    expect(() => toSyncItem(row)).toThrow(INVALID_PERSISTED_MEASUREMENT);
  });

  it("omits an absent measurement label rather than emitting null", () => {
    const roundTripped = toSyncItem(persistedRow(baseItem()));

    expect(Object.hasOwn(roundTripped, "usageMeasurement")).toBe(false);
    expect(preimage(roundTripped)).toBe(preimage(baseItem()));
  });

  /**
   * ISS-10730. A field `mapInvocationCreate` writes but `toSyncItem` does not
   * read back makes EVERY generation carrying it fail the post-ingest
   * generation-hash reconciliation as a `generation_conflict`, permanently —
   * the failure this file's header names. TWO items with DIFFERENT deltas, so
   * the assertion cannot be satisfied by one shared number.
   */
  it("round-trips a per-invocation line delta through persistence", () => {
    const first: AgentComponentInvocationSyncItem = {
      ...baseItem(),
      linesAdded: 12,
      linesRemoved: 4,
    };
    const second: AgentComponentInvocationSyncItem = {
      ...baseItem(),
      externalInvocationId: "invocation-2",
      linesAdded: 0,
      linesRemoved: 37,
    };

    expect(toSyncItem(persistedRow(first))).toEqual(first);
    expect(toSyncItem(persistedRow(second))).toEqual(second);
    expect(preimage(toSyncItem(persistedRow(first)))).toBe(preimage(first));
    expect(preimage(first)).not.toBe(preimage(second));
  });

  it("omits both line keys rather than emitting null when neither was computed", () => {
    const roundTripped = toSyncItem(persistedRow(baseItem()));

    expect(Object.hasOwn(roundTripped, "linesAdded")).toBe(false);
    expect(Object.hasOwn(roundTripped, "linesRemoved")).toBe(false);
    expect(preimage(roundTripped)).toBe(preimage(baseItem()));
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
 * ISS-4976 (@whitlockk review): the model, the four token counts, and the cost are
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
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
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

/** ISS-10725: an item carrying the stored findings pair. */
function itemWithFindings(): AgentComponentInvocationSyncItem {
  return {
    ...baseItem(),
    findingsEmitted: 10,
    findingsInvalidated: 3,
  };
}

/** ISS-4965: a definition-bearing item fingerprinted the way Desktop does it. */
function definitionItem(content: string): AgentComponentInvocationSyncItem {
  return {
    ...baseItem(),
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "code-review",
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    definitionContent: content,
    ...computeDefinitionHash({
      body: content,
      kind: AgentComponentInvocationKind.Skill,
    }),
  };
}

/** ISS-4965: the staged text of `TOKEN=<synthetic GitHub token>`. */
const REDACTED_BODY = "TOKEN=[REDACTED:ghp]";

/** ISS-4965: two definition items of one generation, in canonical order. */
function twoDefinitionItems(
  content: string
): AgentComponentInvocationSyncItem[] {
  return [
    definitionItem(content),
    {
      ...definitionItem(content),
      externalInvocationId: "invocation-2",
      sequence: 1,
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "event-2",
      },
    },
  ];
}

/**
 * ISS-4965: stage `wireItems` the way ingest does, then judge the generation
 * against the id their producer hashed them under (or `sentId`).
 */
function verdictFor(
  wireItems: AgentComponentInvocationSyncItem[],
  expectedPartCount: number,
  sentId?: string
) {
  return generationHashVerdict({
    externalSessionId,
    externalGenerationId:
      sentId ??
      createHash("sha256")
        .update(
          agentComponentInvocationGenerationHashPreimage({
            externalSessionId,
            items: wireItems,
          })
        )
        .digest("hex"),
    expectedPartCount,
    wireItems,
    rows: wireItems.map(persistedRow),
  });
}
