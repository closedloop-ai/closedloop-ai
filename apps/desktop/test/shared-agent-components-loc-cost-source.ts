import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";

/**
 * The fake LOC/cost `AgentSessionSyncSource` behind the agent-components "LOC/$"
 * column (FEA-3090 / FEA-3633 / ISS-4667). Extracted from
 * `shared-agent-components-api.test.ts` (ISS-4667) so the LOC/$ suite and the
 * plugin child-usage rollup suite share ONE fixture instead of the grandfathered
 * omnibus file owning it — and so that file shrinks. Pure fixture; no test state.
 */

export type FakeSessionLoc = { added: number; removed: number };

/**
 * A minimal fake `AgentSessionSyncSource` whose `loadSyncedSessions` returns
 * synthetic sessions carrying the `gitDiffStats` (authored LOC) and per-model
 * estimated cost the LOC/$ reader consumes (plus the fields `mapListItem`
 * touches, so the detail `sessionsTab` projection is exercised too). Ids with no
 * entry resolve to nothing (dropped), mirroring the real loader.
 */
export function fakeLocCostSource(
  sessions: Record<
    string,
    {
      loc?: FakeSessionLoc;
      cost?: number;
      // FEA-3633: gitDiffStats.source ("git" default, or "branch_fallback") plus
      // the branch identity the per-branch fallback dedup keys on.
      locSource?: string;
      repositoryFullName?: string;
      branch?: string;
    }
  >
): AgentSessionSyncSource {
  return {
    loadSyncedSessions(ids: readonly string[]) {
      return ids.flatMap((id) => {
        const spec = sessions[id];
        if (!spec) {
          return [];
        }
        return [
          {
            externalSessionId: id,
            name: id,
            status: "completed",
            harness: "claude",
            cwd: null,
            model: "claude",
            startedAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            endedAt: null,
            awaitingInputSince: null,
            lastActivityAt: "2026-06-01T00:00:00.000Z",
            attribution: spec.repositoryFullName
              ? { repositoryFullName: spec.repositoryFullName }
              : null,
            branch: spec.branch ?? null,
            prs: [],
            events: [],
            agents: [],
            markers: [],
            tokenUsageByModel:
              spec.cost === undefined
                ? []
                : [
                    {
                      model: "claude",
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheReadTokens: 0,
                      cacheWriteTokens: 0,
                      estimatedCostUsd: spec.cost,
                    },
                  ],
            ...(spec.loc
              ? {
                  gitDiffStats: {
                    linesAdded: spec.loc.added,
                    linesRemoved: spec.loc.removed,
                    filesChanged: 0,
                    source: spec.locSource ?? "git",
                  },
                }
              : {}),
          },
        ];
      });
    },
  } as unknown as AgentSessionSyncSource;
}
