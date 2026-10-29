import { Status } from "@repo/api/src/types/result";
import type { SessionMeshPublishInput } from "@repo/api/src/types/session-mesh";
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
const PEER_USER = "0199a1b2-0000-7000-8000-000000000003";
const MESSAGE_ID = "0199a1b2-0000-7000-8000-0000000000aa";
const REPLY_TO = "0199a1b2-0000-7000-8000-0000000000bb";
const ARTIFACT_A = "0199a1b2-0000-7000-8000-00000000a001";
const ARTIFACT_B = "0199a1b2-0000-7000-8000-00000000a002";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: MeshDb;

type Lineage = SessionMeshPublishInput["lineage"];

function message(
  overrides: Partial<SessionMeshPublishInput> = {}
): SessionMeshPublishInput {
  return {
    messageId: MESSAGE_ID,
    idempotencyKey: "idem-1",
    authorAgentId: "author-agent",
    recipientAgentIds: [],
    kind: "discovery",
    workspace: {
      repository: "closedloop/app",
      revision: "rev-1",
      paths: ["src/a.ts"],
      symbols: ["fnA"],
    },
    lineage: { artifactIds: [], blocksArtifactIds: [] },
    summary: "found something",
    context: {},
    sensitivity: "normal",
    expiresInSeconds: 3600,
    ...overrides,
  };
}

function peer(
  agentId: string,
  fields: { paths?: unknown; symbols?: unknown; lineage?: unknown } = {},
  userId = PEER_USER
) {
  return {
    agentId,
    userId,
    paths: "paths" in fields ? fields.paths : [],
    symbols: "symbols" in fields ? fields.symbols : [],
    lineage: "lineage" in fields ? fields.lineage : {},
  };
}

/** Author is live, the insert wins, and the stored message is the user's. */
function arrangeFreshPublish() {
  db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "author" });
  db.sessionMeshMessage.createMany.mockResolvedValue({ count: 1 });
  db.sessionMeshMessage.findUnique.mockResolvedValue({
    id: MESSAGE_ID,
    authorUserId: USER,
  });
  db.sessionMeshSubscription.findMany.mockResolvedValue([]);
}

function publish(input: SessionMeshPublishInput = message()) {
  return sessionMeshService.publish({
    organizationId: ORG,
    userId: USER,
    message: input,
  });
}

function deliveryRows() {
  return db.sessionMeshDelivery.createMany.mock.calls[0]?.[0].data ?? [];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sessionMeshService.publish authorization", () => {
  it("refuses an author agent that is not live and owned", async () => {
    db.sessionMeshPresence.findFirst.mockResolvedValue(null);

    await expect(publish()).resolves.toEqual({
      ok: false,
      error: Status.Forbidden,
    });
    expect(meshDbState.calls).toEqual([{ kind: "tx", options: undefined }]);
    expect(db.sessionMeshPresence.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        userId: USER,
        agentId: "author-agent",
        expiresAt: { gt: NOW },
      },
    });
    expect(db.sessionMeshMessage.createMany).not.toHaveBeenCalled();
  });

  it("refuses a reply to a message the author agent never received", async () => {
    db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "author" });
    db.sessionMeshDelivery.findFirst.mockResolvedValue(null);

    await expect(
      publish(message({ replyToMessageId: REPLY_TO, kind: "reply" }))
    ).resolves.toEqual({ ok: false, error: Status.Forbidden });
    expect(db.sessionMeshDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        messageId: REPLY_TO,
        recipientUserId: USER,
        recipientAgentId: "author-agent",
      },
      select: { id: true },
    });
    expect(db.sessionMeshMessage.createMany).not.toHaveBeenCalled();
  });

  it("publishes a reply to a message the author agent received", async () => {
    arrangeFreshPublish();
    db.sessionMeshDelivery.findFirst.mockResolvedValue({ id: "d-reply" });
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    const result = await publish(
      message({ replyToMessageId: REPLY_TO, kind: "reply" })
    );

    expect(result).toEqual({
      ok: true,
      value: {
        message: { id: MESSAGE_ID, authorUserId: USER },
        deliveries: 0,
        idempotent: false,
      },
    });
    expect(
      db.sessionMeshMessage.createMany.mock.calls[0]?.[0].data.replyToMessageId
    ).toBe(REPLY_TO);
  });

  it("refuses when the idempotency key resolves to no message", async () => {
    db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "author" });
    db.sessionMeshMessage.createMany.mockResolvedValue({ count: 0 });
    db.sessionMeshMessage.findUnique.mockResolvedValue(null);

    await expect(publish()).resolves.toEqual({
      ok: false,
      error: Status.Forbidden,
    });
    expect(db.sessionMeshMessage.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_idempotencyKey: {
          organizationId: ORG,
          idempotencyKey: "idem-1",
        },
      },
    });
  });

  it("refuses when the idempotency key belongs to another user's message", async () => {
    db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "author" });
    db.sessionMeshMessage.createMany.mockResolvedValue({ count: 0 });
    db.sessionMeshMessage.findUnique.mockResolvedValue({
      id: MESSAGE_ID,
      authorUserId: "other-user",
    });

    await expect(publish()).resolves.toEqual({
      ok: false,
      error: Status.Forbidden,
    });
    expect(db.sessionMeshPresence.findMany).not.toHaveBeenCalled();
  });

  it("returns the stored message idempotently when the insert was a duplicate", async () => {
    db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "author" });
    db.sessionMeshMessage.createMany.mockResolvedValue({ count: 0 });
    const stored = { id: MESSAGE_ID, authorUserId: USER };
    db.sessionMeshMessage.findUnique.mockResolvedValue(stored);

    await expect(publish()).resolves.toEqual({
      ok: true,
      value: { message: stored, deliveries: 0, idempotent: true },
    });
    expect(db.sessionMeshPresence.findMany).not.toHaveBeenCalled();
    expect(db.sessionMeshDelivery.createMany).not.toHaveBeenCalled();
    expect(db.sessionMeshMetricEvent.create).not.toHaveBeenCalled();
  });
});

describe("sessionMeshService.publish message record", () => {
  it("persists the sanitized message with the caller-supplied id", async () => {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await publish(
      message({
        summary: "ok",
        context: { note: "kept", credentials: "dropped" },
        recipientAgentIds: ["peer-x"],
      })
    );

    expect(db.sessionMeshMessage.createMany).toHaveBeenCalledWith({
      data: {
        id: MESSAGE_ID,
        organizationId: ORG,
        authorUserId: USER,
        authorAgentId: "author-agent",
        idempotencyKey: "idem-1",
        recipientAgentIds: ["peer-x"],
        replyToMessageId: undefined,
        kind: "discovery",
        repository: "closedloop/app",
        revision: "rev-1",
        dirtyStateHash: undefined,
        configurationHash: undefined,
        lineage: { artifactIds: [], blocksArtifactIds: [] },
        paths: ["src/a.ts"],
        symbols: ["fnA"],
        summary: "ok",
        context: { note: "kept" },
        sensitivity: "normal",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
      skipDuplicates: true,
    });
  });

  it("mints a UUID when the caller supplies no message id", async () => {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await publish(message({ messageId: undefined }));

    const id = db.sessionMeshMessage.createMany.mock.calls[0]?.[0].data.id;
    expect(id).toMatch(UUID_PATTERN);
    expect(id).not.toBe(MESSAGE_ID);
  });

  it("queries live or explicitly addressed peers, excluding the author", async () => {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await publish(message({ recipientAgentIds: ["peer-x"] }));

    expect(db.sessionMeshPresence.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        repository: "closedloop/app",
        OR: [{ expiresAt: { gt: NOW } }, { agentId: { in: ["peer-x"] } }],
        agentId: { not: "author-agent" },
      },
    });
    expect(db.sessionMeshSubscription.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, repository: "closedloop/app" },
      select: { userId: true, muted: true, digestOnly: true },
    });
  });

  it("omits the author exclusion for an empty author agent id", async () => {
    // pins current behavior; looks odd because the wire validator forbids an
    // empty authorAgentId, but the service type admits it and then drops the
    // self-exclusion filter.
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await publish(message({ authorAgentId: "" }));

    expect(db.sessionMeshPresence.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        repository: "closedloop/app",
        OR: [{ expiresAt: { gt: NOW } }, { agentId: { in: [] } }],
      },
    });
  });

  it("writes no deliveries but still records the publish metric", async () => {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([
      peer("unrelated", { paths: ["other.ts"] }),
    ]);

    await expect(publish()).resolves.toMatchObject({
      ok: true,
      value: { deliveries: 0, idempotent: false },
    });
    expect(db.sessionMeshDelivery.createMany).not.toHaveBeenCalled();
    expect(db.sessionMeshMetricEvent.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        userId: USER,
        agentId: "author-agent",
        messageId: MESSAGE_ID,
        eventType: "message_published",
        metadata: { kind: "discovery", recipients: 0 },
      },
      select: { id: true },
    });
  });
});

describe("sessionMeshService.publish fan-out", () => {
  it("skips muted users, holds digest-only users, and queues relevant peers", async () => {
    arrangeFreshPublish();
    const mutedUser = "0199a1b2-0000-7000-8000-00000000000m";
    const digestUser = "0199a1b2-0000-7000-8000-00000000000d";
    db.sessionMeshSubscription.findMany.mockResolvedValue([
      { userId: mutedUser, muted: true, digestOnly: false },
      { userId: digestUser, muted: false, digestOnly: true },
      { userId: PEER_USER, muted: false, digestOnly: false },
    ]);
    db.sessionMeshPresence.findMany.mockResolvedValue([
      peer("muted-peer", { paths: ["src/a.ts"] }, mutedUser),
      peer("digest-peer", { paths: ["src/a.ts"] }, digestUser),
      peer("live-peer", { paths: ["src/a.ts"] }),
    ]);

    await expect(publish()).resolves.toMatchObject({
      ok: true,
      value: { deliveries: 2 },
    });
    expect(db.sessionMeshDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          organizationId: ORG,
          messageId: MESSAGE_ID,
          recipientUserId: digestUser,
          recipientAgentId: "digest-peer",
          status: "held",
        }),
        expect.objectContaining({
          recipientUserId: PEER_USER,
          recipientAgentId: "live-peer",
          status: "queued",
        }),
      ],
      skipDuplicates: true,
    });
    expect(
      db.sessionMeshMetricEvent.create.mock.calls[0]?.[0].data.metadata
    ).toEqual({ kind: "discovery", recipients: 2 });
  });

  it("delivers restricted context only to explicit recipients", async () => {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([
      peer("overlapping", { paths: ["src/a.ts"] }),
      peer("addressed"),
    ]);

    await publish(
      message({ sensitivity: "restricted", recipientAgentIds: ["addressed"] })
    );

    expect(deliveryRows()).toEqual([
      {
        organizationId: ORG,
        messageId: MESSAGE_ID,
        recipientUserId: PEER_USER,
        recipientAgentId: "addressed",
        relevance: { explicit: true },
        status: "queued",
      },
    ]);
  });

  it("queues an explicit recipient in normal sensitivity without overlap", async () => {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([peer("addressed")]);

    await publish(message({ recipientAgentIds: ["addressed"] }));

    expect(deliveryRows()).toEqual([
      expect.objectContaining({
        recipientAgentId: "addressed",
        relevance: { explicit: true },
        status: "queued",
      }),
    ]);
  });
});

describe("sessionMeshService.publish relevance ranking", () => {
  const noEvidence = {
    pathOverlap: [],
    pathOverlapCount: 0,
    symbolOverlap: [],
    symbolOverlapCount: 0,
    sameBranch: false,
    samePullRequest: false,
    artifactOverlap: [],
    blocksArtifacts: [],
    blockedByArtifacts: [],
  };

  async function relevanceFor(
    peerFields: Parameters<typeof peer>[1],
    lineage: Lineage = { artifactIds: [], blocksArtifactIds: [] }
  ) {
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([
      peer("candidate", peerFields),
    ]);
    await publish(message({ lineage }));
    return deliveryRows()[0];
  }

  it("ranks a path overlap as queued overlap", async () => {
    expect(await relevanceFor({ paths: ["src/a.ts", "src/z.ts"] })).toEqual(
      expect.objectContaining({
        status: "queued",
        relevance: {
          ...noEvidence,
          rank: "overlap",
          pathOverlap: ["src/a.ts"],
          pathOverlapCount: 1,
        },
      })
    );
  });

  it("ranks a symbol-only overlap as overlap", async () => {
    const row = await relevanceFor({ symbols: ["fnA"] });
    expect(row?.relevance).toEqual({
      ...noEvidence,
      rank: "overlap",
      symbolOverlap: ["fnA"],
      symbolOverlapCount: 1,
    });
  });

  it("caps overlap samples at eight while keeping the exact counts", async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `p${index}.ts`);
    const symbols = Array.from({ length: 9 }, (_, index) => `fn${index}`);
    arrangeFreshPublish();
    db.sessionMeshPresence.findMany.mockResolvedValue([
      peer("candidate", { paths, symbols }),
    ]);

    await publish(
      message({
        workspace: {
          repository: "closedloop/app",
          revision: "rev-1",
          paths,
          symbols,
        },
      })
    );

    expect(deliveryRows()[0]?.relevance).toMatchObject({
      pathOverlap: paths.slice(0, 8),
      pathOverlapCount: 10,
      symbolOverlap: symbols.slice(0, 8),
      symbolOverlapCount: 9,
    });
  });

  it("ranks a shared branch above shared artifacts", async () => {
    const row = await relevanceFor(
      { lineage: { branch: "feat/x" } },
      { artifactIds: [], blocksArtifactIds: [], branch: "feat/x" }
    );
    expect(row).toEqual(
      expect.objectContaining({
        status: "queued",
        relevance: {
          ...noEvidence,
          rank: "branch_or_pull_request",
          sameBranch: true,
        },
      })
    );
  });

  it("ranks a shared pull request when the branches differ", async () => {
    const row = await relevanceFor(
      { lineage: { branch: "feat/y", pullRequest: "#12" } },
      {
        artifactIds: [],
        blocksArtifactIds: [],
        branch: "feat/x",
        pullRequest: "#12",
      }
    );
    expect(row?.relevance).toEqual({
      ...noEvidence,
      rank: "branch_or_pull_request",
      samePullRequest: true,
    });
  });

  it("holds a delivery whose only evidence is a shared artifact", async () => {
    const row = await relevanceFor(
      { lineage: { artifactIds: [ARTIFACT_A, 7] } },
      { artifactIds: [ARTIFACT_A], blocksArtifactIds: [] }
    );
    expect(row).toEqual(
      expect.objectContaining({
        status: "held",
        relevance: {
          ...noEvidence,
          rank: "shared_artifact",
          artifactOverlap: [ARTIFACT_A],
        },
      })
    );
  });

  it("ranks work this message blocks as an explicit dependency", async () => {
    const row = await relevanceFor(
      { lineage: { artifactIds: [ARTIFACT_B] } },
      { artifactIds: [], blocksArtifactIds: [ARTIFACT_B] }
    );
    expect(row).toEqual(
      expect.objectContaining({
        status: "queued",
        relevance: {
          ...noEvidence,
          rank: "explicit_dependency",
          blocksArtifacts: [ARTIFACT_B],
        },
      })
    );
  });

  it("ranks work blocking this message as an explicit dependency", async () => {
    const row = await relevanceFor(
      { lineage: { blocksArtifactIds: [ARTIFACT_A] } },
      { artifactIds: [ARTIFACT_A], blocksArtifactIds: [] }
    );
    expect(row?.relevance).toEqual({
      ...noEvidence,
      rank: "explicit_dependency",
      blockedByArtifacts: [ARTIFACT_A],
    });
  });

  it("ignores dependency ids the other side is not working on", async () => {
    const row = await relevanceFor(
      { paths: ["src/a.ts"], lineage: { blocksArtifactIds: [ARTIFACT_A] } },
      { artifactIds: [], blocksArtifactIds: [ARTIFACT_B] }
    );
    expect(row?.relevance).toEqual({
      ...noEvidence,
      rank: "overlap",
      pathOverlap: ["src/a.ts"],
      pathOverlapCount: 1,
    });
  });

  it.each([
    ["null lineage", null],
    ["string lineage", "feat/x"],
    ["array lineage", ["feat/x"]],
    ["non-string branch", { branch: 7, pullRequest: 12 }],
    ["non-array artifact ids", { artifactIds: ARTIFACT_A }],
  ])(
    "finds no evidence in a malformed persisted peer row (%s)",
    async (_label, lineage) => {
      arrangeFreshPublish();
      db.sessionMeshPresence.findMany.mockResolvedValue([
        peer("candidate", { paths: "src/a.ts", symbols: null, lineage }),
      ]);

      await publish(
        message({
          lineage: {
            artifactIds: [ARTIFACT_A],
            blocksArtifactIds: [],
            branch: "feat/x",
            pullRequest: "12",
          },
        })
      );

      expect(db.sessionMeshDelivery.createMany).not.toHaveBeenCalled();
    }
  );
});
