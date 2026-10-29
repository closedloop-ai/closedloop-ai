import { randomUUID } from "node:crypto";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import { RepositoryIdentitySource } from "./authority-source-queries";
import { persistSessionBranchArtifactLinks } from "./branch-links";

/**
 * ISS-8070 case 1 (column-backed). `artifact_links.branch_participation_method`
 * was `VARCHAR(200)`, exactly matching the branch-ref `method` wire `.max(200)`.
 * Dropping the wire bound alone would have moved the rejection into Postgres as
 * a 22001 mid-transaction, so the migration widening the column to TEXT lands in
 * the same change.
 *
 * This drives the REAL write path — `persistSessionBranchArtifactLinks` →
 * `branchParticipationWriteData` → `artifactLink.upsert` — and asserts the value
 * reads back BYTE-IDENTICAL, not merely that nothing threw.
 */

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
/** Past the retired VARCHAR(200) bound, and not adjacent to it. */
const METHOD_CHARS_PAST_RETIRED_BOUND = 900;

describeIfDb(
  "artifact_links.branch_participation_method width (ISS-8070, real Postgres)",
  () => {
    it("persists a method past the retired 200-char column bound, byte-identical", async () => {
      const method = buildLongMethod();
      // Assert the property this fixture is assumed to have rather than trust
      // it — a fixture that drifted under 200 would be a false green.
      expect(method.length).toBeGreaterThan(200);

      const fixture = await seedFixture();

      await withDb.tx((tx) =>
        persistSessionBranchArtifactLinks(
          tx,
          fixture.organizationId,
          null,
          fixture.sessionArtifactId,
          [
            {
              kind: ArtifactRefTargetKind.Branch,
              repositoryFullName: REPOSITORY_FULL_NAME,
              branchName: fixture.branchName,
              method,
              relation: ArtifactRefRelation.Output,
              branchParticipation: BranchParticipationKind.Wrote,
            },
          ],
          fixture.authority
        )
      );

      const stored = await readBranchParticipationMethod(
        fixture.organizationId,
        fixture.sessionArtifactId
      );

      // Byte-identical, not "no error": length AND content, both directions.
      expect(stored).toHaveLength(METHOD_CHARS_PAST_RETIRED_BOUND);
      expect(stored).toBe(method);
    });

    it("still persists a short method unchanged (positive sibling)", async () => {
      const method = "git_push";
      const fixture = await seedFixture();

      await withDb.tx((tx) =>
        persistSessionBranchArtifactLinks(
          tx,
          fixture.organizationId,
          null,
          fixture.sessionArtifactId,
          [
            {
              kind: ArtifactRefTargetKind.Branch,
              repositoryFullName: REPOSITORY_FULL_NAME,
              branchName: fixture.branchName,
              method,
              relation: ArtifactRefRelation.Output,
              branchParticipation: BranchParticipationKind.Wrote,
            },
          ],
          fixture.authority
        )
      );

      expect(
        await readBranchParticipationMethod(
          fixture.organizationId,
          fixture.sessionArtifactId
        )
      ).toBe(method);
    });
  }
);

function buildLongMethod(): string {
  return `gh_pr_create_${"m".repeat(METHOD_CHARS_PAST_RETIRED_BOUND - "gh_pr_create_".length)}`;
}

function readBranchParticipationMethod(
  organizationId: string,
  sessionArtifactId: string
): Promise<string | null> {
  return withDb(async (db) => {
    const link = await db.artifactLink.findFirst({
      where: { organizationId, sourceId: sessionArtifactId },
      select: { branchParticipationMethod: true },
    });
    return link?.branchParticipationMethod ?? null;
  });
}

async function seedRepository(organizationId: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        accountId: `account-${suffix}`,
        accountLogin: "closedloop-ai",
        accountType: "Organization",
        installationId: `installation-${suffix}`,
        organizationId,
        senderId: `sender-${suffix}`,
        senderLogin: "sender",
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    })
  );
  return withDb((db) =>
    db.gitHubInstallationRepository.create({
      data: {
        fullName: REPOSITORY_FULL_NAME,
        githubRepoId: `repository-${suffix}`,
        installationId: installation.id,
        name: "closedloop-ai",
        owner: "closedloop-ai",
        private: true,
      },
      select: { id: true },
    })
  );
}

async function seedFixture() {
  const organizationId = await createTestOrganization();
  const repository = await seedRepository(organizationId);
  const providerRepositoryId = `provider-${randomUUID().slice(0, 8)}`;
  const branchName = `feature/iss8070-${randomUUID()}`;
  const sessionArtifactId = await withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "session-iss8070",
        status: SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    return session.id;
  });
  const branchArtifactId = await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryId: repository.id,
        repositoryFullName: REPOSITORY_FULL_NAME,
        branchName,
      },
      select: { artifactId: true },
    });
    return branch.id;
  });

  const authority = new Map([
    [
      REPOSITORY_FULL_NAME,
      {
        repositoryId: repository.id,
        providerRepositoryId,
        identitySources: new Set([RepositoryIdentitySource.Installation]),
        authorities: [
          {
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId,
              fullName: REPOSITORY_FULL_NAME,
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Available,
              completeness: RepositoryDefaultCompleteness.Complete,
              defaultBranch: "main",
            },
            provenance: {
              source: RepositoryDefaultSource.RepositoryRest,
              mechanism: GitHubFetchMechanism.Rest,
              trigger: GitHubFetchTrigger.UserAction,
              credentialType: GitHubFetchCredentialType.UserOAuth,
              observationKey: "iss8070-method-width",
              observedAt: "2026-08-26T09:00:00.000Z",
            },
          },
        ],
      },
    ],
  ]);

  return {
    organizationId,
    sessionArtifactId,
    branchArtifactId,
    branchName,
    authority,
  };
}
