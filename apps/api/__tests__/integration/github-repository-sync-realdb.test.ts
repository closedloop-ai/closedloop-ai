/**
 * ISS-4618 real-Postgres proof for the bulk installation-repository upsert.
 *
 * `syncRepositories`/`addRepositories` — and, as of ISS-4619, the OAuth
 * reconnect path (`completeOAuthCallback` reconnect branch) — all route through
 * the shared `bulkUpsertInstallationRepositories` helper: it replaced a per-row
 * `Promise.all(upsert)` loop with one chunked set-based `INSERT ... ON CONFLICT`
 * (so a large webhook / OAuth batch stays a bounded number of round trips
 * instead of N, and can't P2028-time-out inside the 5s interactive-tx window).
 * The mocked unit tests only prove `$executeRaw` ran; this drives it against a
 * REAL Postgres and asserts the STORED rows: insert values, conflict-update with
 * ID stability, tombstone, tombstone-clear (PLN-634), and intra-batch dedupe of a
 * repeated githubRepoId (ISS-4619 — a raw multi-row ON CONFLICT errors on a
 * duplicate conflict key, so the reconnect list MUST be deduped before upsert).
 *
 * Skipped without a DATABASE_URL; runs in CI's api-integration-tests tier.
 */
import { randomUUID } from "node:crypto";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshExistingPublicRepositoryAuthority } from "../../app/integrations/github/public-repositories/authority-persistence";
import { githubService } from "../../app/integrations/github/service";
import { persistIncompleteInstallationRepositoryObservation } from "../../app/integrations/github/service/incomplete-repository-observation";
import { REPO_UPSERT_CHUNK_SIZE } from "../../app/integrations/github/service/repository-sync";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// Unique per run so parallel/leftover data can never collide.
const ORG_ID = randomUUID();
const INSTALLATION_ID = randomUUID();
const GH_INSTALLATION_ID = `iss4618-${randomUUID()}`;
const OTHER_ORG_ID = randomUUID();
const OTHER_INSTALLATION_ID = randomUUID();

function repo(githubRepoId: string, fullName: string, isPrivate: boolean) {
  const name = fullName.split("/")[1] ?? fullName;
  return { githubRepoId, fullName, name, owner: "acme", private: isPrivate };
}

function repoWithAuthority(
  githubRepoId: string,
  branch: string | null,
  observationKey: string,
  observedAt: string,
  reason = RepositoryDefaultReason.ProviderError
) {
  const fullName = `acme/${githubRepoId}`;
  const evidence: RepositoryDefaultAuthority["evidence"] = branch
    ? {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch: branch,
      }
    : {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason,
      };
  return {
    ...repo(githubRepoId, fullName, false),
    defaultAuthority: {
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: githubRepoId,
        fullName,
      },
      evidence,
      provenance: {
        source: RepositoryDefaultSource.InstallationRepositoriesRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey,
        observedAt,
      },
    } satisfies RepositoryDefaultAuthority,
  };
}

describe.skipIf(!hasDatabase)(
  "ISS-4618 installation-repository bulk upsert (real Postgres)",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_${ORG_ID}`,
            name: "ISS-4618 Repo Sync Org",
            slug: `iss4618-${ORG_ID}`,
          },
        });
        await db.gitHubInstallation.create({
          data: {
            id: INSTALLATION_ID,
            organizationId: ORG_ID,
            installationId: GH_INSTALLATION_ID,
            accountId: "acct-1",
            accountLogin: "acme",
            accountType: "Organization",
            senderLogin: "sender",
            senderId: "sender-1",
            status: GitHubInstallationStatus.ACTIVE,
          },
        });
        await db.organization.create({
          data: {
            id: OTHER_ORG_ID,
            clerkId: `clerk_${OTHER_ORG_ID}`,
            name: "ISS-5826 Isolated Repo Sync Org",
            slug: `iss5826-${OTHER_ORG_ID}`,
          },
        });
        await db.gitHubInstallation.create({
          data: {
            id: OTHER_INSTALLATION_ID,
            organizationId: OTHER_ORG_ID,
            installationId: `iss5826-${randomUUID()}`,
            accountId: "acct-2",
            accountLogin: "other-acme",
            accountType: "Organization",
            senderLogin: "sender",
            senderId: "sender-2",
            status: GitHubInstallationStatus.ACTIVE,
          },
        });
      });
    });

    afterAll(async () => {
      await withDb(async (db) => {
        await db.gitHubInstallationRepository.deleteMany({
          where: {
            installationId: { in: [INSTALLATION_ID, OTHER_INSTALLATION_ID] },
          },
        });
        await db.gitHubInstallation.deleteMany({
          where: { id: { in: [INSTALLATION_ID, OTHER_INSTALLATION_ID] } },
        });
        await db.organization.deleteMany({
          where: { id: { in: [ORG_ID, OTHER_ORG_ID] } },
        });
      });
    });

    const findRepos = () =>
      withDb((db) =>
        db.gitHubInstallationRepository.findMany({
          where: { installationId: INSTALLATION_ID },
          orderBy: { githubRepoId: "asc" },
        })
      );

    it("inserts, conflict-updates with a stable id, tombstones, and revives", async () => {
      // 1. INSERT: two brand-new repos through the set-based upsert.
      await githubService.syncRepositories(INSTALLATION_ID, [
        repo("r-1", "acme/one", false),
        repo("r-2", "acme/two", true),
      ]);
      const afterInsert = await findRepos();
      expect(afterInsert.map((r) => r.githubRepoId)).toEqual(["r-1", "r-2"]);
      const insertedTwo = afterInsert.find((r) => r.githubRepoId === "r-2");
      expect(insertedTwo?.private).toBe(true);
      const oneIdAfterInsert = afterInsert.find(
        (r) => r.githubRepoId === "r-1"
      )?.id;
      expect(oneIdAfterInsert).toBeTruthy();

      // 2. CONFLICT-UPDATE + TOMBSTONE: re-sync with r-1 renamed and r-2 dropped.
      //    r-1 updates in place (same row id); r-2 gets a removed_at tombstone.
      await githubService.syncRepositories(INSTALLATION_ID, [
        repo("r-1", "acme/one-renamed", false),
      ]);
      const afterResync = await findRepos();
      const one = afterResync.find((r) => r.githubRepoId === "r-1");
      const two = afterResync.find((r) => r.githubRepoId === "r-2");
      expect(one?.fullName).toBe("acme/one-renamed");
      expect(one?.id).toBe(oneIdAfterInsert);
      expect(one?.removedAt).toBeNull();
      expect(two?.removedAt).not.toBeNull();
      const twoIdAfterTombstone = two?.id;

      // 3. REVIVE: re-add r-2 — its tombstone clears and the SAME row is reused.
      await githubService.syncRepositories(INSTALLATION_ID, [
        repo("r-1", "acme/one-renamed", false),
        repo("r-2", "acme/two", true),
      ]);
      const revived = await withDb((db) =>
        db.gitHubInstallationRepository.findFirst({
          where: { installationId: INSTALLATION_ID, githubRepoId: "r-2" },
        })
      );
      expect(revived?.removedAt).toBeNull();
      expect(revived?.id).toBe(twoIdAfterTombstone);
    });

    it("dedupes a githubRepoId repeated within one batch (ISS-4619 reconnect)", async () => {
      // A fetched page set — the exact input the OAuth reconnect passes straight
      // to the helper — can list the same repo twice. A single multi-row
      // INSERT ... ON CONFLICT with two rows sharing the conflict key errors:
      // "ON CONFLICT DO UPDATE command cannot affect row a second time". The
      // helper must collapse duplicates by githubRepoId (last wins) BEFORE the
      // statement, so this neither throws nor writes two rows. The inline
      // reconnect upsert this replaced lacked that dedupe.
      await expect(
        githubService.syncRepositories(INSTALLATION_ID, [
          repo("dup-1", "acme/dup-old", false),
          repo("dup-1", "acme/dup-new", true),
        ])
      ).resolves.not.toThrow();

      const dupRows = await withDb((db) =>
        db.gitHubInstallationRepository.findMany({
          where: { installationId: INSTALLATION_ID, githubRepoId: "dup-1" },
        })
      );
      expect(dupRows).toHaveLength(1);
      // Last occurrence wins the merge.
      expect(dupRows[0]?.fullName).toBe("acme/dup-new");
      expect(dupRows[0]?.private).toBe(true);
    });

    it("orders authority, makes exact replay a no-op, retains known values, and detects equal-time conflict", async () => {
      // Datadog Early Flake Detection may repeat this test in the same process.
      // Use invocation-scoped repository IDs so each repetition starts from a
      // legacy-null row instead of inheriting the prior repetition's watermark.
      const runId = randomUUID();
      const authorityRepoId = `authority-${runId}`;
      const conflictRepoId = `authority-conflict-${runId}`;
      const batchRepoId = `authority-batch-poorer-${runId}`;
      const first = repoWithAuthority(
        authorityRepoId,
        "main",
        "attempt-1",
        "2026-08-10T10:00:00.000Z"
      );
      await githubService.addRepositories(INSTALLATION_ID, [first]);
      const afterFirst = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: {
            installationId_githubRepoId: {
              installationId: INSTALLATION_ID,
              githubRepoId: authorityRepoId,
            },
          },
        })
      );

      await githubService.addRepositories(INSTALLATION_ID, [first]);
      const afterReplay = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: { id: afterFirst.id },
        })
      );
      expect(afterReplay.updatedAt).toEqual(afterFirst.updatedAt);
      expect(afterReplay.defaultBranchObservationKey).toBe("attempt-1");

      await githubService.addRepositories(INSTALLATION_ID, [
        {
          ...first,
          fullName: "acme/same-key-drift",
          name: "same-key-drift",
          private: true,
        },
      ]);
      const afterSameKeyDrift = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: { id: afterFirst.id },
        })
      );
      expect(afterSameKeyDrift.fullName).toBe(first.fullName);
      expect(afterSameKeyDrift.private).toBe(first.private);
      expect(afterSameKeyDrift.updatedAt).toEqual(afterFirst.updatedAt);

      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          authorityRepoId,
          "main",
          "attempt-2",
          "2026-08-10T11:00:00.000Z"
        ),
      ]);
      const afterRefresh = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: { id: afterFirst.id },
        })
      );
      expect(afterRefresh.defaultBranchObservationKey).toBe("attempt-2");
      expect(afterRefresh.defaultBranchObservedAt?.toISOString()).toBe(
        "2026-08-10T11:00:00.000Z"
      );

      const staleRename = repoWithAuthority(
        authorityRepoId,
        "old-default",
        "attempt-old",
        "2026-08-10T09:00:00.000Z"
      );
      staleRename.fullName = "acme/stale-rename";
      staleRename.name = "stale-rename";
      await githubService.addRepositories(INSTALLATION_ID, [staleRename]);
      const afterStale = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: { id: afterFirst.id },
        })
      );
      expect(afterStale.defaultBranchName).toBe("main");
      expect(afterStale.defaultBranchObservationKey).toBe("attempt-2");
      expect(afterStale.fullName).toBe(first.fullName);
      expect(afterStale.updatedAt).toEqual(afterRefresh.updatedAt);

      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          authorityRepoId,
          null,
          "attempt-3",
          "2026-08-10T12:00:00.000Z"
        ),
      ]);
      const retained = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: { id: afterFirst.id },
        })
      );
      expect(retained.defaultBranchName).toBe("main");
      expect(retained.defaultBranchAvailability).toBe(
        RepositoryDefaultAvailability.Stale
      );
      expect(retained.defaultBranchReason).toBe(
        RepositoryDefaultReason.ProviderError
      );

      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          conflictRepoId,
          "main",
          "conflict-a",
          "2026-08-10T13:00:00.000Z"
        ),
      ]);
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          conflictRepoId,
          "trunk",
          "conflict-b",
          "2026-08-10T13:00:00.000Z"
        ),
      ]);
      const conflict = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: {
            installationId_githubRepoId: {
              installationId: INSTALLATION_ID,
              githubRepoId: conflictRepoId,
            },
          },
        })
      );
      expect(conflict.defaultBranchName).toBeNull();
      expect(conflict.defaultBranchAvailability).toBe(
        RepositoryDefaultAvailability.Unavailable
      );
      expect(conflict.defaultBranchReason).toBe(
        RepositoryDefaultReason.Conflicting
      );
      const conflictUpdatedAt = conflict.updatedAt;
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          conflictRepoId,
          "main",
          "conflict-a",
          "2026-08-10T13:00:00.000Z"
        ),
      ]);
      const conflictReplay = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: { id: conflict.id },
        })
      );
      expect(conflictReplay.defaultBranchReason).toBe(
        RepositoryDefaultReason.Conflicting
      );
      expect(conflictReplay.updatedAt).toEqual(conflictUpdatedAt);

      const batchAvailable = repoWithAuthority(
        batchRepoId,
        "main",
        "batch-available",
        "2026-08-10T14:00:00.000Z"
      );
      const batchPoorer = repoWithAuthority(
        batchRepoId,
        null,
        "batch-poorer",
        "2026-08-10T15:00:00.000Z"
      );
      batchPoorer.fullName = "acme/authority-batch-renamed";
      batchPoorer.name = "authority-batch-renamed";
      await githubService.addRepositories(INSTALLATION_ID, [
        batchAvailable,
        batchPoorer,
      ]);
      const batchResult = await withDb((db) =>
        db.gitHubInstallationRepository.findUniqueOrThrow({
          where: {
            installationId_githubRepoId: {
              installationId: INSTALLATION_ID,
              githubRepoId: batchRepoId,
            },
          },
        })
      );
      expect(batchResult.fullName).toBe("acme/authority-batch-renamed");
      expect(batchResult.defaultBranchName).toBe("main");
      expect(batchResult.defaultBranchAvailability).toBe(
        RepositoryDefaultAvailability.Stale
      );
    });

    it("atomically reconciles public authority under concurrency and organization isolation", async () => {
      const githubRepoId = `public-${randomUUID()}`;
      const primary = await withDb((db) =>
        db.publicRepository.create({
          data: {
            organizationId: ORG_ID,
            githubRepoId,
            fullName: `acme/${githubRepoId}`,
            owner: "acme",
            name: githubRepoId,
            htmlUrl: `https://github.com/acme/${githubRepoId}`,
          },
        })
      );
      const isolated = await withDb((db) =>
        db.publicRepository.create({
          data: {
            organizationId: OTHER_ORG_ID,
            githubRepoId,
            fullName: `other/${githubRepoId}`,
            owner: "other",
            name: githubRepoId,
            htmlUrl: `https://github.com/other/${githubRepoId}`,
          },
        })
      );
      await Promise.all([
        refreshExistingPublicRepositoryAuthority(
          ORG_ID,
          githubRepoId,
          repoWithAuthority(
            githubRepoId,
            "main",
            "public-a",
            "2026-08-10T16:00:00.000Z"
          ).defaultAuthority
        ),
        refreshExistingPublicRepositoryAuthority(
          ORG_ID,
          githubRepoId,
          repoWithAuthority(
            githubRepoId,
            "trunk",
            "public-b",
            "2026-08-10T16:00:00.000Z"
          ).defaultAuthority
        ),
      ]);

      const [primaryAfter, isolatedAfter] = await withDb((db) =>
        Promise.all([
          db.publicRepository.findUniqueOrThrow({ where: { id: primary.id } }),
          db.publicRepository.findUniqueOrThrow({ where: { id: isolated.id } }),
        ])
      );
      expect(primaryAfter.defaultBranchName).toBeNull();
      expect(primaryAfter.defaultBranchReason).toBe(
        RepositoryDefaultReason.Conflicting
      );
      expect(isolatedAfter.defaultBranchObservedAt).toBeNull();
    });

    it("durably rejects a D1/D2/D1 installation webhook replay", async () => {
      const githubRepoId = `webhook-replay-${randomUUID()}`;
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithWebhookAuthority(
          githubRepoId,
          "main",
          "delivery-1",
          "2026-08-10T10:00:00.000Z"
        ),
      ]);
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithWebhookAuthority(
          githubRepoId,
          "trunk",
          "delivery-2",
          "2026-08-10T11:00:00.000Z"
        ),
      ]);
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithWebhookAuthority(
          githubRepoId,
          "main",
          "delivery-1",
          "2026-08-10T12:00:00.000Z"
        ),
      ]);

      const stored = await withDb((db) =>
        db.gitHubInstallationRepository.findFirstOrThrow({
          where: { installationId: INSTALLATION_ID, githubRepoId },
        })
      );
      expect(stored.defaultBranchName).toBe("trunk");
      expect(stored.defaultBranchObservationKey).toBe("delivery-2");
    });

    it("persists capped partial evidence without tombstoning the unobserved grant", async () => {
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          "partial-returned",
          "main",
          "partial-returned-first",
          "2026-08-10T17:00:00.000Z"
        ),
        repoWithAuthority(
          "partial-missing",
          "trunk",
          "partial-missing-first",
          "2026-08-10T17:00:00.000Z"
        ),
      ]);
      const returned = repoWithAuthority(
        "partial-returned",
        "main",
        "partial-returned-refresh",
        "2026-08-10T18:00:00.000Z"
      );

      await persistIncompleteInstallationRepositoryObservation(
        INSTALLATION_ID,
        [returned],
        {
          reason: RepositoryDefaultReason.Capped,
          provenance: {
            source: RepositoryDefaultSource.InstallationRepositoriesRest,
            mechanism: GitHubFetchMechanism.Rest,
            trigger: GitHubFetchTrigger.UserAction,
            credentialType: GitHubFetchCredentialType.GitHubApp,
            observationKey: "partial-capped-attempt",
            observedAt: "2026-08-10T18:00:00.000Z",
          },
        }
      );

      const rows = await withDb((db) =>
        db.gitHubInstallationRepository.findMany({
          where: {
            installationId: INSTALLATION_ID,
            githubRepoId: { in: ["partial-returned", "partial-missing"] },
          },
          orderBy: { githubRepoId: "asc" },
        })
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.removedAt === null)).toBe(true);
      const missing = rows.find(
        (row) => row.githubRepoId === "partial-missing"
      );
      expect(missing?.defaultBranchName).toBe("trunk");
      expect(missing?.defaultBranchAvailability).toBe(
        RepositoryDefaultAvailability.Stale
      );
      expect(missing?.defaultBranchReason).toBe(RepositoryDefaultReason.Capped);
    });

    it("isolates the same provider repository identity across organizations and installations", async () => {
      await githubService.addRepositories(INSTALLATION_ID, [
        repoWithAuthority(
          "shared-provider-id",
          "main",
          "primary-observation",
          "2026-08-10T14:00:00.000Z"
        ),
      ]);
      await githubService.addRepositories(OTHER_INSTALLATION_ID, [
        repoWithAuthority(
          "shared-provider-id",
          "trunk",
          "other-observation",
          "2026-08-10T15:00:00.000Z"
        ),
      ]);

      const rows = await withDb((db) =>
        db.gitHubInstallationRepository.findMany({
          where: { githubRepoId: "shared-provider-id" },
          orderBy: { installationId: "asc" },
        })
      );
      expect(rows).toHaveLength(2);
      expect(
        rows.find((row) => row.installationId === INSTALLATION_ID)
          ?.defaultBranchName
      ).toBe("main");
      expect(
        rows.find((row) => row.installationId === OTHER_INSTALLATION_ID)
          ?.defaultBranchName
      ).toBe("trunk");
    });

    it("reconciles a grant across configured chunk boundaries against real Postgres (ISS-4619 CR: shafty023)", async () => {
      // shafty023 CR: the mocked unit test proves the helper's chunk LOOP
      // iterates across multiple statements, but with `$executeRaw`
      // mocked it cannot catch a production-scale regression — a chunk that
      // overflows Postgres's 65,535 bind-parameter ceiling, or a batch that
      // trips Prisma's 5s interactive-tx timeout (P2028). Drive a
      // representative large grant through REAL Postgres: REPO_UPSERT_CHUNK_SIZE
      // + 500 unique repos forces the set-based upsert across the configured
      // boundary in two statements; each stays under Postgres's bind ceiling.
      const repoCount = REPO_UPSERT_CHUNK_SIZE + 500;
      const largeGrant = Array.from({ length: repoCount }, (_, index) =>
        repo(`big-${index + 1}`, `acme/big-${index + 1}`, index % 2 === 0)
      );

      const synced = await githubService.syncRepositories(
        INSTALLATION_ID,
        largeGrant
      );

      // syncRepositories returns the installation's non-removed rows. The
      // prior tests' repos are absent from this incoming set, so they are
      // tombstoned — the active set is exactly this grant, proving both
      // chunks were written (not just the first).
      expect(synced).toHaveLength(repoCount);
      const activeCount = await withDb((db) =>
        db.gitHubInstallationRepository.count({
          where: { installationId: INSTALLATION_ID, removedAt: null },
        })
      );
      expect(activeCount).toBe(repoCount);

      // Spot-check a row that falls in the SECOND chunk (index
      // REPO_UPSERT_CHUNK_SIZE, i.e. `big-3001`) to prove the
      // second statement stored its values, not just the first chunk.
      const secondChunkRepoId = `big-${REPO_UPSERT_CHUNK_SIZE + 1}`;
      const pastBoundary = await withDb((db) =>
        db.gitHubInstallationRepository.findFirst({
          where: {
            installationId: INSTALLATION_ID,
            githubRepoId: secondChunkRepoId,
          },
        })
      );
      expect(pastBoundary?.fullName).toBe(`acme/${secondChunkRepoId}`);
      expect(pastBoundary?.removedAt).toBeNull();
    }, 30_000);
  }
);

function repoWithWebhookAuthority(
  githubRepoId: string,
  branch: string,
  observationKey: string,
  observedAt: string
) {
  const repository = repoWithAuthority(
    githubRepoId,
    branch,
    observationKey,
    observedAt
  );
  const defaultAuthority: RepositoryDefaultAuthority = {
    ...repository.defaultAuthority,
    provenance: {
      ...repository.defaultAuthority.provenance,
      source: RepositoryDefaultSource.InstallationWebhook,
      mechanism: GitHubFetchMechanism.Webhook,
      trigger: GitHubFetchTrigger.Webhook,
    },
  };
  return { ...repository, defaultAuthority };
}
