import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
  type LocalPriorityWriteResult,
  LocalPriorityWriteStatus,
} from "../../../shared/local-priority-write-contract";
import {
  SHARED_AGENT_SESSIONS_NOT_FOUND_CODE,
  SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
} from "../../../shared/shared-agent-sessions-contract";
import { SHARED_BRANCHES_NOT_FOUND_CODE } from "../../../shared/shared-branches-contract";
import { createLocalAgentSessionsDataSource } from "../../shared-agent-sessions/local-agent-sessions-data-source";
import { createLocalBranchesDataSource } from "../../shared-branches/local-branches-data-source";

/**
 * ISS-10332 / PLN-2086 Milestone 3 step 16 — the local data sources' write
 * half: the request crosses the bridge with its row id, and each local answer
 * surfaces as the error the cloud route answers for the same outcome, so the
 * shared optimistic mutation rolls back and re-reads identically on both
 * sources.
 */

const SESSION_ID = "session-1";
const BRANCH_ID = "owner%2Frepo::feature";
const REQUEST = {
  priority: Priority.High,
  expectedPriority: null,
} as const;

function sessionsSource(
  answer: () => Promise<LocalPriorityWriteResult>
): ReturnType<typeof createLocalAgentSessionsDataSource> {
  return createLocalAgentSessionsDataSource({
    agentSessionsApi: { updatePriority: vi.fn(answer) },
  } as unknown as Parameters<typeof createLocalAgentSessionsDataSource>[0]);
}

function branchesSource(
  answer: () => Promise<LocalPriorityWriteResult>
): ReturnType<typeof createLocalBranchesDataSource> {
  return createLocalBranchesDataSource({
    branchesApi: { updatePriority: vi.fn(answer) },
  } as unknown as Parameters<typeof createLocalBranchesDataSource>[0]);
}

describe("ISS-10332: the local sources' updatePriority", () => {
  it("sends the request with the row id and resolves a written value", async () => {
    const updatePriority = vi.fn(async () => ({
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.High,
    }));
    const sessions = createLocalAgentSessionsDataSource({
      agentSessionsApi: { updatePriority },
    } as unknown as Parameters<typeof createLocalAgentSessionsDataSource>[0]);
    const branches = createLocalBranchesDataSource({
      branchesApi: { updatePriority },
    } as unknown as Parameters<typeof createLocalBranchesDataSource>[0]);

    await expect(
      sessions.updatePriority?.(SESSION_ID, REQUEST)
    ).resolves.toBeUndefined();
    await expect(
      branches.updatePriority?.(BRANCH_ID, REQUEST)
    ).resolves.toEqual({ id: BRANCH_ID, priority: Priority.High });
    expect(updatePriority.mock.calls).toEqual([
      [{ ...REQUEST, id: SESSION_ID }],
      [{ ...REQUEST, id: BRANCH_ID }],
    ]);
  });

  it.each([
    ["sessions", () => sessionsSource, SESSION_ID],
    ["branches", () => branchesSource, BRANCH_ID],
  ] as const)(
    "surfaces a stale write as the cloud's stale_priority 409 (%s)",
    async (_label, sourceFor, id) => {
      const source = sourceFor()(async () => ({
        status: LocalPriorityWriteStatus.Stale,
      }));
      const error = await source
        .updatePriority?.(id, REQUEST)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 409,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
      });
    }
  );

  it.each([
    [
      "sessions",
      () => sessionsSource,
      SESSION_ID,
      SHARED_AGENT_SESSIONS_NOT_FOUND_CODE,
    ],
    [
      "branches",
      () => branchesSource,
      BRANCH_ID,
      SHARED_BRANCHES_NOT_FOUND_CODE,
    ],
  ] as const)(
    "surfaces a missing row as the source's own 404 (%s)",
    async (_label, sourceFor, id, code) => {
      const source = sourceFor()(async () => ({
        status: LocalPriorityWriteStatus.NotFound,
      }));
      await expect(source.updatePriority?.(id, REQUEST)).rejects.toMatchObject({
        status: 404,
        code,
      });
    }
  );

  it("sanitizes a failed bridge call rather than leaking it", async () => {
    const source = sessionsSource(() =>
      Promise.reject(new Error("SQLITE_BUSY at a local database path"))
    );
    await expect(
      source.updatePriority?.(SESSION_ID, REQUEST)
    ).rejects.toMatchObject({
      status: 500,
      code: SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
    });
  });

  it("offers no updatePriority over a preload without the bridge", () => {
    expect(
      Object.hasOwn(
        createLocalAgentSessionsDataSource({
          agentSessionsApi: {},
        } as unknown as Parameters<
          typeof createLocalAgentSessionsDataSource
        >[0]),
        "updatePriority"
      )
    ).toBe(false);
    expect(
      Object.hasOwn(
        createLocalBranchesDataSource({
          branchesApi: {},
        } as unknown as Parameters<typeof createLocalBranchesDataSource>[0]),
        "updatePriority"
      )
    ).toBe(false);
  });
});
