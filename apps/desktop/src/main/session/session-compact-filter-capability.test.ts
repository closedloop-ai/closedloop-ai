import { describe, expect, it, vi } from "vitest";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { SESSION_COMPACT_FILTER_VERSION } from "../agent-sync/session-compact-filter-capabilities.js";
import { supportsSessionCompactFilter } from "./session-compact-filter-capability.js";

describe("DT-45 compact filter capability recovery", () => {
  it("uses a safe fallback for one failed read and re-probes the same source", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("capability read failed"))
      .mockResolvedValueOnce({ cursor: SESSION_COMPACT_FILTER_VERSION });
    const source = {
      readSessionCompactFilterCapabilities: read,
    } as unknown as AgentSessionSyncSource;

    expect(await supportsSessionCompactFilter(source, "cursor")).toBe(false);
    expect(await supportsSessionCompactFilter(source, "cursor")).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps an absent older-host method as a safe unsupported capability", async () => {
    const source = {} as AgentSessionSyncSource;
    expect(await supportsSessionCompactFilter(source, "cursor")).toBe(false);
    expect(await supportsSessionCompactFilter(source, "usage")).toBe(false);
  });
});
