import { Status } from "@repo/api/src/types/result";
import type { SessionMeshPresenceInput } from "@repo/api/src/types/session-mesh";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  meshDbState,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { sessionMeshService } from "./service";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (
    await import(
      "@/__tests__/support/session-mesh/session-mesh-db.test-helpers"
    )
  ).meshWithDb(),
}));

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ORG = "0199a1b2-0000-7000-8000-000000000001";
const USER = "0199a1b2-0000-7000-8000-000000000002";

let db: MeshDb;

function presenceInput(): SessionMeshPresenceInput {
  return {
    agentId: "agent-1",
    workspace: {
      repository: "closedloop/app",
      revision: "rev-1",
      dirtyStateHash: "dirty",
      configurationHash: "config",
      paths: ["src/a.ts"],
      symbols: ["fnA"],
    },
    harness: "claude",
    capabilities: ["poll_inbox"],
    lineage: { artifactIds: [], blocksArtifactIds: [], sessionId: "s-1" },
    context: {
      artifactRefs: [],
      sensitivity: "normal",
      password: "hunter2",
    } as SessionMeshPresenceInput["context"],
    expiresInSeconds: 90,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sessionMeshService.upsertPresence", () => {
  const ownedWhere = { organizationId: ORG, agentId: "agent-1", userId: USER };

  it("updates an owned presence in place without creating a row", async () => {
    db.sessionMeshPresence.updateMany.mockResolvedValue({ count: 1 });
    db.sessionMeshPresence.findFirstOrThrow.mockResolvedValue({ id: "p-1" });

    const result = await sessionMeshService.upsertPresence({
      organizationId: ORG,
      userId: USER,
      presence: presenceInput(),
    });

    expect(result).toEqual({ ok: true, value: { id: "p-1" } });
    expect(meshDbState.calls).toEqual([{ kind: "tx", options: undefined }]);
    expect(db.sessionMeshPresence.createMany).not.toHaveBeenCalled();
    expect(db.sessionMeshPresence.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: ownedWhere,
      data: {
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
        repository: "closedloop/app",
        revision: "rev-1",
        dirtyStateHash: "dirty",
        configurationHash: "config",
        harness: "claude",
        capabilities: ["poll_inbox"],
        lineage: { artifactIds: [], blocksArtifactIds: [], sessionId: "s-1" },
        // The private `password` container is stripped before persistence.
        context: { artifactRefs: [], sensitivity: "normal" },
        paths: ["src/a.ts"],
        symbols: ["fnA"],
        expiresAt: new Date(NOW.getTime() + 90_000),
      },
    });
    expect(db.sessionMeshPresence.findFirstOrThrow).toHaveBeenCalledWith({
      where: ownedWhere,
    });
    expect(db.sessionMeshMetricEvent.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
        eventType: "presence_heartbeat",
      },
      select: { id: true },
    });
  });

  it("creates a missing presence and re-runs the owned conditional update", async () => {
    db.sessionMeshPresence.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    db.sessionMeshPresence.findFirstOrThrow.mockResolvedValue({ id: "p-new" });

    const result = await sessionMeshService.upsertPresence({
      organizationId: ORG,
      userId: USER,
      presence: presenceInput(),
    });

    expect(result).toEqual({ ok: true, value: { id: "p-new" } });
    const createArgs = db.sessionMeshPresence.createMany.mock.calls[0]?.[0];
    expect(createArgs).toEqual({
      skipDuplicates: true,
      data: db.sessionMeshPresence.updateMany.mock.calls[0]?.[0].data,
    });
    expect(createArgs.data).toMatchObject({
      organizationId: ORG,
      userId: USER,
      agentId: "agent-1",
    });
    expect(db.sessionMeshPresence.updateMany).toHaveBeenCalledTimes(2);
    expect(db.sessionMeshPresence.updateMany.mock.calls[1]?.[0].where).toEqual(
      ownedWhere
    );
    expect(db.sessionMeshMetricEvent.create).toHaveBeenCalledOnce();
  });

  it("refuses an agent id another member already owns", async () => {
    db.sessionMeshPresence.updateMany.mockResolvedValue({ count: 0 });

    const result = await sessionMeshService.upsertPresence({
      organizationId: ORG,
      userId: USER,
      presence: presenceInput(),
    });

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(db.sessionMeshPresence.createMany).toHaveBeenCalledOnce();
    expect(db.sessionMeshPresence.findFirstOrThrow).not.toHaveBeenCalled();
    expect(db.sessionMeshMetricEvent.create).not.toHaveBeenCalled();
  });
});

describe("sessionMeshService.resolveCurrentPresence", () => {
  const select = { agentId: true, repository: true, revision: true };

  it("returns null without a query when neither identity is supplied", async () => {
    await expect(
      sessionMeshService.resolveCurrentPresence({
        organizationId: ORG,
        userId: USER,
      })
    ).resolves.toBeNull();
    expect(db.sessionMeshPresence.findFirst).not.toHaveBeenCalled();
    expect(meshDbState.calls).toEqual([]);
  });

  it("prefers the agent id over a session id", async () => {
    const row = { agentId: "agent-1", repository: "r", revision: "v" };
    db.sessionMeshPresence.findFirst.mockResolvedValue(row);

    await expect(
      sessionMeshService.resolveCurrentPresence({
        organizationId: ORG,
        userId: USER,
        agentId: "agent-1",
        sessionId: "s-1",
      })
    ).resolves.toEqual(row);
    expect(db.sessionMeshPresence.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        userId: USER,
        expiresAt: { gt: NOW },
        agentId: "agent-1",
      },
      select,
      orderBy: { updatedAt: "desc" },
    });
  });

  it("resolves a session id through the persisted lineage path", async () => {
    db.sessionMeshPresence.findFirst.mockResolvedValue(null);

    await expect(
      sessionMeshService.resolveCurrentPresence({
        organizationId: ORG,
        userId: USER,
        sessionId: "s-1",
      })
    ).resolves.toBeNull();
    expect(db.sessionMeshPresence.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        userId: USER,
        expiresAt: { gt: NOW },
        lineage: { path: ["sessionId"], equals: "s-1" },
      },
      select,
      orderBy: { updatedAt: "desc" },
    });
  });
});

describe("sessionMeshService.unregisterPresence", () => {
  it("unregisters by expiring the owned presence now", async () => {
    db.sessionMeshPresence.updateMany.mockResolvedValue({ count: 1 });
    const input = { organizationId: ORG, userId: USER, agentId: "agent-1" };

    await expect(sessionMeshService.unregisterPresence(input)).resolves.toEqual(
      { count: 1 }
    );
    expect(db.sessionMeshPresence.updateMany).toHaveBeenCalledWith({
      where: input,
      data: { expiresAt: NOW },
    });
  });
});

describe("sessionMeshService.roster", () => {
  it("roster returns only the agents of the first page", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue([
      { agentId: "a", context: {} },
    ]);

    await expect(
      sessionMeshService.roster(ORG, { repository: "r" })
    ).resolves.toEqual([{ agentId: "a", context: {} }]);
    expect(db.sessionMeshPresence.findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: ORG,
      expiresAt: { gt: NOW },
      repository: "r",
    });
  });
});
