/**
 * FEA-2923 (T-10.9): Negative-input tests for the desktop component-inventory
 * sync Zod schemas.
 *
 * The `POST /desktop/components/sync` route test bypasses schema validation
 * with a stub, so the real rejection behavior of these schemas is exercised
 * only here. Covers: wrong schemaVersion literal, non-UUID batchId, a
 * components array exceeding the 200 cap, an externalId that is empty after
 * trim, an invalid ISO date, plus a valid minimal round-trip.
 */
import {
  SYNCED_COMPONENT_CONTENT_MAX_CHARS,
  SYNCED_COMPONENT_VARIANTS_MAX,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
  desktopAgentComponentsPayloadSchema,
  syncedComponentSchema,
} from "../desktop-agent-sessions-schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_BATCH_ID = "11111111-1111-4111-8111-111111111111";

function validComponent(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "skill::my-skill",
    componentKind: "skill",
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: VALID_BATCH_ID,
    syncMode: "incremental",
    componentCount: 1,
    components: [validComponent()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// syncedComponentSchema
// ---------------------------------------------------------------------------

describe("syncedComponentSchema", () => {
  it("accepts a minimal component (externalId + componentKind)", () => {
    const result = syncedComponentSchema.safeParse(validComponent());
    expect(result.success).toBe(true);
  });

  it("rejects an externalId that is empty after trim", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ externalId: "   " })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a missing externalId", () => {
    const { externalId: _drop, ...rest } = validComponent();
    const result = syncedComponentSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an empty componentKind", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ componentKind: "" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects an invalid ISO date in firstSeenAt", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ firstSeenAt: "not-a-date" })
    );
    expect(result.success).toBe(false);
  });

  it("accepts a null firstSeenAt (optional/nullable)", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ firstSeenAt: null })
    );
    expect(result.success).toBe(true);
  });

  it("round-trips definition content + contentHash (FEA-2923)", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({
        content: "---\nname: my-skill\n---\nDo the thing.",
        contentHash: "a".repeat(64),
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toContain("Do the thing.");
      expect(result.data.contentHash).toBe("a".repeat(64));
    }
  });

  it("accepts content exactly at the cap and rejects one char over", () => {
    const atCap = "x".repeat(SYNCED_COMPONENT_CONTENT_MAX_CHARS);
    expect(
      syncedComponentSchema.safeParse(validComponent({ content: atCap }))
        .success
    ).toBe(true);
    expect(
      syncedComponentSchema.safeParse(validComponent({ content: `${atCap}x` }))
        .success
    ).toBe(false);
  });

  it("normalizes nullable trimmed string fields (empty → null)", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ name: "  ", harness: "claude" })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeNull();
      expect(result.data.harness).toBe("claude");
    }
  });
});

// ---------------------------------------------------------------------------
// desktopAgentComponentsPayloadSchema
// ---------------------------------------------------------------------------

describe("desktopAgentComponentsPayloadSchema", () => {
  it("accepts a valid minimal payload (round-trip)", () => {
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload()
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.batchId).toBe(VALID_BATCH_ID);
      expect(result.data.components).toHaveLength(1);
      expect(result.data.schemaVersion).toBe(
        AGENT_COMPONENT_SYNC_SCHEMA_VERSION
      );
    }
  });

  it("rejects a wrong schemaVersion literal", () => {
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ schemaVersion: 999 })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID batchId", () => {
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ batchId: "not-a-uuid" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown syncMode", () => {
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ syncMode: "sideways" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative componentCount", () => {
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ componentCount: -1 })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a components array exceeding 200 entries", () => {
    const tooMany = Array.from({ length: 201 }, (_, i) =>
      validComponent({ externalId: `skill::c-${i}` })
    );
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ components: tooMany, componentCount: 201 })
    );
    expect(result.success).toBe(false);
  });

  it("accepts exactly 200 components (boundary)", () => {
    const exactly200 = Array.from({ length: 200 }, (_, i) =>
      validComponent({ externalId: `skill::c-${i}` })
    );
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ components: exactly200, componentCount: 200 })
    );
    expect(result.success).toBe(true);
  });

  it("rejects when a component in the array is invalid (empty externalId)", () => {
    const result = desktopAgentComponentsPayloadSchema.safeParse(
      validPayload({ components: [validComponent({ externalId: "" })] })
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-4662: retained per-content-hash variants
// ---------------------------------------------------------------------------

describe("syncedComponentSchema — ISS-4662 variants", () => {
  it("preserves OMISSION of `variants` (an older desktop) rather than defaulting it", () => {
    const result = syncedComponentSchema.safeParse(validComponent());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, "variants")).toBe(false);
    }
  });

  it("accepts a well-formed variant", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({
        variants: [
          {
            contentHash: "abc123",
            content: "BODY",
            format: "md",
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variants?.[0].contentHash).toBe("abc123");
    }
  });

  it("STRIPS an unknown variant field instead of rejecting the whole component", () => {
    // The boundary is deliberately non-strict: a strict schema here would make a
    // newer desktop's extra field reject the entire 200-component batch, and
    // re-reject it on every retry, silently dropping all of them.
    const result = syncedComponentSchema.safeParse(
      validComponent({
        variants: [
          { contentHash: "abc123", content: "BODY", fromTheFuture: "x" },
        ],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        Object.hasOwn(result.data.variants?.[0] ?? {}, "fromTheFuture")
      ).toBe(false);
    }
  });

  it("rejects a variant with no content hash", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ variants: [{ contentHash: "  ", content: "BODY" }] })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a variant body over the content cap", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({
        variants: [
          {
            contentHash: "abc123",
            content: "x".repeat(SYNCED_COMPONENT_CONTENT_MAX_CHARS + 1),
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it("TRUNCATES to the shared cap instead of rejecting the component", () => {
    const tooMany = Array.from(
      { length: SYNCED_COMPONENT_VARIANTS_MAX + 3 },
      (_, i) => ({ contentHash: `h-${i}`, content: "BODY" })
    );
    const result = syncedComponentSchema.safeParse(
      validComponent({ variants: tooMany })
    );

    // A `.max()` here would 400 the WHOLE batch of up to 200 components — the
    // route safeParses the entire payload with no per-component salvage — and
    // keep 400ing it on every retry, stalling every existence row in the batch
    // over one over-eager producer. The cap still bounds what is stored; it just
    // degrades instead of blocking (closedloop-ai-stage, #4295).
    expect(result.success).toBe(true);
    const variants = result.success ? result.data.variants : undefined;
    expect(variants).toHaveLength(SYNCED_COMPONENT_VARIANTS_MAX);
    // Newest-first prefix preserved: the desktop packer orders by recency, so
    // truncation must keep the head, not an arbitrary slice.
    expect(variants?.[0]?.contentHash).toBe("h-0");
    expect(variants?.at(-1)?.contentHash).toBe(
      `h-${SYNCED_COMPONENT_VARIANTS_MAX - 1}`
    );
  });

  it("MARKS the component truncated in the same pass, so the drop is never stored as complete", () => {
    // wongk, #4391. The slice used to live on the `variants` field alone, where
    // it could not reach the sibling marker — so the API knowingly dropped
    // revisions and then persisted the result as a whole history. That is this
    // ticket's own bug reproduced one layer below the desktop packer, which is
    // why the cap and the marker now happen in one object-level transform.
    const tooMany = Array.from(
      { length: SYNCED_COMPONENT_VARIANTS_MAX + 3 },
      (_, i) => ({ contentHash: `h-${i}`, content: "BODY" })
    );
    const result = syncedComponentSchema.safeParse(
      validComponent({ variants: tooMany })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantsTruncated).toBe(true);
      // An entry cap that bound is precisely what `family_cap` denotes, and it
      // is the reason the detail read can reconcile into a proof.
      expect(result.data.variantsTruncatedReason).toBe(
        SyncedComponentVariantsTruncatedReason.FamilyCap
      );
    }
  });

  it("OVERRIDES a sender's `false` when THIS cap is the one that dropped revisions", () => {
    // Whatever the sender believed about its own packing, the API just dropped
    // revisions the sender did ship. Deferring to the incoming `false` would
    // store the shortened set as complete.
    const tooMany = Array.from(
      { length: SYNCED_COMPONENT_VARIANTS_MAX + 1 },
      (_, i) => ({ contentHash: `h-${i}`, content: "BODY" })
    );
    const result = syncedComponentSchema.safeParse(
      validComponent({ variants: tooMany, variantsTruncated: false })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantsTruncated).toBe(true);
    }
  });

  it("leaves the sender's marker untouched when the array FITS", () => {
    // The common path: the cap did not bind, so the transform must not invent a
    // claim — nor erase the packer's own one.
    const atCap = Array.from(
      { length: SYNCED_COMPONENT_VARIANTS_MAX },
      (_, i) => ({ contentHash: `h-${i}`, content: "BODY" })
    );
    const result = syncedComponentSchema.safeParse(
      validComponent({ variants: atCap })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variants).toHaveLength(SYNCED_COMPONENT_VARIANTS_MAX);
      expect(Object.hasOwn(result.data, "variantsTruncated")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ISS-5029: the variant-truncation marker
// ---------------------------------------------------------------------------

describe("syncedComponentSchema — ISS-5029 variantsTruncated", () => {
  it("preserves OMISSION of `variantsTruncated` (an older desktop) rather than defaulting it", () => {
    // The compatibility path: a desktop that predates the marker sends nothing,
    // the payload still parses, and the key is absent — the writer reads that as
    // "no evidence of truncation", i.e. exactly today's behaviour.
    const result = syncedComponentSchema.safeParse(validComponent());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, "variantsTruncated")).toBe(false);
    }
  });

  it("accepts the marker when a newer desktop sends it", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ variantsTruncated: true })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantsTruncated).toBe(true);
    }
  });

  it("accepts an explicit false without coercing it away", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ variantsTruncated: false })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantsTruncated).toBe(false);
    }
  });

  it("rejects a non-boolean marker rather than storing a coerced value", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({ variantsTruncated: "yes" })
    );
    expect(result.success).toBe(false);
  });

  it("carries the cap reason through so the cloud can tell the two caps apart", () => {
    const result = syncedComponentSchema.safeParse(
      validComponent({
        variantsTruncated: true,
        variantsTruncatedReason:
          SyncedComponentVariantsTruncatedReason.ByteBudget,
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantsTruncatedReason).toBe(
        SyncedComponentVariantsTruncatedReason.ByteBudget
      );
    }
  });

  it("ACCEPTS an unrecognized cap reason instead of rejecting the whole batch", () => {
    // wongk, #4391 + the root cross-repo rule. A `z.enum` here would let ONE
    // component carrying a future reason 400 up to 200 components, on every
    // retry. The reader is what maps unknown to "no proof".
    const result = syncedComponentSchema.safeParse(
      validComponent({
        variantsTruncated: true,
        variantsTruncatedReason: "some_future_cap",
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantsTruncatedReason).toBe("some_future_cap");
    }
  });

  it("preserves OMISSION of the cap reason distinctly from an explicit null", () => {
    const omitted = syncedComponentSchema.safeParse(
      validComponent({ variantsTruncated: true })
    );
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(Object.hasOwn(omitted.data, "variantsTruncatedReason")).toBe(
        false
      );
    }

    const explicitNull = syncedComponentSchema.safeParse(
      validComponent({ variantsTruncated: true, variantsTruncatedReason: null })
    );
    expect(explicitNull.success).toBe(true);
    if (explicitNull.success) {
      expect(explicitNull.data.variantsTruncatedReason).toBeNull();
    }
  });
});
