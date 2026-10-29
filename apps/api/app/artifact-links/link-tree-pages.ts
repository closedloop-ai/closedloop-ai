import { randomUUID } from "node:crypto";
import type {
  ArtifactLink,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { ARTIFACT_LINK_SELECT, toArtifactLink } from "./link-projections";
import {
  ARTIFACT_LINK_PAGE_SIZE,
  type PeekedLinkPage,
  type ResolvedLinkWindow,
} from "./resolved-page";

const SNAPSHOT_TTL_MS = 86_400_000;
const WRITE_BATCH_PAGES = 25;
const SWEEP_BATCH_PAGES = 1000;
const MAX_SWEEP_BATCHES = 20;

type TreeScope = {
  organizationId: string;
  artifactId: string;
  direction: LinkDirection;
  maxDepth: number;
  linkType?: LinkType;
};

function queryKey(scope: TreeScope): string {
  return JSON.stringify([
    scope.artifactId,
    scope.direction,
    scope.maxDepth,
    scope.linkType ?? null,
  ]);
}

export async function readLinkTreePage(
  scope: TreeScope,
  window: ResolvedLinkWindow
): Promise<(PeekedLinkPage<ArtifactLink> & { snapshotId?: string }) | null> {
  if (window.skip === 0) {
    return null;
  }
  try {
    const page = await withDb((db) =>
      db.artifactLinkTreePage.findFirst({
        where: {
          organizationId: scope.organizationId,
          queryKey: queryKey(scope),
          offset: window.skip,
          expiresAt: { gt: new Date() },
          ...(window.snapshotId ? { snapshotId: window.snapshotId } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { snapshotId: "desc" }],
        select: { snapshotId: true, linkIds: true, hasMore: true },
      })
    );
    if (!page) {
      return null;
    }
    const rows = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId: scope.organizationId,
          id: { in: page.linkIds },
        },
        select: ARTIFACT_LINK_SELECT,
      })
    );
    const byId = new Map(rows.map((row) => [row.id, toArtifactLink(row)]));
    const pageLinks = page.linkIds.flatMap((id) => {
      const link = byId.get(id);
      return link ? [link] : [];
    });
    return {
      pageLinks,
      ...(page.hasMore
        ? {
            nextCursor: String(window.skip + ARTIFACT_LINK_PAGE_SIZE),
            snapshotId: page.snapshotId,
          }
        : {}),
    };
  } catch (error) {
    // Stage serves the new bundle before its additive migration runs.
    if (getPrismaErrorCode(error) !== "P2021") {
      throw error;
    }
    log.error("artifact_link_tree_snapshot_unavailable", {
      organizationId: scope.organizationId,
      error,
    });
    return null;
  }
}

export async function saveLinkTreePages(
  scope: TreeScope,
  links: readonly ArtifactLink[],
  window: ResolvedLinkWindow
): Promise<string | undefined> {
  if (links.length <= window.skip + ARTIFACT_LINK_PAGE_SIZE) {
    return undefined;
  }
  const snapshotId = randomUUID();
  const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS);
  const key = queryKey(scope);
  try {
    for (
      // Page zero always traverses afresh; storing it cannot serve a reader.
      let start = Math.max(window.skip, ARTIFACT_LINK_PAGE_SIZE);
      start < links.length;
      start += ARTIFACT_LINK_PAGE_SIZE * WRITE_BATCH_PAGES
    ) {
      const data: Prisma.ArtifactLinkTreePageCreateManyInput[] = [];
      for (
        let offset = start;
        offset <
        Math.min(
          links.length,
          start + ARTIFACT_LINK_PAGE_SIZE * WRITE_BATCH_PAGES
        );
        offset += ARTIFACT_LINK_PAGE_SIZE
      ) {
        data.push({
          snapshotId,
          organizationId: scope.organizationId,
          queryKey: key,
          offset,
          linkIds: links
            .slice(offset, offset + ARTIFACT_LINK_PAGE_SIZE)
            .map((link) => link.id),
          hasMore: offset + ARTIFACT_LINK_PAGE_SIZE < links.length,
          expiresAt,
        });
      }
      await withDb((db) => db.artifactLinkTreePage.createMany({ data }));
    }
    return snapshotId;
  } catch (error) {
    // The traversal succeeded. Cache persistence must not turn that read into
    // a 500; absent snapshotId retains the existing numeric-offset fallback.
    log.error("artifact_link_tree_snapshot_unavailable", {
      organizationId: scope.organizationId,
      error,
    });
    return undefined;
  }
}

export async function sweepExpiredLinkTreePages(): Promise<number> {
  const cutoff = new Date();
  let deleted = 0;
  for (let batch = 0; batch < MAX_SWEEP_BATCHES; batch++) {
    const pages = await withDb((db) =>
      db.artifactLinkTreePage.findMany({
        where: { expiresAt: { lte: cutoff } },
        select: { snapshotId: true, offset: true },
        orderBy: { expiresAt: "asc" },
        take: SWEEP_BATCH_PAGES,
      })
    );
    if (pages.length === 0) {
      break;
    }
    // Each bounded delete commits separately, so a later timeout cannot roll
    // back earlier progress. A backlog beyond this run resumes next hour.
    const { count } = await withDb((db) =>
      db.artifactLinkTreePage.deleteMany({
        where: { expiresAt: { lte: cutoff }, OR: pages },
      })
    );
    deleted += count;
    if (pages.length < SWEEP_BATCH_PAGES) {
      break;
    }
  }
  return deleted;
}
