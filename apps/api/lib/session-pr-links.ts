// Shared building blocks for the two session→PR-link readers
// (agent-session-attribution.ts and agent-session-delivery-metrics.ts). Both
// project the SAME matched-session set through the SAME session→PR link filter
// and the SAME keyset pager, so the predicate and the pagination loop live here
// once instead of being copy-pasted per reader.

import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { type Prisma, withDb } from "@repo/database";

/**
 * The canonical `sourceLinks`/`ArtifactLink` WHERE predicate that selects a
 * session→PR link: a RELATES_TO link whose `linkKind` metadata is `SessionPr`.
 * Exported so the attribution and delivery-metrics readers share ONE literal
 * instead of each re-spelling it (previously duplicated four times).
 */
export const SESSION_PR_LINK_WHERE = {
  linkType: LinkType.RelatesTo,
  metadata: {
    path: ["linkKind"],
    equals: SessionArtifactLinkKind.SessionPr,
  },
} as const satisfies Prisma.ArtifactLinkWhereInput;

/**
 * Cheap probe: is there at least one session→PR link whose source session
 * matches `where`? Both readers call this before paging so a broad/unfiltered
 * dashboard with no PR links never issues the row scan at all.
 */
export async function hasMatchingSessionPrLinks(
  where: Prisma.SessionDetailWhereInput
): Promise<boolean> {
  const link = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        ...SESSION_PR_LINK_WHERE,
        source: {
          type: ArtifactType.Session,
          session: { is: where },
        },
      },
      select: { id: true },
    })
  );
  return link !== null;
}

/** Keyset page size shared by both session→PR-link pagers. */
export const SESSION_PR_LINK_PAGE_SIZE = 200;

/**
 * Generic keyset (cursor) pager over `sessionDetail`, ordered by `artifactId`.
 * Parameterized by the `select` projection and a per-page visitor, so a caller
 * only decides WHICH columns to read and WHAT to do with each page — the bounded
 * "take N, cursor past the last id, stop on a short page" loop lives here once.
 * A heavy org never materializes every matched session in memory at once.
 */
export async function visitSessionDetailPages<
  Select extends Prisma.SessionDetailSelect,
>(
  where: Prisma.SessionDetailWhereInput,
  select: Select,
  visitPage: (
    records: Prisma.SessionDetailGetPayload<{ select: Select }>[]
  ) => void | Promise<void>
): Promise<void> {
  let cursorId: string | undefined;

  for (;;) {
    const page = await withDb((db) =>
      db.sessionDetail.findMany({
        where,
        select,
        orderBy: { artifactId: "asc" },
        take: SESSION_PR_LINK_PAGE_SIZE,
        ...(cursorId ? { cursor: { artifactId: cursorId }, skip: 1 } : {}),
      })
    );
    await visitPage(
      page as Prisma.SessionDetailGetPayload<{ select: Select }>[]
    );

    if (page.length < SESSION_PR_LINK_PAGE_SIZE) {
      return;
    }
    cursorId = (page.at(-1) as { artifactId?: string } | undefined)?.artifactId;
    if (!cursorId) {
      return;
    }
  }
}
