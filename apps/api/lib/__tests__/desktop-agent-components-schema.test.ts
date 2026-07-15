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
