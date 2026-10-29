import type { SessionMeshPublishInput } from "@repo/api/src/types/session-mesh";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
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

/**
 * Operator decision on #8592 (option B): a message naming `#N` reaches the
 * session on that PR's head branch, read from the organization's own GitHub PR
 * records, even when that session never named the number itself.
 */
const NOW = new Date("2026-10-08T12:00:00.000Z");
const ORG = "0199a1b2-0000-7000-8000-000000000001";
const USER = "0199a1b2-0000-7000-8000-000000000002";
const PEER_USER = "0199a1b2-0000-7000-8000-000000000003";
const MESSAGE_ID = "0199a1b2-0000-7000-8000-0000000000aa";
const REPOSITORY = "github.com/Closedloop-AI/ClosedLoop-AI";
const HEAD_BRANCH = "fix/iss-12167-x";

let db: MeshDb;

function reviewerMessage(
  lineage: Partial<SessionMeshPublishInput["lineage"]> = {
    pullRequest: "#8536",
  },
  repository = REPOSITORY
): SessionMeshPublishInput {
  return {
    messageId: MESSAGE_ID,
    idempotencyKey: "idem-1",
    authorAgentId: "reviewer",
    recipientAgentIds: [],
    kind: "claim",
    workspace: {
      repository,
      revision: "rev-1",
      paths: [],
      symbols: ["PR-8536"],
    },
    lineage: {
      artifactIds: [],
      blocksArtifactIds: [],
      branch: "fix/reviewer",
      ...lineage,
    },
    summary: "Reviewing PR-8536",
    context: {},
    sensitivity: "normal",
    expiresInSeconds: 3600,
  };
}

function peerOn(agentId: string, branch: string) {
  return {
    agentId,
    userId: PEER_USER,
    paths: [],
    symbols: [],
    lineage: { branch },
  };
}

function publish(input: SessionMeshPublishInput = reviewerMessage()) {
  return sessionMeshService.publish({
    organizationId: ORG,
    userId: USER,
    message: input,
  });
}

function deliveredTo(): string[] {
  return (db.sessionMeshDelivery.createMany.mock.calls[0]?.[0].data ?? []).map(
    (row: { recipientAgentId: string }) => row.recipientAgentId
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
  db.sessionMeshPresence.findFirst.mockResolvedValue({ id: "author" });
  db.sessionMeshMessage.createMany.mockResolvedValue({ count: 1 });
  db.sessionMeshMessage.findUnique.mockResolvedValue({
    id: MESSAGE_ID,
    authorUserId: USER,
  });
  db.sessionMeshSubscription.findMany.mockResolvedValue([]);
  db.sessionMeshPresence.findMany.mockResolvedValue([
    peerOn("author", HEAD_BRANCH),
    peerOn("bystander", "fix/other"),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sessionMeshService.publish routes a named PR to its head branch", () => {
  it("delivers a reviewer row to the session on the PR's head branch", async () => {
    db.pullRequestDetail.findFirst.mockResolvedValue({
      headRefName: HEAD_BRANCH,
      headRepositoryFullName: "closedloop-ai/closedloop-ai",
    });

    const result = await publish();

    expect(result.ok).toBe(true);
    expect(db.pullRequestDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          number: 8536,
          headRefName: { not: null },
        },
      })
    );
    const row = db.sessionMeshDelivery.createMany.mock.calls[0]?.[0].data[0];
    expect(row).toMatchObject({
      recipientAgentId: "author",
      status: "queued",
      relevance: {
        rank: "branch_or_pull_request",
        samePullRequest: true,
        sameBranch: false,
      },
    });
  });

  it("does not reach a session on another branch", async () => {
    db.pullRequestDetail.findFirst.mockResolvedValue({
      headRefName: HEAD_BRANCH,
      headRepositoryFullName: null,
    });

    await publish();

    expect(deliveredTo()).toEqual(["author"]);
  });

  it("delivers to nobody new when the PR has no record", async () => {
    db.pullRequestDetail.findFirst.mockResolvedValue(null);

    const result = await publish();

    expect(result.ok).toBe(true);
    expect(deliveredTo()).toEqual([]);
  });

  it("degrades to no head-branch routing when the lookup fails", async () => {
    db.pullRequestDetail.findFirst.mockRejectedValue(new Error("db down"));

    const result = await publish();

    expect(result.ok).toBe(true);
    expect(deliveredTo()).toEqual([]);
  });

  it("ignores a head branch that lives in a fork", async () => {
    db.pullRequestDetail.findFirst.mockResolvedValue({
      headRefName: HEAD_BRANCH,
      headRepositoryFullName: "someone/closedloop-ai",
    });

    await publish();

    expect(deliveredTo()).toEqual([]);
  });

  it("does not look up a message that names no PR, or a non-GitHub repository", async () => {
    await publish(reviewerMessage({}));
    await publish(
      reviewerMessage({ pullRequest: "#8536" }, "gitlab.com/org/repo")
    );

    expect(db.pullRequestDetail.findFirst).not.toHaveBeenCalled();
  });
});
