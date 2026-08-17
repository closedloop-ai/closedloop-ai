/**
 * The batch preflight's compute-target check is the ONLY proof of tenant
 * ownership the per-session write lanes get.
 *
 * `service/persist-session-children.ts` spends a docstring on this: the child
 * tables carry no `organization_id` of their own, so the raw
 * `agent_session_events` INSERT and the token-usage `createMany` key on
 * `agentSessionId = artifactId` alone and are licensed SOLELY by this one
 * `computeTarget.findFirst({ id, organizationId })` having already fail-closed
 * for a cross-org target (the alternative, a per-session round-trip, is the
 * ISS-4439 regression that file exists to avoid).
 *
 * ISS-5648 moved that check out of `service.ts` and into
 * `service/resolve-batch-lookups.ts`. Every other test in this directory mocks
 * the target as FOUND, so deleting the guard left the whole suite green — it
 * now reads as an unused `findFirst` selecting only `{ id }`. This file is the
 * red test that stops that, driving the REAL `upsertSessions` path rather than
 * calling the extracted helper directly.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

import { agentSessionsService } from "./service";

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/**
 * Wire the batch with `computeTarget.findFirst` under the caller's control and
 * hand back the session-detail `upsert` spy, which is the first write of the
 * per-session lane — if the guard held, it never ran.
 */
function installBatch(target: { id: string } | null) {
  const upsert = vi.fn().mockResolvedValue({ artifactId: "artifact-1" });
  const findFirst = vi.fn().mockResolvedValue(target);
  installDb({
    computeTarget: { findFirst },
    slugCounter: buildSlugCounterMock(),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  });
  return { upsert, findFirst };
}

function runBatch() {
  const session = buildSyncedSession({});
  return agentSessionsService.upsertSessions(CONTEXT, {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba011",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  });
}

describe("upsertSessions compute-target ownership guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts the batch before any session write when the target is not this org's", async () => {
    const { upsert } = installBatch(null);

    await expect(runBatch()).rejects.toThrow("compute_target_not_found");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("writes the batch when the target resolves — the guard is what rejected above", async () => {
    const { upsert } = installBatch({ id: "target-1" });

    await runBatch();

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("scopes the lookup by organization, not by target id alone", async () => {
    // The two tests above drive the guard by MOCKED return value, so they stay
    // green against a `where` narrowed to `{ id }` — which is the shape that
    // licenses a cross-org batch, since the child write lanes carry no
    // `organization_id` of their own and trust this one query.
    const { findFirst } = installBatch({ id: "target-1" });

    await runBatch();

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: CONTEXT.computeTargetId,
          organizationId: CONTEXT.organizationId,
        },
      })
    );
  });
});
