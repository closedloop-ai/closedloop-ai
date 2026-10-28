import { BranchPushSource } from "@repo/api/src/types/artifact";
import type { BranchListResponse } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { DEFAULT_BRANCH_STATUS_ORDERING } from "@repo/api/src/types/branch-status-order";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { BRANCH_OWNER_UNATTRIBUTED_LABEL } from "@repo/lib/branches/branch-list-page";
import { afterEach, describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { readBranchListFailingOpen } from "@/app/branches/branch-list-enrichment";
import type { BranchListOperationQuery } from "@/app/branches/branch-list-query";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { BranchProductReadWorkload } from "@/app/branches/branch-product-read-snapshot";
import {
  type BranchReadClient,
  listServerPageBranches,
} from "@/app/branches/branch-read-service/server-page-list";

/**
 * ISS-10298 (davetho review on #7545, P1) — moving the owner and collaborator
 * identity laterals INTO the required page statement put an OPTIONAL enrichment
 * back on a fatal path. An identity-read timeout used to be caught in the
 * enrichment domain and the list still returned with identity availability
 * degraded; unhandled, the same timeout rejects the page read and `/branches`
 * answers 500 — the ISS-10295 incident shape, reintroduced.
 *
 * The failure here is the REAL one, not a synthetic throw: the identity-bearing
 * statement runs under a 1ms `statement_timeout`, so PostgreSQL cancels it,
 * marks the transaction aborted, and the recovery has to replace the snapshot
 * rather than merely catch. Only the FIRST pass carries the deadline, because
 * the retry's statement no longer contains the laterals — which is also how the
 * interception identifies the pass.
 *
 * The whole point is the DISTINCTION the degraded page has to preserve:
 * `unattributed` with a COMPLETE availability means the branch genuinely has no
 * resolvable owner, and the identical `unattributed` with an UNAVAILABLE
 * availability means nobody could read identity at all. Asserting the option
 * values alone would pass under either, so every case below asserts the option
 * AND the availability beside it.
 *
 * ISS-12463: the Owner is the branch's assignee column, outside the identity
 * failure domain, so it no longer degrades; the Collaborators facet still does.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REPOSITORY = "acme/widgets";
/** The marker that names the identity-bearing pass in the emitted statement. */
const IDENTITY_LATERAL_ALIAS = "branch_owner_identity";

function operationQuery(): BranchListOperationQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: 25,
    offset: 0,
    sortKey: BranchListSortKey.Name,
    sortDir: BranchListSortDirection.Asc,
    evaluationNow: NOW,
  } as BranchListOperationQuery;
}

/**
 * The production composition: the snapshot owner, the failure domain and the
 * server-page read, exactly as `branchReadService` wires them for
 * `pageMode=server`. `expireIdentityStatement` cancels the first pass the way a
 * loaded database does.
 */
function readList(
  organizationId: string,
  expireIdentityStatement: boolean
): Promise<BranchListResponse> {
  return readBranchListFailingOpen(
    organizationId,
    (db, enrichment) =>
      listServerPageBranches(
        expireIdentityStatement ? withIdentityDeadline(db) : db,
        organizationId,
        undefined,
        operationQuery(),
        NOW,
        enrichment,
        DEFAULT_BRANCH_STATUS_ORDERING
      ),
    BranchProductReadWorkload.FullCorpus
  );
}

/**
 * Give only the identity-bearing statement a 1ms deadline. `SET LOCAL` scopes it
 * to the transaction PostgreSQL is about to abort, so nothing leaks into the
 * fresh snapshot the recovery opens.
 */
function withIdentityDeadline<Client extends BranchReadClient>(
  db: Client
): Client {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "$queryRaw" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (query: { sql?: string }, ...rest: unknown[]) => {
        if (query?.sql?.includes(IDENTITY_LATERAL_ALIAS)) {
          await (
            target as unknown as {
              $executeRawUnsafe: (sql: string) => Promise<number>;
            }
          ).$executeRawUnsafe("SET LOCAL statement_timeout = 1");
        }
        return await value.apply(target, [query, ...rest]);
      };
    },
  });
}

async function seedCorpus(organizationId: string) {
  const user = await createTestUser(organizationId);
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `public-${organizationId}`,
          fullName: REPOSITORY,
        }),
        owner: "acme",
        name: "widgets",
        htmlUrl: `https://github.com/${REPOSITORY}`,
      },
      select: { id: true },
    })
  );
  // One branch whose owner RESOLVES and one that is genuinely unattributed, so
  // the healthy page carries both an attributed option and the fallback one —
  // the population the degraded page has to stay distinguishable from.
  await seedBranch(organizationId, user.id, "feat/attributed", true);
  await seedBranch(organizationId, user.id, "feat/unattributed", false);
  return user;
}

async function seedBranch(
  organizationId: string,
  userId: string,
  branchName: string,
  resolvesOwner: boolean
) {
  const artifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
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
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: REPOSITORY,
        branchName,
        firstPushedAt: new Date(NOW.getTime() - 86_400_000),
        pushSource: BranchPushSource.Session,
        lastActivityAt: NOW,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
  const sessionArtifactId = await linkValidSessionToBranch({
    organizationId,
    branchArtifactId: artifactId,
    userId,
    label: branchName,
  });
  if (resolvesOwner) {
    await withDb((db) =>
      db.artifactLink.updateMany({
        where: { sourceId: sessionArtifactId, targetId: artifactId },
        data: {
          branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
          branchParticipationObservedAt: new Date(NOW.getTime() - 86_400_000),
        },
      })
    );
    // The push link's writer seeds the branch assignee (ISS-12463).
    await withDb.tx((tx) => seedBranchOwners(tx, organizationId, [artifactId]));
  }
  return artifactId;
}

describeIfDb("Branches list identity enrichment fails open (ISS-10298)", () => {
  it("returns the page with Collaborators unavailable and Owner intact when the identity read expires", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await seedCorpus(organizationId);

    const healthy = await readList(organizationId, false);
    const degraded = await readList(organizationId, true);

    // The healthy page is the control. The Owner facet publishes the assigned
    // person beside the unassigned branch's fallback option, and an assignee
    // read is complete for both.
    expect(healthy.facets?.owners.availability).toBe(
      BranchListFacetAvailability.Complete
    );
    expect(
      healthy.facets?.owners.options.some(
        (option) => option.id !== BRANCH_OWNER_UNATTRIBUTED_LABEL
      )
    ).toBe(true);
    // ISS-10992 / PLN-2130 v5 AC-004/007: the observed Owner push qualifies
    // independently of comments, while missing lifetime push proof stays incomplete.
    expect(healthy.facets?.collaborators.options).toEqual([
      { id: `closedloop:${user.id}`, label: "Test User", count: 1 },
    ]);
    expect(healthy.facets?.collaborators.availability).toBe(
      BranchListFacetAvailability.Incomplete
    );

    // The page still came back. An escaping error is a 500, so reaching any
    // assertion here at all is the fail-open half of the contract.
    expect(degraded.items.map((item) => item.id)).toEqual(
      healthy.items.map((item) => item.id)
    );
    expect(degraded.total).toBe(healthy.total);

    // ISS-10992: failed identity enrichment cannot publish the healthy facet's
    // observed pusher option. Empty options remain explicitly unavailable.
    expect(degraded.facets?.collaborators.options).toEqual([]);
    expect(degraded.facets?.collaborators.availability).toBe(
      BranchListFacetAvailability.Unavailable
    );
    // ISS-12463: the Owner facet and every row's Owner come through the
    // blackout unchanged, because they read the assignee column.
    expect(degraded.facets?.owners).toEqual(healthy.facets?.owners);
    expect(degraded.items.map((item) => item.ownerIdentity)).toEqual(
      healthy.items.map((item) => item.ownerIdentity)
    );
    expect(
      degraded.items.some(
        (item) => item.ownerIdentity?.person?.userId === user.id
      )
    ).toBe(true);

    // Facets the identity laterals do not feed are untouched, so the degrade is
    // scoped to identity rather than flattening the whole page.
    expect(degraded.facets?.repositories.availability).toBe(
      BranchListFacetAvailability.Complete
    );
    expect(degraded.facets?.names.options).toEqual(
      healthy.facets?.names.options
    );
  });
});
