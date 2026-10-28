import { describe, expect, it, vi } from "vitest";
import { resolveBranchIdentities } from "./identity-attribution";
import type { SessionBranchIdentityEvidence } from "./session-usage-window";

describe("Branch owner evidence indexing", () => {
  it("visits link targets linearly while preserving each branch's distinct pusher", async () => {
    const branches = Array.from({ length: 80 }, (_, i) => ({
      branchId: `branch-${i}`,
      assigneeId: null,
      firstPushedAt: new Date(0),
      associatedPullRequestCount: 0,
    }));
    let targetReads = 0;
    const creatorBySessionId = new Map<string, string>();
    const evidence: SessionBranchIdentityEvidence[] = branches.flatMap(
      ({ branchId }) =>
        Array.from({ length: 25 }, (_, i) => {
          const sourceId = `session-${branchId}-${i}`;
          creatorBySessionId.set(sourceId, `user-${branchId}`);
          return {
            get targetId() {
              targetReads++;
              return branchId;
            },
            sourceId,
            branchParticipationMethod: "git_push",
            branchParticipationObservedAt: new Date(0),
          };
        })
    );
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      // ISS-12251: each pushing session's creator, the person its push names.
      artifact: {
        findMany: vi
          .fn()
          .mockImplementation(
            (args: { where: { id: { in: readonly string[] } } }) =>
              Promise.resolve(
                args.where.id.in.map((id) => ({
                  id,
                  createdById: creatorBySessionId.get(id) ?? null,
                }))
              )
          ),
      },
      comment: { findMany: vi.fn().mockResolvedValue([]) },
      branchDetail: {
        findMany: vi.fn().mockResolvedValue(
          branches.map((branch) => ({
            artifactId: branch.branchId,
            firstPushedAt: branch.firstPushedAt,
            pushCoverageAvailability: null,
          }))
        ),
      },
      branchPushContribution: { findMany: vi.fn().mockResolvedValue([]) },
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
      externalCommentAuthor: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubCommentProjection: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findMany: vi.fn().mockResolvedValue([]) },
      user: {
        findMany: vi.fn().mockResolvedValue(
          branches.map(({ branchId }) => ({
            id: `user-${branchId}`,
            clerkId: `user_${branchId}`,
            email: `${branchId}@example.com`,
            firstName: branchId,
            lastName: "Owner",
            avatarUrl: null,
          }))
        ),
      },
    };
    const result = await resolveBranchIdentities(
      db as never,
      "org-1",
      branches,
      evidence
    );
    // The observed pusher is each branch's Collaborator (ISS-12463: Owner is
    // the assignee, so the push evidence no longer names the Owner).
    for (const { branchId } of branches) {
      expect(
        result
          .get(branchId)
          ?.collaborators.people.map((person) => person.userId)
      ).toEqual([`user-${branchId}`]);
    }
    // Fixed linear budget. A full evidence filter per Branch consumes over
    // 80 visits per link on this fixture, even though the output is identical.
    expect(targetReads).toBeLessThanOrEqual(evidence.length * 6);
  });
});
