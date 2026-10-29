import { ArtifactType } from "@repo/api/src/types/artifact";
import type { SearchHit } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { withDb } from "@repo/database";

/**
 * Gives each comment hit anchored on a document that document's slug, which
 * `searchHitRoute` routes it by. The slug is read per page rather than stored
 * on the comment's projection row, where the exact-slug lane would match the
 * comment as if it were the document. One org-scoped read for the page.
 */
export async function withCommentAnchorDocumentSlugs(
  organizationId: string,
  hits: SearchHit[]
): Promise<SearchHit[]> {
  const anchorIds = [
    ...new Set(
      hits.flatMap((hit) => {
        const anchorId = documentAnchorId(hit);
        return anchorId === null ? [] : [anchorId];
      })
    ),
  ];
  if (anchorIds.length === 0) {
    return hits;
  }
  const documents = await withDb((db) =>
    db.artifact.findMany({
      where: {
        id: { in: anchorIds },
        organizationId,
        type: ArtifactType.Document,
      },
      select: { id: true, slug: true },
    })
  );
  const slugById = new Map(
    documents.flatMap(({ id, slug }) => (slug ? [[id, slug] as const] : []))
  );
  return hits.map((hit) => {
    const anchorId = documentAnchorId(hit);
    const slug = anchorId === null ? undefined : slugById.get(anchorId);
    return slug === undefined ? hit : { ...hit, slug };
  });
}

function documentAnchorId(hit: SearchHit): string | null {
  return hit.entityType === SearchEntityType.Comment &&
    hit.entitySubtype === ArtifactType.Document &&
    hit.anchorEntityId !== undefined
    ? hit.anchorEntityId
    : null;
}
