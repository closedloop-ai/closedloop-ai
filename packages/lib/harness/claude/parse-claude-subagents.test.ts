/**
 * ISS-5292 Packet C: branch coverage for `parse-claude-subagents.ts`.
 *
 * `normalizeSidechainSubagentId` and `deriveSidechainSubagentId` are pure
 * functions — no accumulator, no I/O — so this file tests them in isolation
 * over every reachable branch, including the null/absent-id paths that the
 * existing sidechain integration tests never exercise (they always supply a
 * valid agentId).
 */
import { describe, expect, it } from "vitest";
import {
  deriveSidechainSubagentId,
  normalizeSidechainSubagentId,
  UNATTRIBUTED_SUBAGENT_ID,
} from "./parse-claude-subagents";

// ---------------------------------------------------------------------------
// normalizeSidechainSubagentId
// ---------------------------------------------------------------------------

describe("normalizeSidechainSubagentId", () => {
  it("returns nativeId unchanged when providerAgentId is null", () => {
    // Branch 0[0]: !providerAgentId → return nativeId directly.
    expect(normalizeSidechainSubagentId("some-uuid-id", null)).toBe(
      "some-uuid-id"
    );
  });

  it("returns providerAgentId unchanged when it already starts with 'agent-'", () => {
    // Branch 1[0]: providerAgentId.startsWith("agent-") → return as-is.
    expect(
      normalizeSidechainSubagentId("ignored", "agent-a7bb59fb7a25cac2")
    ).toBe("agent-a7bb59fb7a25cac2");
  });

  it("prepends 'agent-' when providerAgentId is present but lacks the prefix", () => {
    // Branch 1[1]: !startsWith("agent-") → `agent-${providerAgentId}`.
    expect(normalizeSidechainSubagentId("ignored", "a7bb59fb7a25cac2")).toBe(
      "agent-a7bb59fb7a25cac2"
    );
  });
});

// ---------------------------------------------------------------------------
// deriveSidechainSubagentId
// ---------------------------------------------------------------------------

describe("deriveSidechainSubagentId", () => {
  it("returns undefined for a non-sidechain entry", () => {
    // Branch 2[0]: isSidechain !== true → return undefined (parent round-trip).
    expect(deriveSidechainSubagentId({})).toBeUndefined();
    expect(deriveSidechainSubagentId({ isSidechain: false })).toBeUndefined();
  });

  it("uses providerAgentId (agentId) as the nativeId when present", () => {
    // Branch 3[0]: providerAgentId ?? … → left is non-null → short-circuit.
    const result = deriveSidechainSubagentId({
      isSidechain: true,
      agentId: "a7bb59fb7a25cac2",
    });
    // normalizeSidechainSubagentId("a7bb59fb7a25cac2", "a7bb59fb7a25cac2") → "agent-a7bb59fb7a25cac2"
    expect(result).toBe("agent-a7bb59fb7a25cac2");
  });

  it("falls back to uuid when agentId is absent", () => {
    // Branch 3[1]: providerAgentId null → evaluate uuid.
    const result = deriveSidechainSubagentId({
      isSidechain: true,
      uuid: "uuid-fallback-id",
    });
    // providerAgentId = null → normalizeSidechainSubagentId("uuid-fallback-id", null) = "uuid-fallback-id"
    expect(result).toBe("uuid-fallback-id");
  });

  it("falls back to parentUuid when both agentId and uuid are absent", () => {
    // Branch 3[2]: providerAgentId null, uuid null → evaluate parentUuid.
    const result = deriveSidechainSubagentId({
      isSidechain: true,
      parentUuid: "parent-uuid-id",
    });
    expect(result).toBe("parent-uuid-id");
  });

  it("falls back to sessionId when agentId, uuid, and parentUuid are all absent", () => {
    // Branch 3[3]: all three null → evaluate sessionId.
    const result = deriveSidechainSubagentId({
      isSidechain: true,
      sessionId: "session-id-fallback",
    });
    expect(result).toBe("session-id-fallback");
  });

  it("returns UNATTRIBUTED_SUBAGENT_ID when no id can be recovered", () => {
    // Branch 4[0]: nativeId is null → return the sentinel.
    const result = deriveSidechainSubagentId({ isSidechain: true });
    expect(result).toBe(UNATTRIBUTED_SUBAGENT_ID);
  });

  it("normalizes with normalizeSidechainSubagentId when nativeId is the uuid (providerAgentId null)", () => {
    // Verify the full normalization path: nativeId = uuid, providerAgentId = null
    // → normalizeSidechainSubagentId(uuid, null) → returns uuid unchanged.
    const result = deriveSidechainSubagentId({
      isSidechain: true,
      uuid: "raw-uuid",
    });
    expect(result).toBe("raw-uuid");
  });
});
