import { describe, expect, it } from "vitest";
import { agentSessionCloudSyncStateSchema } from "../agent-session-cloud-sync-state.js";
import {
  AgentSessionCloudSyncState,
  agentSessionCloudSyncStateValues,
  isAgentSessionCloudSyncState,
} from "../agent-session-cloud-sync-state-constants.js";

describe("AgentSessionCloudSyncState (PRD-536 E6)", () => {
  it("exposes exactly the two per-row sync states", () => {
    expect([...agentSessionCloudSyncStateValues].sort()).toEqual([
      "pending",
      "synced",
    ]);
    expect(AgentSessionCloudSyncState.Pending).toBe("pending");
    expect(AgentSessionCloudSyncState.Synced).toBe("synced");
  });

  it("isAgentSessionCloudSyncState accepts known states, rejects everything else", () => {
    for (const state of agentSessionCloudSyncStateValues) {
      expect(isAgentSessionCloudSyncState(state)).toBe(true);
    }
    expect(isAgentSessionCloudSyncState("unsynced")).toBe(false);
    expect(isAgentSessionCloudSyncState("")).toBe(false);
    expect(isAgentSessionCloudSyncState(undefined)).toBe(false);
    expect(isAgentSessionCloudSyncState(null)).toBe(false);
    expect(isAgentSessionCloudSyncState(1)).toBe(false);
  });

  it("keeps the enum/guard out of the Zod-backed schema module (flat graph, no barrel)", async () => {
    // #3449: the enum, values tuple, and guard live ONLY in the Zod-FREE
    // constants module; the schema module exposes ONLY the boundary schema and
    // does not barrel-re-export the constants (biome noBarrelFile). Callers that
    // need the enum import it directly from the constants module, so a client
    // bundle importing the enum never transitively pulls in `zod`.
    const schemaModule = await import("../agent-session-cloud-sync-state.js");
    expect(schemaModule.agentSessionCloudSyncStateSchema).toBeDefined();
    expect(
      (schemaModule as Record<string, unknown>).AgentSessionCloudSyncState
    ).toBeUndefined();
    expect(
      (schemaModule as Record<string, unknown>).isAgentSessionCloudSyncState
    ).toBeUndefined();
  });

  it("round-trips a payload carrying the field through the boundary schema", () => {
    // FEA-3701: the field crosses the IPC/serialization boundary; the strict
    // enum schema (imported from the schema module, split from the Zod-free
    // constants per #3449) is the boundary validator. Both variants must survive
    // the round-trip, and an unknown/stale wire value must be rejected at the
    // boundary rather than silently rendering a wrong per-row badge.
    for (const state of agentSessionCloudSyncStateValues) {
      const parsed = agentSessionCloudSyncStateSchema.parse(state);
      expect(parsed).toBe(state);
    }
    expect(agentSessionCloudSyncStateSchema.safeParse("mixed").success).toBe(
      false
    );
    expect(agentSessionCloudSyncStateSchema.safeParse(undefined).success).toBe(
      false
    );
  });
});
