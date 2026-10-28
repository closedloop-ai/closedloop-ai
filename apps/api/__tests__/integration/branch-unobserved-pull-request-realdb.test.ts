/**
 * ISS-8422 real-Postgres proof that an UNOBSERVED pull request reads the same
 * way everywhere.
 *
 * `pull_request_detail.pr_state` is NOT NULL with a `@default(OPEN)`, so a row
 * nobody measured still reads Open. These cases pin the three readers that must
 * agree about such a row — cloud eligibility, the rendered branch row, and the
 * status filters and totals — because a disagreement between any two of them is
 * a branch whose card contradicts the list it was found in.
 */
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { branchReadService } from "@/app/branches/branch-read-service";
import {
  hiddenState,
  initialObservedAt,
  newestObservedAt,
  pointBranchAtPullRequest,
  providerRepositoryId,
  readVisibility,
  repositoryFullName,
  seedBranches,
  seedFactlessCurrentPullRequest,
  seedHistoricalMergedPullRequest,
  seedOrganization,
  setArtifactStatus,
  setAvailableAuthority,
  setPullRequestAuthorityGroup,
  setPullRequestHeadRepository,
  visibleState,
} from "../support/branches/cloud-eligibility-realdb.test-helpers";
import { createCommittedTestOrganizationTracker } from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(async () => {
  await committedOrganizations.cleanup();
});

describe.skipIf(!hasDatabase)(
  "ISS-8422 unobserved pull requests (real Postgres)",
  () => {
    it("admits a branch whose current pull request observed nothing", async () => {
      const organization = await seedOrganization(
        committedOrganizations,
        "unobserved-pr"
      );
      const branchName = "feature/unobserved-pr";
      const branchId =
        (await seedBranches(organization, [branchName])).get(branchName) ?? "";
      // Installation authority is the branch's authority throughout, and it is
      // the NEWEST observation in every leg below. That is what isolates the
      // current-PR arm: no other HAVING conjunct can be the reason for a
      // hidden verdict here.
      await setAvailableAuthority(
        organization.repositoryId,
        "main",
        newestObservedAt
      );
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(visibleState(branchId));

      // The desktop lane writes exactly this row the moment a PR is opened —
      // server-derived identity and not one observed fact. Before the split it
      // deleted the branch from the list, the count and the cohort.
      const factlessPullRequestId = await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "unobserved"
      );
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(visibleState(branchId));

      // ISS-5827 unchanged: once the PR DOES carry head-repository authority,
      // it must name the branch's repository. Observed OLDER than the
      // installation row, so `latest_authorities` still resolves to the
      // matching installation identity and the current-PR arm is the only
      // conjunct that can fail.
      await setPullRequestAuthorityGroup(factlessPullRequestId, {
        repositoryFullName: "different-owner/cloud-eligibility",
        providerRepositoryId,
        observedAt: initialObservedAt,
      });
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(hiddenState);

      await setPullRequestAuthorityGroup(factlessPullRequestId, {
        repositoryFullName,
        providerRepositoryId,
        observedAt: initialObservedAt,
      });
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(visibleState(branchId));
    }, 25_000);

    it("agrees with the status filter when two unwitnessed open PRs are ambiguous", async () => {
      const organization = await seedOrganization(
        committedOrganizations,
        "ambiguous-unobserved"
      );
      const branchName = "feature/ambiguous-unobserved";
      const branchId =
        (await seedBranches(organization, [branchName])).get(branchName) ?? "";
      await setAvailableAuthority(
        organization.repositoryId,
        "main",
        newestObservedAt
      );
      await seedHistoricalMergedPullRequest(organization, branchId);
      await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "amb-one",
        8422
      );
      await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "amb-two",
        8423
      );

      // The TS selector records MultipleActive for two unwitnessed opens and
      // selects NOTHING, so the row shows no PR and derives Open. The in-DB
      // twin has to reach the same verdict: without the ambiguity gate it
      // still resolves the historical merged row, and this branch appears
      // under a Merged filter while its row renders Open (whitlockk on #6313).
      const detail = await branchReadService.getBranchDetail(
        organization.organizationId,
        branchId
      );
      expect(detail?.prState).toBeNull();
      expect(detail?.associatedPullRequests?.selectedId).toBeNull();
      expect(detail?.status).toBe(BranchStatus.Open);

      const merged = await branchReadService.listBranches(
        organization.organizationId,
        { limit: 10, offset: 0, status: [BranchStatus.Merged] }
      );
      expect(merged.items.map(({ id }) => id)).not.toContain(branchId);

      const open = await branchReadService.listBranches(
        organization.organizationId,
        { limit: 10, offset: 0, status: [BranchStatus.Open] }
      );
      expect(open.items.map(({ id }) => id)).toContain(branchId);
    }, 25_000);

    it("keeps a merged artifact's row and its status filters in step when its only PR is factless", async () => {
      const organization = await seedOrganization(
        committedOrganizations,
        "merged-unobserved"
      );
      const branchName = "feature/merged-unobserved";
      const branchId =
        (await seedBranches(organization, [branchName])).get(branchName) ?? "";
      await setAvailableAuthority(
        organization.repositoryId,
        "main",
        newestObservedAt
      );
      await setArtifactStatus(branchId, GitHubPRState.Merged);
      await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "merged-unobserved"
      );

      // The PR observed nothing, so the row falls back to the artifact and
      // renders Merged. The status filters have to read the same OBSERVED
      // selection the projection does: keying them on the bare selection put
      // this branch under Open and dropped it from Merged, while its own card
      // said Merged (davetho on #6313).
      const detail = await branchReadService.getBranchDetail(
        organization.organizationId,
        branchId
      );
      expect(detail?.prState).toBeNull();
      expect(detail?.status).toBe(BranchStatus.Merged);

      const merged = await branchReadService.listBranches(
        organization.organizationId,
        { limit: 10, offset: 0, status: [BranchStatus.Merged] }
      );
      expect(merged.items.map(({ id }) => id)).toContain(branchId);

      const open = await branchReadService.listBranches(
        organization.organizationId,
        { limit: 10, offset: 0, status: [BranchStatus.Open] }
      );
      expect(open.items.map(({ id }) => id)).not.toContain(branchId);
    }, 25_000);

    it("still ranks a terminal PR when one unwitnessed PR was written twice", async () => {
      const organization = await seedOrganization(
        committedOrganizations,
        "duplicate-unobserved"
      );
      const branchName = "feature/duplicate-unobserved";
      const branchId =
        (await seedBranches(organization, [branchName])).get(branchName) ?? "";
      await setAvailableAuthority(
        organization.repositoryId,
        "main",
        newestObservedAt
      );
      await seedHistoricalMergedPullRequest(organization, branchId);
      // ONE pull request, written twice: the desktop lane's row carries no
      // repository id, the cloud lane's does, and both normalize to the same
      // canonical identity. The TS selector merges them into a single
      // unwitnessed candidate and goes on to rank the terminal row.
      await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "dup-with-repo-id",
        8422
      );
      await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "dup-without-repo-id",
        8422,
        { withRepositoryId: false }
      );

      // Counting raw rows in the ambiguity gate made SQL see two ambiguous
      // opens where the selector saw one, so it withheld every selected-PR
      // predicate and this branch vanished from a Merged filter its own row
      // satisfies (davetho on #6313).
      const detail = await branchReadService.getBranchDetail(
        organization.organizationId,
        branchId
      );
      expect(detail?.prState).toBe(GitHubPRState.Merged);

      const merged = await branchReadService.listBranches(
        organization.organizationId,
        { limit: 10, offset: 0, status: [BranchStatus.Merged] }
      );
      expect(merged.items.map(({ id }) => id)).toContain(branchId);
    }, 25_000);

    it("refuses a current pull request whose head repository contradicts the branch", async () => {
      const organization = await seedOrganization(
        committedOrganizations,
        "foreign-head"
      );
      const branchName = "feature/foreign-head";
      const branchId =
        (await seedBranches(organization, [branchName])).get(branchName) ?? "";
      await setAvailableAuthority(
        organization.repositoryId,
        "main",
        newestObservedAt
      );
      const pullRequestId = await seedFactlessCurrentPullRequest(
        organization,
        branchId,
        "foreign-head"
      );
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(visibleState(branchId));

      // Head identity is provider evidence in its own right, so an EMPTY
      // authority group does not make this row unobserved. A fork PR names a
      // head repository the branch does not own, and admitting it would let the
      // branch answer with the BASE repository's default branch — the ISS-5827
      // substitution the observed-nothing fallback must not reopen
      // (davetho on #6313).
      await setPullRequestHeadRepository(
        pullRequestId,
        "different-owner/cloud-eligibility"
      );
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(hiddenState);

      // Identity that AGREES is not something to refuse: the fallback still
      // admits it, or every branch whose PR names its own repository goes dark.
      await setPullRequestHeadRepository(pullRequestId, repositoryFullName);
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual(visibleState(branchId));
    }, 25_000);

    it("refuses a current pointer at a factless row owned by another branch", async () => {
      const organization = await seedOrganization(
        committedOrganizations,
        "foreign-pointer"
      );
      const branchName = "feature/foreign-pointer";
      const otherBranchName = "feature/foreign-pointer-owner";
      const branchIds = await seedBranches(organization, [
        branchName,
        otherBranchName,
      ]);
      const branchId = branchIds.get(branchName) ?? "";
      const otherBranchId = branchIds.get(otherBranchName) ?? "";
      await setAvailableAuthority(
        organization.repositoryId,
        "main",
        newestObservedAt
      );

      const foreignPullRequestId = await seedFactlessCurrentPullRequest(
        organization,
        otherBranchId,
        "foreign"
      );
      await pointBranchAtPullRequest(branchId, foreignPullRequestId);

      // Splitting presence from identity would newly admit this row, because a
      // factless PR trips the "observed nothing" arm whichever branch owns it.
      // The pointer-integrity conjunct is what keeps it closed. The owning
      // branch stays visible — it is the pointer that is wrong, not the row.
      await expect(
        readVisibility(organization.organizationId, branchId)
      ).resolves.toEqual({
        ids: [otherBranchId],
        total: 1,
        detailId: null,
      });
    }, 25_000);
  }
);
