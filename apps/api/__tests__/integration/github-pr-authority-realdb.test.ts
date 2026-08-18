import { randomUUID } from "node:crypto";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistPullRequestHeadRepositoryAuthority } from "@/app/branches/pull-request-head-authority";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizationA = randomUUID();
const organizationB = randomUUID();

describe.skipIf(!hasDatabase)(
  "ISS-5826 pull-request head authority (real Postgres)",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.createMany({
          data: [organizationA, organizationB].map((id, index) => ({
            id,
            clerkId: `iss5826-clerk-${index}-${id}`,
            name: `ISS-5826 Org ${index}`,
            slug: `iss5826-${index}-${id}`,
          })),
        });
      });
    });

    afterAll(async () => {
      await withDb(async (db) => {
        await db.repositoryDefaultObservationReceipt.deleteMany({
          where: { organizationId: { in: [organizationA, organizationB] } },
        });
        await db.artifact.deleteMany({
          where: { organizationId: { in: [organizationA, organizationB] } },
        });
        await db.organization.deleteMany({
          where: { id: { in: [organizationA, organizationB] } },
        });
      });
    });

    it("persists fork identity, deduplicates replay, advances freshness, and stays org-scoped", async () => {
      const runId = randomUUID();
      const pullRequestA = await withDb((db) =>
        createPullRequest(db, organizationA, `a-${runId}`)
      );
      const pullRequestB = await withDb((db) =>
        createPullRequest(db, organizationB, `b-${runId}`)
      );
      await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationA, pullRequestDetailId: pullRequestA },
          observation("attempt-1", "2026-08-10T10:00:00.000Z")
        )
      );
      const first = await readPullRequest(pullRequestA);
      expect(first).toMatchObject({
        headRepositoryGithubId: "5826",
        headRepositoryFullName: "fork-owner/same-short-name",
        headRepositoryDefaultBranchName: "trunk",
        headRepositoryDefaultBranchObservationKey: "attempt-1",
      });

      const replayChanged = await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationA, pullRequestDetailId: pullRequestA },
          observation("attempt-1", "2026-08-10T10:05:00.000Z")
        )
      );
      expect(replayChanged).toBe(false);
      expect(await readPullRequest(pullRequestA)).toEqual(first);

      await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationA, pullRequestDetailId: pullRequestA },
          observation("attempt-2", "2026-08-10T11:00:00.000Z")
        )
      );
      expect(await readPullRequest(pullRequestA)).toMatchObject({
        headRepositoryDefaultBranchObservationKey: "attempt-2",
        headRepositoryDefaultBranchObservedAt: new Date(
          "2026-08-10T11:00:00.000Z"
        ),
      });

      const crossOrgChanged = await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationB, pullRequestDetailId: pullRequestA },
          observation("cross-org", "2026-08-10T12:00:00.000Z")
        )
      );
      expect(crossOrgChanged).toBe(false);
      expect(await readPullRequest(pullRequestB)).toMatchObject({
        headRepositoryFullName: null,
        headRepositoryDefaultBranchObservationKey: null,
      });
    });

    it("rejects an older observation and preserves legacy omission", async () => {
      const runId = randomUUID();
      const pullRequestA = await withDb((db) =>
        createPullRequest(db, organizationA, `stale-${runId}`)
      );
      const pullRequestB = await withDb((db) =>
        createPullRequest(db, organizationB, `legacy-${runId}`)
      );
      await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationA, pullRequestDetailId: pullRequestA },
          observation("attempt-current", "2026-08-10T11:00:00.000Z")
        )
      );
      const before = await readPullRequest(pullRequestA);
      const staleChanged = await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationA, pullRequestDetailId: pullRequestA },
          observation("attempt-old", "2026-08-10T09:00:00.000Z")
        )
      );
      expect(staleChanged).toBe(false);
      expect(await readPullRequest(pullRequestA)).toEqual(before);

      const omittedChanged = await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          { organizationId: organizationB, pullRequestDetailId: pullRequestB },
          undefined
        )
      );
      expect(omittedChanged).toBe(false);
      expect(await readPullRequest(pullRequestB)).toMatchObject({
        headRepositoryGithubId: null,
        headRepositoryDefaultBranchAvailability: null,
      });
    });

    it("durably rejects a non-consecutive D1/D2/D1 webhook replay", async () => {
      const pullRequestReplay = await withDb((db) =>
        createPullRequest(db, organizationA, `replay-${randomUUID()}`)
      );
      await withDb.tx((tx) =>
        persistPullRequestHeadRepositoryAuthority(
          tx,
          {
            organizationId: organizationA,
            pullRequestDetailId: pullRequestReplay,
          },
          webhookObservation("delivery-d1", "2026-08-10T10:00:00.000Z", "one")
        )
      );
      await withDb.tx((tx) =>
        persistPullRequestHeadRepositoryAuthority(
          tx,
          {
            organizationId: organizationA,
            pullRequestDetailId: pullRequestReplay,
          },
          webhookObservation("delivery-d2", "2026-08-10T11:00:00.000Z", "two")
        )
      );
      const afterD2 = await readPullRequest(pullRequestReplay);

      const replayChanged = await withDb.tx((tx) =>
        persistPullRequestHeadRepositoryAuthority(
          tx,
          {
            organizationId: organizationA,
            pullRequestDetailId: pullRequestReplay,
          },
          webhookObservation("delivery-d1", "2026-08-10T12:00:00.000Z", "one")
        )
      );

      expect(replayChanged).toBe(false);
      expect(await readPullRequest(pullRequestReplay)).toEqual(afterD2);
      expect(afterD2).toMatchObject({
        headRepositoryDefaultBranchName: "two",
        headRepositoryDefaultBranchObservationKey: "delivery-d2",
      });
    });

    it("rejects a delayed webhook with an older provider event time", async () => {
      const pullRequest = await withDb((db) =>
        createPullRequest(db, organizationA, `event-order-${randomUUID()}`)
      );
      await withDb.tx((tx) =>
        persistPullRequestHeadRepositoryAuthority(
          tx,
          { organizationId: organizationA, pullRequestDetailId: pullRequest },
          webhookObservation(
            "delivery-new-event",
            "2026-08-10T10:00:00.000Z",
            "trunk",
            "2026-08-10T09:00:00.000Z"
          )
        )
      );
      const before = await readPullRequest(pullRequest);

      const changed = await withDb.tx((tx) =>
        persistPullRequestHeadRepositoryAuthority(
          tx,
          { organizationId: organizationA, pullRequestDetailId: pullRequest },
          webhookObservation(
            "delivery-old-event",
            "2026-08-10T12:00:00.000Z",
            "main",
            "2026-08-10T08:00:00.000Z"
          )
        )
      );

      expect(changed).toBe(false);
      expect(await readPullRequest(pullRequest)).toEqual(before);
    });

    it("keeps an equal-time valid-value conflict sticky", async () => {
      const pullRequestConflict = await withDb((db) =>
        createPullRequest(db, organizationA, `conflict-${randomUUID()}`)
      );
      const observedAt = "2026-08-10T13:00:00.000Z";
      await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          {
            organizationId: organizationA,
            pullRequestDetailId: pullRequestConflict,
          },
          observation("attempt-a", observedAt, "alpha")
        )
      );
      await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          {
            organizationId: organizationA,
            pullRequestDetailId: pullRequestConflict,
          },
          observation("attempt-b", observedAt, "beta")
        )
      );
      const conflict = await readPullRequest(pullRequestConflict);
      expect(conflict).toMatchObject({
        headRepositoryDefaultBranchName: null,
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Unavailable,
        headRepositoryDefaultBranchReason: "conflicting",
      });

      await withDb((db) =>
        persistPullRequestHeadRepositoryAuthority(
          db,
          {
            organizationId: organizationA,
            pullRequestDetailId: pullRequestConflict,
          },
          observation("attempt-c", observedAt, "alpha")
        )
      );
      expect(await readPullRequest(pullRequestConflict)).toEqual(conflict);
    });
  }
);

function observation(
  observationKey: string,
  observedAt: string,
  defaultBranch = "trunk"
) {
  return {
    authority: repositoryDefaultAuthorityValidator.parse({
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "5826",
        fullName: "fork-owner/same-short-name",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch,
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey,
        observedAt,
      },
    }),
  };
}

function webhookObservation(
  observationKey: string,
  observedAt: string,
  defaultBranch: string,
  eventAt?: string
) {
  const result = observation(observationKey, observedAt, defaultBranch);
  if (result.authority) {
    result.authority.provenance.source =
      RepositoryDefaultSource.PullRequestWebhook;
    result.authority.provenance.mechanism = GitHubFetchMechanism.Webhook;
    result.authority.provenance.trigger = GitHubFetchTrigger.Webhook;
    if (eventAt) {
      result.authority.provenance.eventAt = eventAt;
    }
  }
  return result;
}

function readPullRequest(id: string) {
  return withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({ where: { id } })
  );
}

async function createPullRequest(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  suffix: string
): Promise<string> {
  const artifact = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.BRANCH,
      name: `iss5826-${suffix}`,
      status: GitHubPRState.Open,
      branch: {
        create: {
          organizationId,
          repositoryFullName: `base-owner-${suffix}/same-short-name`,
          branchName: `feature-${suffix}`,
        },
      },
      pullRequestDetails: {
        create: {
          organizationId,
          githubId: `iss5826-pr-${suffix}-${randomUUID()}`,
          number: 5826,
          title: "ISS-5826",
          htmlUrl: `https://github.com/base-owner-${suffix}/same-short-name/pull/5826`,
          prState: GitHubPRState.Open,
        },
      },
    },
    select: { pullRequestDetails: { select: { id: true } } },
  });
  const id = artifact.pullRequestDetails[0]?.id;
  if (!id) {
    throw new Error("failed to seed PullRequestDetail");
  }
  return id;
}
