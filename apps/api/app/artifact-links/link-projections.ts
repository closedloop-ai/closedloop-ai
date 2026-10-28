import type {
  ArtifactLink,
  ArtifactLinkEndpoint,
  ArtifactLinkWithEndpoints,
} from "@repo/api/src/types/artifact";
import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import type { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import type {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import type { JsonObject } from "@repo/api/src/types/common";
import type { GitHubPRState } from "@repo/api/src/types/github";
import type { BasicUser } from "@repo/api/src/types/user";
import type {
  Artifact as PrismaArtifact,
  ArtifactLink as PrismaArtifactLink,
} from "@repo/database";
import { withDb } from "@repo/database";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { matchingGitHubPullRequestUrl } from "@/app/branches/branch-provider-fallback-service";
import { basicUserSelect } from "@/lib/db-utils";
import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

export type ArtifactLinkRow = Pick<
  PrismaArtifactLink,
  | "id"
  | "organizationId"
  | "sourceId"
  | "targetId"
  | "linkType"
  | "metadata"
  | "createdAt"
>;

/**
 * One constant for all three direction-scoped finders plus the tree traversal.
 * They differ only in their `where`, so a select that drifted between them
 * would mean the same `ArtifactLink` DTO carrying different columns depending
 * on which side of the edge the caller asked from.
 */
export const ARTIFACT_LINK_SELECT = {
  id: true,
  organizationId: true,
  sourceId: true,
  targetId: true,
  linkType: true,
  metadata: true,
  createdAt: true,
} as const satisfies Record<keyof ArtifactLinkRow, true>;

export type PrismaArtifactWithEndpointDetail = PrismaArtifact & {
  assignee: BasicUser | null;
  branch?: {
    branchName: string;
    baseBranch: string | null;
    headSha: string | null;
    checksStatus: ChecksStatus | null;
    currentPullRequestDetail: {
      id: string;
      branchArtifactId: string | null;
      // Nullable for desktop-produced PRs in non-App repos (FEA-2732).
      repositoryId: string | null;
      repositoryFullName: string | null;
      githubId: string | null;
      number: number;
      title: string | null;
      htmlUrl: string | null;
      body: string | null;
      prState: GitHubPRState;
      isDraft: boolean;
      reviewDecision: ReviewDecision | null;
      closedAt: Date | null;
      mergedAt: Date | null;
      mergeCommitSha: string | null;
      lastVerifiedAt: Date | null;
      lastRefreshAttemptAt: Date | null;
      isCurrent: boolean;
    } | null;
  } | null;
};

export type PrismaArtifactLinkWithArtifacts = PrismaArtifactLink & {
  source: PrismaArtifactWithEndpointDetail;
  target: PrismaArtifactWithEndpointDetail;
};

// ISS-7732: `assignee` is hydrated here, not left to the caller. Without the
// join the endpoint carries `assigneeId` with no user, and every consumer
// renders that absence as a confident "unassigned".
export const endpointInclude = {
  assignee: basicUserSelect,
  branch: {
    include: {
      currentPullRequestDetail: true,
    },
  },
} as const;

export const artifactLinkInclude = {
  source: { include: endpointInclude },
  target: { include: endpointInclude },
} as const;

export function toArtifactLink(link: ArtifactLinkRow): ArtifactLink {
  return {
    id: link.id,
    organizationId: link.organizationId,
    sourceId: link.sourceId,
    targetId: link.targetId,
    linkType: link.linkType,
    metadata: link.metadata as JsonObject | null,
    createdAt: link.createdAt,
  };
}

export function toArtifactLinkEndpoint(
  artifact: PrismaArtifactWithEndpointDetail,
  eligibilityById: ReadonlyMap<string, BranchProductEligibility>
): ArtifactLinkEndpoint {
  const productEligibility = eligibilityById.get(artifact.id);
  const hasCompatibilityProviderFallback = Boolean(
    matchingGitHubPullRequestUrl(artifact.branch?.currentPullRequestDetail)
  );
  return {
    ...artifact,
    ...(productEligibility && { productEligibility }),
    ...(hasCompatibilityProviderFallback && {
      hasCompatibilityProviderFallback: true,
    }),
    // FEA-3956: normalize the persisted subtype to the canonical API set. Rows
    // never store the canonical `ISSUE` (map-in-code, PRD-560 dec. 2), but the
    // generated Prisma enum now includes it; mapping keeps a skewed value
    // resolving to `FEATURE` instead of leaking `ISSUE` into the link contract.
    subtype: artifact.subtype
      ? normalizeArtifactSubtype(artifact.subtype)
      : null,
    branch: artifact.branch
      ? {
          branchName: artifact.branch.branchName,
          currentPullRequest: artifact.branch.currentPullRequestDetail
            ? {
                ...artifact.branch.currentPullRequestDetail,
                headBranch: artifact.branch.branchName,
                baseBranch: artifact.branch.baseBranch ?? "",
                headSha: artifact.branch.headSha,
                checksStatus: artifact.branch.checksStatus,
                ...(hasCompatibilityProviderFallback && {
                  hasCompatibilityProviderFallback: true,
                }),
              }
            : null,
        }
      : null,
  };
}

export function toArtifactLinkWithEndpoints(
  link: PrismaArtifactLinkWithArtifacts,
  eligibilityById: ReadonlyMap<string, BranchProductEligibility>
): ArtifactLinkWithEndpoints {
  return {
    ...toArtifactLink(link),
    source: toArtifactLinkEndpoint(link.source, eligibilityById),
    target: toArtifactLinkEndpoint(link.target, eligibilityById),
  };
}

export function collectBranchEndpointIds(
  links: readonly PrismaArtifactLinkWithArtifacts[]
): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    if (link.source.branch) {
      ids.add(link.source.id);
    }
    if (link.target.branch) {
      ids.add(link.target.id);
    }
  }
  return Array.from(ids);
}

/** `organizationId`, plus headroom for the include's own generated binds. */
const ENDPOINT_FIXED_BIND_PARAMETERS = 8;

/**
 * Endpoint ids per hydration statement.
 *
 * Prisma binds ONE parameter per `in` element and REFUSES a built statement at
 * the Postgres ceiling, so a predicate whose width follows a tenant's artifact
 * graph is not merely slow — the statement is rejected and takes the whole read
 * with it. ISS-10041 measured the pre-fix shape issuing a single
 * `pull_request_detail ... WHERE id IN (...)` with at least 3,875 binds on one
 * production request, which is the same width heading for the same ceiling.
 */
export const ENDPOINT_ID_CHUNK_SIZE =
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS - ENDPOINT_FIXED_BIND_PARAMETERS;

/**
 * Hydrate a set of links with their source/target endpoint objects, reading
 * each DISTINCT endpoint artifact exactly once (ISS-10041).
 *
 * The shape this replaces re-read the LINK rows with `source`/`target` nested,
 * which makes Prisma materialise one artifact — plus its assignee, branch and
 * the ~60-column `PullRequestDetail` behind it, `body @db.Text` included — per
 * INCIDENT EDGE rather than per artifact. A hub endpoint on N links was
 * therefore built N times. That multiplication is what reached the function's
 * 2,048 MB ceiling: measured on a seeded graph, 42,060 links over 700 distinct
 * branch artifacts materialised 42,000 branch endpoints, 60x more than exist.
 *
 * Callers pass links they have ALREADY read, so this also drops the second full
 * pass over `artifact_links` the old shape paid (`apps/api/AGENTS.md` → read a
 * scope once per request).
 *
 * The returned endpoints are shared by reference between links that name the
 * same artifact. Nothing mutates an endpoint, and serialization is unaffected —
 * the response bytes are identical either way; only the object graph shrinks.
 *
 * A link whose endpoint artifact is not returned is dropped, which is how the
 * org predicate below keeps its teeth: it is scoped independently of the ids,
 * so a cross-org id cannot pull a row it does not own.
 */
export async function hydrateLinksWithEndpoints(
  organizationId: string,
  links: readonly ArtifactLink[]
): Promise<ArtifactLinkWithEndpoints[]> {
  if (links.length === 0) {
    return [];
  }

  const endpointIds = new Set<string>();
  for (const link of links) {
    endpointIds.add(link.sourceId);
    endpointIds.add(link.targetId);
  }

  const artifacts = await fetchEndpointArtifacts(
    organizationId,
    Array.from(endpointIds)
  );

  const branchArtifactIds = artifacts
    .filter((artifact) => artifact.branch)
    .map((artifact) => artifact.id);
  const eligibilityById = await branchProductEligibilityService.findByIds(
    organizationId,
    branchArtifactIds
  );

  const endpointById = new Map<string, ArtifactLinkEndpoint>();
  for (const artifact of artifacts) {
    endpointById.set(
      artifact.id,
      toArtifactLinkEndpoint(artifact, eligibilityById)
    );
  }

  const out: ArtifactLinkWithEndpoints[] = [];
  for (const link of links) {
    const source = endpointById.get(link.sourceId);
    const target = endpointById.get(link.targetId);
    if (source && target) {
      out.push({ ...link, source, target });
    }
  }
  return out;
}

/**
 * Chunks are read in sequence rather than with `Promise.all`: the chunk COUNT
 * follows the graph size, so awaiting them together would be exactly the
 * unbounded concurrent fan-out `apps/api/AGENTS.md` forbids. Every realistic
 * graph is one chunk and therefore one statement.
 */
async function fetchEndpointArtifacts(
  organizationId: string,
  endpointIds: readonly string[]
): Promise<PrismaArtifactWithEndpointDetail[]> {
  const artifacts: PrismaArtifactWithEndpointDetail[] = [];
  for (
    let start = 0;
    start < endpointIds.length;
    start += ENDPOINT_ID_CHUNK_SIZE
  ) {
    const idChunk = endpointIds.slice(start, start + ENDPOINT_ID_CHUNK_SIZE);
    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: { id: { in: idChunk }, organizationId },
        include: endpointInclude,
      })
    );
    artifacts.push(...(rows as PrismaArtifactWithEndpointDetail[]));
  }
  return artifacts;
}
