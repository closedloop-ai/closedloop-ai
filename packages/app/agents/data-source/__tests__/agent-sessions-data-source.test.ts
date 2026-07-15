import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { describe, expect, it } from "vitest";
import { createHttpAgentSessionsDataSource } from "../agent-sessions-data-source";

describe("createHttpAgentSessionsDataSource", () => {
  it("serializes selected session statuses as repeated query params", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.list({
      statuses: [
        SESSION_STATUS.ACTIVE,
        SESSION_STATUS.COMPLETED,
        SESSION_STATUS.ABANDONED,
      ],
    });

    expect(requestedPaths).toEqual([
      `/agent-sessions?statuses=${SESSION_STATUS.ACTIVE}&statuses=${SESSION_STATUS.COMPLETED}&statuses=${SESSION_STATUS.ABANDONED}`,
    ]);
  });

  it("serializes harness/model/autonomy/cost facets as repeated query params", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.list({
      harnesses: ["claude", "codex"],
      models: ["claude-opus-4"],
      autonomyTiers: ["high", "unknown"],
      costBuckets: ["from_50"],
    });

    expect(requestedPaths).toEqual([
      "/agent-sessions?harnesses=claude&harnesses=codex&models=claude-opus-4&autonomyTiers=high&autonomyTiers=unknown&costBuckets=from_50",
    ]);
  });

  // FEA-3120: the HTTP source always reads synced cloud state, so it stamps
  // `cloud` at the read boundary.
  it("stamps readSource=cloud on list responses that omit it", async () => {
    const source = createHttpAgentSessionsDataSource({
      get: <T>() =>
        Promise.resolve({
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
        } as T),
    });

    const response = await source.list({});

    expect(response.readSource).toBe(ReadSource.Cloud);
  });

  // No silent overwrite: a backend that already attributes a source stays
  // authoritative — the boundary must not clobber `fallback` into `cloud`.
  it("preserves an explicit server-provided readSource", async () => {
    const source = createHttpAgentSessionsDataSource({
      get: <T>() =>
        Promise.resolve({
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
          readSource: ReadSource.Fallback,
        } as T),
    });

    const response = await source.list({});

    expect(response.readSource).toBe(ReadSource.Fallback);
  });
});

function createRecordingAgentSessionsGet(requestedPaths: string[]) {
  return function get<T>(path: string): Promise<T> {
    requestedPaths.push(path);
    return Promise.resolve({
      items: [],
      total: 0,
      viewerScope: AgentSessionViewerScope.Self,
    } as T);
  };
}
