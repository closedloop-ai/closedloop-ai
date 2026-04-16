import type { JsonObject } from "@repo/api/src/types/common";
import {
  type CreateExternalLinkInput,
  type ExternalLink,
  ExternalLinkType,
  type FindExternalLinksOptions,
  type UpdateExternalLinkInput,
} from "@repo/api/src/types/external-link";
import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

// URL shape: https://github.com/<owner>/<repo>/pull/<number>
const PR_FULL_NAME_REGEX = /github\.com\/([^/]+\/[^/]+)\/pull\//;
// Matches the "PR #N: " display prefix prepended to external link titles
const PR_TITLE_PREFIX_REGEX = /^PR\s*#\d+:\s*/;

export const externalLinksService = {
  toExternalLink(link: Prisma.ExternalLinkModel): ExternalLink {
    return {
      ...link,
      metadata: link.metadata as JsonObject | null,
    };
  },

  findAll(
    options: FindExternalLinksOptions & { organizationId: string }
  ): Promise<ExternalLink[]> {
    const { organizationId, workstreamId, projectId, type } = options;

    return withDb((db) =>
      db.externalLink.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toExternalLink));
  },

  findById(id: string, organizationId: string): Promise<ExternalLink | null> {
    return withDb((db) =>
      db.externalLink.findFirst({
        where: { id, organizationId },
      })
    ).then((link) => (link ? this.toExternalLink(link) : null));
  },

  findByWorkstream(
    workstreamId: string,
    type?: ExternalLink["type"]
  ): Promise<ExternalLink[]> {
    return withDb((db) =>
      db.externalLink.findMany({
        where: {
          workstreamId,
          ...(type ? { type } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toExternalLink));
  },

  async create(
    organizationId: string,
    input: CreateExternalLinkInput
  ): Promise<ExternalLink> {
    const { artifactId, ...prismaInput } = input;

    // Wrap the primary insert in a transaction.
    const link = await withDb.tx(async (tx) => {
      // Resolve workstreamId from the artifact when artifactId is provided but workstreamId is not.
      let resolvedWorkstreamId = prismaInput.workstreamId;

      if (artifactId && !resolvedWorkstreamId) {
        const artifact = await tx.artifact.findFirst({
          where: { id: artifactId, organizationId },
          select: { workstreamId: true },
        });
        resolvedWorkstreamId = artifact?.workstreamId ?? undefined;
      }

      return tx.externalLink.create({
        data: {
          ...prismaInput,
          organizationId,
          workstreamId: resolvedWorkstreamId,
          metadata: prismaInput.metadata ?? Prisma.DbNull,
        },
      });
    });

    // Best-effort: create a github_pull_requests row for PULL_REQUEST links.
    // Runs outside the primary transaction so a failure does NOT roll back the
    // external_link that was just committed.
    if (link.type === ExternalLinkType.PullRequest && link.metadata) {
      await bestEffortInsertPullRequest({
        link,
        organizationId,
        artifactId: artifactId ?? null,
      });
    }

    return this.toExternalLink(link);
  },

  update(
    organizationId: string,
    id: string,
    input: Omit<UpdateExternalLinkInput, "id">
  ): Promise<ExternalLink> {
    const metadata =
      input.metadata === undefined
        ? undefined
        : (input.metadata ?? Prisma.DbNull);
    return withDb((db) =>
      db.externalLink.update({
        where: { id, organizationId },
        data: {
          ...input,
          metadata,
        },
      })
    ).then((link) => this.toExternalLink(link));
  },

  async delete(organizationId: string, id: string): Promise<void> {
    await withDb.tx(async (tx) => {
      await tx.entityLink.deleteMany({
        where: {
          organizationId,
          OR: [
            { sourceId: id, sourceType: "EXTERNAL_LINK" },
            { targetId: id, targetType: "EXTERNAL_LINK" },
          ],
        },
      });
      await tx.externalLink.delete({ where: { id, organizationId } });
    });
  },
};

type BestEffortInsertPROptions = {
  link: Prisma.ExternalLinkModel;
  organizationId: string;
  artifactId: string | null;
};

async function bestEffortInsertPullRequest({
  link,
  organizationId,
  artifactId,
}: BestEffortInsertPROptions): Promise<void> {
  const { workstreamId } = link;
  if (!workstreamId) {
    log.warn(
      "[externalLinksService.create] Skipping github_pull_requests insert — workstreamId is null",
      { externalLinkId: link.id, organizationId }
    );
    return;
  }

  try {
    const parsed = parsePullRequestMetadata(link.metadata);
    if (!parsed) {
      log.warn(
        "[externalLinksService.create] Could not parse PR metadata — skipping github_pull_requests insert",
        { externalLinkId: link.id }
      );
      return;
    }

    const { githubId } = parsed;
    if (!githubId) {
      log.warn(
        "[externalLinksService.create] githubId absent from metadata — skipping github_pull_requests insert",
        { externalLinkId: link.id }
      );
      return;
    }

    const urlMatch = PR_FULL_NAME_REGEX.exec(link.externalUrl);
    const fullName = urlMatch ? urlMatch[1] : null;

    if (!fullName) {
      log.warn(
        "[externalLinksService.create] Cannot parse repo fullName from PR URL — skipping github_pull_requests insert",
        { externalUrl: link.externalUrl, externalLinkId: link.id }
      );
      return;
    }

    await withDb(async (db) => {
      const repo = await db.gitHubInstallationRepository.findFirst({
        where: { fullName, installation: { organizationId } },
        select: { id: true },
      });

      if (!repo) {
        log.warn(
          "[externalLinksService.create] Repository not found — skipping github_pull_requests insert",
          { fullName, organizationId, externalLinkId: link.id }
        );
        return;
      }

      const existing = await db.gitHubPullRequest.findFirst({
        where: { githubId, organizationId },
        select: { id: true },
      });

      if (existing) {
        log.info(
          "[externalLinksService.create] github_pull_requests row already exists — skipping insert",
          { githubId, externalLinkId: link.id }
        );
        return;
      }

      // Strip the "PR #N: " display prefix to store the raw GitHub title
      const rawTitle = link.title.replace(PR_TITLE_PREFIX_REGEX, "");

      const createdPr = await db.gitHubPullRequest.create({
        data: {
          workstreamId,
          organizationId,
          repositoryId: repo.id,
          artifactId,
          githubId,
          number: parsed.number,
          title: rawTitle,
          htmlUrl: link.externalUrl,
          headBranch: parsed.headBranch,
          baseBranch: parsed.baseBranch,
          state: parsed.state,
        },
        select: { githubId: true },
      });

      log.info(
        "[externalLinksService.create] Created github_pull_requests row",
        {
          githubId: createdPr.githubId,
          externalLinkId: link.id,
          workstreamId,
        }
      );
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      log.info(
        "[externalLinksService.create] github_pull_requests row already exists (P2002 dedup)",
        { externalLinkId: link.id }
      );
    } else {
      log.warn(
        "[externalLinksService.create] Non-fatal error creating github_pull_requests row",
        { externalLinkId: link.id, err }
      );
    }
  }
}
