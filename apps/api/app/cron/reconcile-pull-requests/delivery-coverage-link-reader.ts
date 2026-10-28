import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { Prisma, TransactionClient } from "@repo/database";
import { sessionPrLinkFromSessions } from "@/lib/session-pr-links";

export const GITHUB_DELIVERY_COVERAGE_LINK_SCAN_PAGE_SIZE = 500;
/**
 * ISS-8263: a runaway stop, NOT a measurement cap. The scanned population is
 * every session→PR link the org has ever written for the repo, so it grows
 * monotonically with history and no ceiling sized to today's data stays valid.
 * The original 5,000 was already below the primary repo on the day the emitter
 * shipped — `closedloop-ai/closedloop-ai` measured 5,001 on every tick from
 * 2026-08-26T23:45Z on, so its coverage ratio was never once computed and the
 * unavailable monitor paged every ~3h instead. Sized here to leave that repo
 * room to keep growing; the tick emits `scannedSessionLinkCount` on measured
 * ticks so the headroom is a Datadog series rather than the next page.
 */
export const GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT = 100_000;
export const GITHUB_DELIVERY_COVERAGE_SESSION_LINK_SCAN_LIMIT_EXCEEDED_REASON =
  "session_link_scan_limit_exceeded" as const;

export type DeliveryCoverageLinkRow = {
  id: string;
  targetId: string;
  metadata: unknown;
};

export type GitHubDeliveryCoverageLinkScanInput = {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
};

export type DeliveryCoverageLinkScanUnavailableContext = {
  reason: typeof GITHUB_DELIVERY_COVERAGE_SESSION_LINK_SCAN_LIMIT_EXCEEDED_REASON;
  sessionLinkScanLimit: number;
  scannedSessionLinkCount: number;
};

export type DeliveryCoverageLinkReadResult =
  | { links: DeliveryCoverageLinkRow[] }
  | { unavailable: DeliveryCoverageLinkScanUnavailableContext };

export async function readDeliveryCoverageLinks(
  db: TransactionClient,
  input: GitHubDeliveryCoverageLinkScanInput
): Promise<DeliveryCoverageLinkReadResult> {
  const where = deliveryCoverageSessionLinkWhere({
    ...input,
    repositoryFullName: normalizeRepoFullName(input.repositoryFullName),
  });
  const links: DeliveryCoverageLinkRow[] = [];
  let cursor: string | undefined;
  while (true) {
    const remaining = GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT - links.length;
    const take = Math.min(
      GITHUB_DELIVERY_COVERAGE_LINK_SCAN_PAGE_SIZE,
      remaining + 1
    );
    const page = await db.artifactLink.findMany({
      where,
      orderBy: { id: "asc" },
      take,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select: { id: true, targetId: true, metadata: true },
    });
    if (page.length > remaining) {
      return {
        unavailable: {
          reason:
            GITHUB_DELIVERY_COVERAGE_SESSION_LINK_SCAN_LIMIT_EXCEEDED_REASON,
          sessionLinkScanLimit: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
          scannedSessionLinkCount: links.length + page.length,
        },
      };
    }
    links.push(...page);
    if (page.length < take) {
      return { links };
    }
    const last = page.at(-1);
    if (!last) {
      return { links };
    }
    cursor = last.id;
  }
}

function deliveryCoverageSessionLinkWhere(
  input: GitHubDeliveryCoverageLinkScanInput
): Prisma.ArtifactLinkWhereInput {
  return {
    organizationId: input.organizationId,
    AND: [
      sessionPrLinkFromSessions({}),
      deliveryCoverageSessionLinkRepoScopeWhere(input),
    ],
  };
}

function deliveryCoverageSessionLinkRepoScopeWhere(
  input: GitHubDeliveryCoverageLinkScanInput
): Prisma.ArtifactLinkWhereInput {
  return {
    OR: [
      {
        metadata: {
          path: ["prRefs"],
          array_contains: [{ repositoryFullName: input.repositoryFullName }],
        },
      },
      {
        metadata: {
          path: ["repositoryFullName"],
          equals: input.repositoryFullName,
        },
      },
      {
        target: {
          branch: {
            is: {
              organizationId: input.organizationId,
              ...branchRepoScopeWhere(
                input.repositoryId,
                input.repositoryFullName
              ),
            },
          },
        },
      },
    ],
  };
}

type BranchRepoScopeWhere =
  | { repositoryId: string }
  | { repositoryFullName: string };

function branchRepoScopeWhere(
  repositoryId: string | null,
  repositoryFullName: string
): BranchRepoScopeWhere {
  return repositoryId ? { repositoryId } : { repositoryFullName };
}
