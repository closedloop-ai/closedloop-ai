import { describe, expect, it } from "vitest";
import {
  AgentSessionCloudSyncState,
  agentSessionCloudSyncStateValues,
  isAgentSessionCloudSyncState,
} from "../agent-session-cloud-sync-state-constants.js";

describe("AgentSessionCloudSyncState (PRD-536 E6)", () => {
  it("exposes exactly the four per-row sync states", () => {
    expect([...agentSessionCloudSyncStateValues].sort()).toEqual([
      "abandoned",
      "dead_letter",
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
});
