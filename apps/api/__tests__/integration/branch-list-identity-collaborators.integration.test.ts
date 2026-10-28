import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { withDb } from "@repo/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
  FIRST_PUSHED_AT,
  GIT_PUSH_METHOD,
  HAS_DATABASE,
  readIdentityProjections,
  seedBranch,
  seedEvidenceLink,
  seedGitHubComment,
  seedNativeComment,
  seedPullRequestDetail,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { resolveBranchIdentities } from "@/app/branches/branch-read-service/identity-attribution";

/**
 * ISS-10298 — equivalence oracle for the Branches-list COLLABORATOR identity
 * LATERAL, split out of `branch-list-identity-sql.integration.test.ts` (which
 * keeps the owner half) when the shared file crossed the 1,000-line ceiling.
 * Same contract: the JS projector is the specification and each case asserts
 * the SQL agrees with it over one seeded corpus.
 */

const describeIfDb = HAS_DATABASE ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

describeIfDb("branch list collaborator identity SQL (ISS-10298)", () => {
  it("drops a Bot GitHub comment author without flagging the corpus", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "github-bot", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedGitHubComment({
        organizationId,
        branchId,
        label: "bot",
        author: {
          userId: user.id,
          providerUserId: "gh-bot-1",
          providerLogin: "renovate[bot]",
          displayName: "Renovate",
          providerDetail: { actorType: GitHubActorType.Bot },
        },
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.collaboratorKeys).toEqual([]);
    });
  });

  it("resolves a User GitHub comment author as a collaborator", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "github-user", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedGitHubComment({
        organizationId,
        branchId,
        label: "human",
        author: {
          userId: user.id,
          providerUserId: "gh-human-1",
          providerLogin: "ada",
          displayName: "Ada Lovelace",
          providerDetail: { actorType: GitHubActorType.User },
        },
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.collaboratorKeys).toEqual([closedloopKey(user.id)]);
      expect(sql.collaboratorLabels).toEqual(["Ada Lovelace"]);
    });
  });

  it("keeps a cross-org GitHub comment author out of this org's collaborators", async () => {
    await committedOrganizations.run(async () => {
      // Two orgs expose the unscoped author hop: github_comment_projections has
      // no organization_id, so no composite FK prevents a foreign-org author.
      const organizationId = await committedOrganizations.create();
      const foreignOrganizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const foreignUser = await createTestUser(foreignOrganizationId);
      const branchId = await seedBranch(organizationId, "cross-org", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedGitHubComment({
        organizationId,
        branchId,
        label: "local",
        author: {
          userId: user.id,
          providerUserId: "gh-local-1",
          providerLogin: "ada",
          displayName: "Ada Lovelace",
          providerDetail: { actorType: GitHubActorType.User },
        },
      });
      await seedGitHubComment({
        organizationId,
        branchId,
        label: "foreign",
        author: {
          organizationId: foreignOrganizationId,
          userId: foreignUser.id,
          providerUserId: "gh-foreign-1",
          providerLogin: "mallory",
          displayName: "Mallory Foreign",
          providerDetail: { actorType: GitHubActorType.User },
        },
      });

      const { sql, expected: js } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(js.collaboratorLabels).not.toContain("Mallory Foreign");
      expect(js.collaboratorKeys).not.toContain(closedloopKey(foreignUser.id));
      expect(js.collaboratorKeys).toEqual([closedloopKey(user.id)]);
      expect(js.collaboratorLabels).toEqual(["Ada Lovelace"]);
      expect(sql).toEqual(js);

      // Zero PRs isolates unresolved evidence from PR-acquisition incompleteness.
      const withoutAcquisitionGap = await withDb((db) =>
        resolveBranchIdentities(
          db,
          organizationId,
          [
            {
              branchId,
              assigneeId: null,
              firstPushedAt: FIRST_PUSHED_AT,
              associatedPullRequestCount: 0,
            },
          ],
          []
        )
      );
      expect(
        withoutAcquisitionGap.get(branchId)?.collaborators.availability
      ).toBe(BranchIdentityAvailability.Incomplete);
    });
  });

  it("drops a GitHub comment author carrying no provider detail", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "github-unknown", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedGitHubComment({
        organizationId,
        branchId,
        label: "unknown",
        author: {
          userId: user.id,
          providerUserId: "gh-unknown-1",
          providerLogin: "mystery",
          displayName: "Mystery",
          providerDetail: null,
        },
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.collaboratorKeys).toEqual([]);
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });
  });

  it("prefers the GitHub identity when a person comments on both surfaces", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId, {
        firstName: "Native",
        lastName: "Name",
      });
      const branchId = await seedBranch(organizationId, "both-surfaces", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedNativeComment({
        organizationId,
        artifactId: branchId,
        authorId: user.id,
      });
      await seedGitHubComment({
        organizationId,
        branchId,
        label: "both",
        author: {
          userId: user.id,
          providerUserId: "gh-both-1",
          providerLogin: "native",
          displayName: "GitHub Name",
          providerDetail: { actorType: GitHubActorType.User },
        },
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.collaboratorKeys).toEqual([closedloopKey(user.id)]);
      expect(sql.collaboratorLabels).toEqual(["GitHub Name"]);
    });
  });

  it("reports collaborators incomplete for a branch whose pull request has no comment proof", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "with-pr", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedNativeComment({
        organizationId,
        artifactId: branchId,
        authorId: user.id,
      });
      await seedPullRequestDetail(organizationId, branchId, "with-pr");

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.collaboratorKeys).toEqual([closedloopKey(user.id)]);
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });
  });

  it("resolves a collaborator from a comment on a linked session", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const owner = await createTestUser(organizationId);
      const commenter = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "session-comment", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      const sessionId = await seedEvidenceLink({
        organizationId,
        branchId,
        userId: owner.id,
        label: "session-comment",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      await seedNativeComment({
        organizationId,
        artifactId: sessionId,
        authorId: commenter.id,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.collaboratorKeys).toEqual(
        [closedloopKey(owner.id), closedloopKey(commenter.id)].sort()
      );
      expect(sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });
  });

  it("keeps a known commenter while missing pusher coverage remains incomplete", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const knownId = await seedBranch(organizationId, "native-known", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedNativeComment({
        organizationId,
        artifactId: knownId,
        authorId: user.id,
      });
      const unknownId = await seedBranch(organizationId, "native-unknown", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedNativeComment({
        organizationId,
        artifactId: unknownId,
        authorId: crypto.randomUUID(),
      });

      const known = await readIdentityProjections(organizationId, knownId);
      const unknown = await readIdentityProjections(organizationId, unknownId);

      expect(known.sql).toEqual(known.expected);
      expect(unknown.sql).toEqual(unknown.expected);
      expect(known.sql.collaboratorKeys).toEqual([closedloopKey(user.id)]);
      expect(known.sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
      expect(unknown.sql.collaboratorKeys).toEqual([]);
      expect(unknown.sql.collaboratorAvailability).toBe(
        BranchIdentityAvailability.Incomplete
      );
    });
  });
});
