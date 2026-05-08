import { LinkType } from "@repo/api/src/types/artifact";
import {
  type PullRequestInfo,
  pickPullRequestForRepo,
} from "@repo/api/src/types/document";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import {
  pullRequestArtifactToInfo,
  pullRequestWhere,
} from "@/lib/artifact-adapters";
import { artifactLinksService } from "../artifact-links/service";

type PrArtifactRow = Prisma.ArtifactGetPayload<{
  include: {
    pullRequest: {
      include: {
        repository: { select: { fullName: true } };
      };
    };
  };
}>;

type PrArtifactResult = {
  rows: PrArtifactRow[];
  targetRepo: string | null;
};

async function queryPrArtifacts(
  documentId: string,
  organizationId: string
): Promise<PrArtifactResult> {
  const artifact = await withDb((db) =>
    db.artifact.findUnique({
      where: { id: documentId, organizationId },
      select: { type: true, document: { select: { targetRepo: true } } },
    })
  );

  if (artifact?.type !== ArtifactType.DOCUMENT) {
    return { rows: [], targetRepo: null };
  }

  const targetRepo = artifact.document?.targetRepo ?? null;

  const targetLinks = await artifactLinksService.findTargetLinks(
    organizationId,
    documentId,
    LinkType.Produces
  );

  if (targetLinks.length === 0) {
    return { rows: [], targetRepo };
  }

  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: pullRequestWhere({
        organizationId,
        id: { in: targetLinks.map((link) => link.targetId) },
      }),
      include: {
        pullRequest: {
          include: {
            repository: { select: { fullName: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })
  );

  return { rows, targetRepo };
}

function rowToInfo(row: PrArtifactRow): PullRequestInfo | null {
  return pullRequestArtifactToInfo(row, {
    externalLinkId: row.id,
  });
}

export const documentPullRequestService = {
  /**
   * Get the pull request that this document produces for the requested repo.
   * Falls back to the document's primary repo, then the newest linked PR.
   * Returns null when no linked PR artifact exists.
   */
  async getDocumentPullRequest(
    documentId: string,
    organizationId: string,
    repoFullName?: string | null
  ): Promise<PullRequestInfo | null> {
    const pullRequests = await this.getDocumentPullRequests(
      documentId,
      organizationId
    );
    return pickPullRequestForRepo(pullRequests, repoFullName);
  },

  /**
   * Get all pull requests that this document produces, sorted so that the PR
   * whose repo matches the document's `targetRepo` comes first, followed by
   * the remaining PRs in `createdAt desc` order.
   */
  async getDocumentPullRequests(
    documentId: string,
    organizationId: string
  ): Promise<PullRequestInfo[]> {
    const { rows, targetRepo } = await queryPrArtifacts(
      documentId,
      organizationId
    );
    if (rows.length === 0) {
      return [];
    }

    const infos = rows
      .map(rowToInfo)
      .filter((info): info is PullRequestInfo => info !== null);

    const primary = pickPullRequestForRepo(infos, targetRepo);
    if (!primary) {
      return infos;
    }

    return [primary, ...infos.filter((info) => info.id !== primary.id)];
  },
};
