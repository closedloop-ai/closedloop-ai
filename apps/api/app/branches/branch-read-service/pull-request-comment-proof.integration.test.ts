/**
 * ISS-11767 (PLN-2174 Steps 3-4): the batch route, Branch detail and the
 * Branches-list SQL read PR-comment availability from one lane-proof predicate,
 * so all three agree on every fixture here.
 */
import { randomUUID } from "node:crypto";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { PullRequestCommentLaneStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import type { GitHubPullRequestIssueComment } from "@repo/github";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
  seedBranch,
} from "@/__tests__/support/branches/contributor-parity.test-fixtures";
import {
  deleteLaneProof,
  type HostCollaborators,
  type Hosts,
  HUMAN_AUTHOR,
  OTHER_HUMAN_AUTHOR,
  PULL_REQUEST_AUTHOR_ID,
  readHosts,
  seedCompleteProof,
  seedProvenScope,
  seedSecondPullRequest,
  seedStoredGitHubComments,
} from "@/__tests__/support/branches/pull-request-comment-proof.test-fixtures";
import {
  GITHUB_TEST_REPOSITORY,
  type GitHubCommentScope,
  providerIssueComment,
  providerReview,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  list,
  lists,
  reconcile,
} from "@/__tests__/support/comments/github-comment-reconcile.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { REQUIRED_PULL_REQUEST_COMMENT_LANES } from "@/app/comments/service/github/github-comment-acquisition-proof";
import { COMMENT_EVIDENCE_LIMIT } from "./page-comment-evidence";
import { readPullRequestCommentProof } from "./pull-request-comment-proof-sql";

const tracker = createCommittedTestOrganizationTracker();
const { Complete, Incomplete } = BranchIdentityAvailability;
const PR_AUTHOR_KEY = `github:${PULL_REQUEST_AUTHOR_ID}`;

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

async function hostsOf(
  scope: Pick<GitHubCommentScope, "organizationId" | "branchArtifactId">
): Promise<Hosts> {
  const { batch, detail, sql } = await readHosts(
    scope.organizationId,
    scope.branchArtifactId
  );
  return { batch, detail, sql };
}

/** Every host agreeing on `expected`; the SQL projects no per-source state. */
function agreeing(expected: HostCollaborators): Hosts {
  return {
    batch: expected,
    detail: expected,
    sql: { availability: expected.availability, people: expected.people },
  };
}

function commentAuthorKey(scope: GitHubCommentScope, login: string) {
  return withDb(async (db) => {
    const author = await db.externalCommentAuthor.findFirstOrThrow({
      where: { organizationId: scope.organizationId, providerLogin: login },
      select: { userId: true },
    });
    return closedloopKey(author.userId);
  });
}

const ISSUE_COMMENT = providerIssueComment(1, { user: HUMAN_AUTHOR });

describeIfDb("PR-comment lane proof across batch, detail and list SQL", () => {
  afterEach(() => tracker.cleanup());

  it("reports a Branch with no pull requests complete", async () => {
    const organizationId = await tracker.create();
    const branchArtifactId = await seedBranch(organizationId, "no-pr", {
      firstPushedAt: null,
      pushCoverageAvailability: Complete,
    });

    expect(await hostsOf({ organizationId, branchArtifactId })).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: [],
      })
    );
  });

  it("is complete with every lane proven and incomplete when any one lane row is missing", async () => {
    const scope = await seedProvenScope(await tracker.create());
    await reconcile(scope, lists({ issueComments: list([ISSUE_COMMENT]) }));
    const commenter = await commentAuthorKey(scope, HUMAN_AUTHOR.login);
    const people = await scopePeople(scope, commenter, PR_AUTHOR_KEY);
    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people,
      })
    );

    for (const lane of REQUIRED_PULL_REQUEST_COMMENT_LANES) {
      await deleteLaneProof(scope, lane);
      expect(await hostsOf(scope)).toEqual(
        agreeing({
          pullRequestComments: Incomplete,
          availability: Incomplete,
          people,
        })
      );
      await reconcile(scope, lists({ issueComments: list([ISSUE_COMMENT]) }));
    }
  });

  it("is incomplete when a lane's latest attempt failed, hit its ceiling or shifted", async () => {
    // A GitHub comment id is one provider object, so each Branch gets its own.
    const outcomes = [
      {
        status: PullRequestCommentLaneStatus.FAILED,
        read: (comment: GitHubPullRequestIssueComment) =>
          lists({
            issueComments: list([comment]),
            reviews: { status: GitHubProviderResultStatus.ProviderUnavailable },
          }),
      },
      {
        status: PullRequestCommentLaneStatus.CEILING,
        read: (comment: GitHubPullRequestIssueComment) =>
          lists({ issueComments: list([comment], false) }),
      },
      {
        status: PullRequestCommentLaneStatus.SHIFTED,
        read: (comment: GitHubPullRequestIssueComment) =>
          lists({
            issueComments: list([comment]),
            reviewComments: {
              status: GitHubProviderResultStatus.Success,
              value: { items: [], complete: false, shifted: true },
            },
          }),
      },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const scope = await seedProvenScope(await tracker.create());
      const comment = providerIssueComment(100 + index, { user: HUMAN_AUTHOR });
      await reconcile(scope, lists({ issueComments: list([comment]) }));
      await reconcile(scope, outcome.read(comment));
      const statuses = await withDb((db) =>
        db.pullRequestCommentAcquisition.findMany({
          where: { pullRequestDetailId: scope.pullRequestDetailId },
          select: { status: true },
        })
      );
      expect(statuses.map((row) => row.status)).toContain(outcome.status);
      expect(await hostsOf(scope)).toEqual(
        agreeing({
          pullRequestComments: Incomplete,
          availability: Incomplete,
          people: await scopePeople(
            scope,
            await commentAuthorKey(scope, HUMAN_AUTHOR.login),
            PR_AUTHOR_KEY
          ),
        })
      );
    }
  });

  it("needs every associated pull request proven", async () => {
    const scope = await seedProvenScope(await tracker.create());
    const second = await seedSecondPullRequest(scope);
    await reconcile(scope, lists());
    await reconcile(second, lists());
    const lane = REQUIRED_PULL_REQUEST_COMMENT_LANES[0];
    if (!lane) {
      throw new Error("no required lane");
    }
    await deleteLaneProof(second, lane);
    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Incomplete,
        availability: Incomplete,
        people: await scopePeople(scope, PR_AUTHOR_KEY),
      })
    );

    await reconcile(second, lists());
    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: await scopePeople(scope, PR_AUTHOR_KEY),
      })
    );
  });

  it("reports stored PR comments over the evidence cap incomplete despite complete proof", async () => {
    const scope = await seedProvenScope(await tracker.create());
    const user = await createTestUser(scope.organizationId);
    await seedStoredGitHubComments(scope, user.id, COMMENT_EVIDENCE_LIMIT + 1);
    await seedCompleteProof(scope);

    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Incomplete,
        availability: Incomplete,
        people: await scopePeople(scope, closedloopKey(user.id), PR_AUTHOR_KEY),
      })
    );
  });

  it("keeps an unresolved comment author incomplete over complete proof and still lists known people", async () => {
    const scope = await seedProvenScope(await tracker.create());
    const unclassified = {
      id: 7474,
      login: "no-actor-type",
      node_id: "U_7474",
      avatar_url: "https://avatars.example/7474",
    };
    await reconcile(
      scope,
      lists({
        issueComments: list([
          ISSUE_COMMENT,
          providerIssueComment(2, { user: unclassified }),
        ]),
      })
    );

    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Incomplete,
        availability: Incomplete,
        people: await scopePeople(
          scope,
          await commentAuthorKey(scope, HUMAN_AUTHOR.login),
          PR_AUTHOR_KEY
        ),
      })
    );
  });

  it("lists a review summary's author, not a bodyless approval's, with the reviews lane complete", async () => {
    const scope = await seedProvenScope(await tracker.create());
    await reconcile(
      scope,
      lists({
        reviews: list([
          { ...providerReview(7, "Looks good"), author: HUMAN_AUTHOR },
          {
            ...providerReview(8, null),
            state: "APPROVED",
            author: OTHER_HUMAN_AUTHOR,
          },
        ]),
      })
    );

    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: await scopePeople(
          scope,
          await commentAuthorKey(scope, HUMAN_AUTHOR.login),
          PR_AUTHOR_KEY
        ),
      })
    );
  });

  it("drops a commenter whose comment a complete list's cleanup retracted", async () => {
    const scope = await seedProvenScope(await tracker.create());
    const retracted = providerIssueComment(9999, { user: OTHER_HUMAN_AUTHOR });
    await reconcile(
      scope,
      lists({ issueComments: list([ISSUE_COMMENT, retracted]) })
    );
    const kept = await commentAuthorKey(scope, HUMAN_AUTHOR.login);
    const dropped = await commentAuthorKey(scope, OTHER_HUMAN_AUTHOR.login);
    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: await scopePeople(scope, kept, dropped, PR_AUTHOR_KEY),
      })
    );

    await reconcile(scope, lists({ issueComments: list([ISSUE_COMMENT]) }));

    expect(await hostsOf(scope)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: await scopePeople(scope, kept, PR_AUTHOR_KEY),
      })
    );
  });

  it("names one person across PR author, pusher, issue comment and review summary through their verified link", async () => {
    const scope = await seedProvenScope(await tracker.create());
    const person = await createTestUser(scope.organizationId);
    await withDb(async (db) => {
      await db.gitHubUserConnection.create({
        data: {
          organizationId: scope.organizationId,
          userId: person.id,
          githubUserId: String(HUMAN_AUTHOR.id),
          login: HUMAN_AUTHOR.login,
          normalizedLogin: HUMAN_AUTHOR.login,
        },
        select: { id: true },
      });
      await db.pullRequestDetail.update({
        where: { id: scope.pullRequestDetailId },
        data: {
          authorProviderUserId: String(HUMAN_AUTHOR.id),
          authorLogin: HUMAN_AUTHOR.login,
        },
        select: { id: true },
      });
      const branch = await db.branchDetail.findUniqueOrThrow({
        where: { artifactId: scope.branchArtifactId },
        select: { branchName: true },
      });
      await db.branchPushContribution.create({
        data: {
          organizationId: scope.organizationId,
          branchArtifactId: scope.branchArtifactId,
          repositoryFullName: GITHUB_TEST_REPOSITORY,
          refName: branch.branchName,
          source: BranchPushContributionSource.GraphqlPush,
          sourceEventId: randomUUID(),
          providerUserId: String(HUMAN_AUTHOR.id),
          actorType: GitHubActorType.User,
          beforeSha: "a".repeat(40),
          afterSha: "b".repeat(40),
          observedAt: new Date(),
        },
        select: { id: true },
      });
    });
    // The token's owner is the GitHub `User` actor on a comment an agent or
    // MCP client posted with that token.
    await reconcile(
      scope,
      lists({
        issueComments: list([ISSUE_COMMENT]),
        reviews: list([
          { ...providerReview(7, "Agent summary"), author: HUMAN_AUTHOR },
        ]),
      })
    );

    const hosts = await readHosts(scope.organizationId, scope.branchArtifactId);
    for (const host of [hosts.batch, hosts.detail]) {
      expect(host.people).toEqual(
        await scopePeople(scope, closedloopKey(person.id))
      );
      expect(host.pullRequestComments).toBe(Complete);
    }
    expect(hosts.sql.people).toEqual(
      await scopePeople(scope, closedloopKey(person.id))
    );
  });

  it("never counts proof for a pull request on another Branch", async () => {
    const organizationId = await tracker.create();
    const unproven = await seedProvenScope(organizationId, { number: 1 });
    const proven = await seedProvenScope(organizationId, { number: 2 });
    await reconcile(proven, lists());

    expect(await hostsOf(unproven)).toEqual(
      agreeing({
        pullRequestComments: Incomplete,
        availability: Incomplete,
        people: await scopePeople(unproven, PR_AUTHOR_KEY),
      })
    );
    expect(await hostsOf(proven)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: await scopePeople(proven, PR_AUTHOR_KEY),
      })
    );
  });

  it("never reads proof across organizations", async () => {
    const unproven = await seedProvenScope(await tracker.create());
    const foreign = await seedProvenScope(await tracker.create());
    await reconcile(foreign, lists());

    // Composite FKs tie every proof row to its PR's organization and every PR
    // to its Branch's, so only a caller's organization paired with another
    // organization's Branch can reach the proof read's organization predicate.
    expect(
      await withDb((db) =>
        readPullRequestCommentProof(db, foreign.organizationId, [
          unproven.branchArtifactId,
          foreign.branchArtifactId,
        ])
      )
    ).toEqual(new Set());

    expect(await hostsOf(unproven)).toEqual(
      agreeing({
        pullRequestComments: Incomplete,
        availability: Incomplete,
        people: await scopePeople(unproven, PR_AUTHOR_KEY),
      })
    );
    expect(await hostsOf(foreign)).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Complete,
        people: await scopePeople(foreign, PR_AUTHOR_KEY),
      })
    );
  });

  it("does not promote incomplete push coverage on complete PR-comment proof", async () => {
    const scope = await seedProvenScope(await tracker.create(), {
      pushCoverageAvailability: Incomplete,
    });
    await reconcile(scope, lists());

    const hosts = await readHosts(scope.organizationId, scope.branchArtifactId);
    expect(hosts.pushes).toEqual([Incomplete, Incomplete]);
    expect({
      batch: hosts.batch,
      detail: hosts.detail,
      sql: hosts.sql,
    }).toEqual(
      agreeing({
        pullRequestComments: Complete,
        availability: Incomplete,
        people: await scopePeople(scope, PR_AUTHOR_KEY),
      })
    );
  });
});

/** Direct creation participation remains visible beside the lane-specific evidence. */
async function scopePeople(
  scope: GitHubCommentScope,
  ...people: string[]
): Promise<string[]> {
  const artifact = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: scope.branchArtifactId },
      select: { createdById: true },
    })
  );
  if (artifact.createdById) {
    people.push(closedloopKey(artifact.createdById));
  }
  return [...new Set(people)].sort();
}
