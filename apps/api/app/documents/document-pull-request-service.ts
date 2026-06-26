import { LinkType } from "@repo/api/src/types/artifact";
import {
  type BranchInfo,
  getPrimaryRepoFromSnapshot,
  type PullRequestInfo,
  pickBranchForRepo,
  pickPullRequestForRepo,
} from "@repo/api/src/types/document";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { branchArtifactToInfo } from "@/lib/artifact-adapters";
import { artifactLinksService } from "../artifact-links/service";
import { parseStoredSnapshot } from "./repository-snapshot-helpers";

type BranchArtifactRow = Prisma.ArtifactGetPayload<{
  include: {
    branch: {
      include: {
        repository: { select: { fullName: true } };
        currentPullRequestDetail: {
          include: {
            repository: { select: { fullName: true } };
          };
        };
      };
    };
  };
}>;

type BranchArtifactResult = {
  rows: BranchArtifactRow[];
  primaryRepoFullName: string | null;
};

async function queryBranchArtifacts(
  documentId: string,
  organizationId: string
): Promise<BranchArtifactResult> {
  const artifact = await withDb((db) =>
    db.artifact.findUnique({
      where: { id: documentId, organizationId },
      select: {
        type: true,
        document: { select: { repositorySnapshot: true } },
      },
    })
  );

  if (artifact?.type !== ArtifactType.DOCUMENT) {
    return { rows: [], primaryRepoFullName: null };
  }

  const snapshot = parseStoredSnapshot(artifact.document?.repositorySnapshot);
  const primaryRepoFullName = snapshot
    ? (getPrimaryRepoFromSnapshot(snapshot)?.fullName ?? null)
    : null;

  const targetLinks = await artifactLinksService.findTargetLinks(
    organizationId,
    documentId,
    LinkType.Produces
  );

  if (targetLinks.length === 0) {
    return { rows: [], primaryRepoFullName };
  }

  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        id: { in: targetLinks.map((link) => link.targetId) },
        type: ArtifactType.BRANCH,
      },
      include: {
        branch: {
          include: {
            repository: { select: { fullName: true } },
            currentPullRequestDetail: {
              include: {
                repository: { select: { fullName: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })
  );

  return { rows, primaryRepoFullName };
}

function branchRowToInfo(row: BranchArtifactRow): BranchInfo | null {
  return branchArtifactToInfo(row, {
    externalLinkId: row.id,
  });
}

export const documentPullRequestService = {
  /**
   * Get the branch artifact that this document produces for the requested repo.
   * Falls back to the document's primary repo, then the newest linked branch.
   */
  async getDocumentBranch(
    documentId: string,
    organizationId: string,
    repoFullName?: string | null
  ): Promise<BranchInfo | null> {
    const branches = await this.getDocumentBranches(documentId, organizationId);
    return pickBranchForRepo(branches, repoFullName);
  },

  /**
   * Get all branch artifacts this document produces, sorted so the branch whose
   * repo matches the document's repository-snapshot primary comes first.
   */
  async getDocumentBranches(
    documentId: string,
    organizationId: string
  ): Promise<BranchInfo[]> {
    const { rows, primaryRepoFullName } = await queryBranchArtifacts(
      documentId,
      organizationId
    );
    if (rows.length === 0) {
      return [];
    }

    const infos = rows
      .map(branchRowToInfo)
      .filter((info): info is BranchInfo => info !== null);

    const primary = pickBranchForRepo(infos, primaryRepoFullName);
    if (!primary) {
      return infos;
    }

    return [primary, ...infos.filter((info) => info.id !== primary.id)];
  },

  /**
   * Get the pull request that this document produces for the requested repo.
   * Falls back to the document's primary repo, then the newest linked current PR.
   * Returns null when no linked branch carries current PR detail.
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
   * Get all current pull requests carried by branch artifacts this document
   * produces. Inherits the primary-first ordering from `getDocumentBranches`,
   * which sorts by the document's repository-snapshot primary.
   */
  async getDocumentPullRequests(
    documentId: string,
    organizationId: string
  ): Promise<PullRequestInfo[]> {
    const branches = await this.getDocumentBranches(documentId, organizationId);
    return branches
      .map((branch) => branch.currentPullRequest)
      .filter((info): info is PullRequestInfo => info !== null);
  },

  /** Return minimal head/repository metadata for a branch artifact. */
  async getPullRequestHeadContext(
    branchArtifactId: string,
    organizationId: string
  ): Promise<{ headSha: string | null; repositoryFullName: string | null }> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: {
          id: branchArtifactId,
          organizationId,
          type: ArtifactType.BRANCH,
        },
        select: {
          branch: {
            select: {
              headSha: true,
              repository: { select: { fullName: true } },
            },
          },
        },
      })
    );

    return {
      headSha: artifact?.branch?.headSha ?? null,
      repositoryFullName: artifact?.branch?.repository?.fullName ?? null,
    };
  },
};
