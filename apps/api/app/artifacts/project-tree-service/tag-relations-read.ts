import { type Prisma, withDb } from "@repo/database";
import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

/** One `tag_artifacts` join row with its tag, as `mapTagRelations` reads it. */
export type TagRelationRow = Prisma.TagArtifactGetPayload<{
  include: { tag: true };
}>;

/**
 * Bind parameters this statement spends on anything OTHER than the id list.
 *
 * The `where` binds nothing else, so this is purely headroom for the
 * parameters Prisma adds to a `findMany` that no caller can see — measured at
 * one, or two once a `take` appears (ISS-8185) — with slack so a later `take`
 * or added predicate cannot push the statement over the line silently.
 */
const TAG_RELATION_FIXED_BIND_PARAMETERS = 16;

/**
 * Ids per tag-read statement.
 *
 * Prisma binds ONE parameter per `in` element and REFUSES a built statement at
 * `POSTGRES_MAX_BIND_PARAMETERS`, so a predicate whose width follows the
 * project's artifact count does not merely run slowly on a large tenant — the
 * statement is rejected and takes the whole read with it. ISS-8857 turned this
 * read from a project-scoped select into an id-list one, which is what put the
 * artifact count into the statement width; this is the bound that answers for
 * it (whitlockk, PR #6484).
 *
 * Sized AT the ceiling rather than at the 1,000 the session/usage lanes use
 * (`SESSION_LOC_ID_CHUNK_SIZE`, `SESSION_COMMENT_ID_CHUNK_SIZE`). Those lanes
 * carry additional per-chunk binds and far wider rows; this predicate binds the
 * id list and nothing else, so a smaller chunk would only split reads that
 * comfortably fit one statement — reintroducing the round trip ISS-8857 removed
 * for every realistically-sized project.
 */
export const TAG_RELATION_ID_CHUNK_SIZE =
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS - TAG_RELATION_FIXED_BIND_PARAMETERS;

/**
 * The tag join rows for a set of artifacts, grouped by artifact id.
 *
 * `tag_artifacts` carries no `organization_id` of its own, so its scoping is
 * inherited from the ids — which reach here only from the org-scoped read in
 * `fetchProjectArtifacts`. That is the same inheritance the Prisma relation
 * load this replaces relied on; it is NOT a dropped predicate.
 *
 * Chunks are read in sequence rather than with `Promise.all`: the chunk COUNT
 * follows the artifact count, so awaiting them together would be exactly the
 * unbounded concurrent fan-out `apps/api/AGENTS.md` forbids. Every realistic
 * project is one chunk and therefore one statement, so this costs a round trip
 * only where the alternative was a rejected query.
 */
export async function fetchTagRelationsByArtifact(
  artifactIds: string[]
): Promise<Map<string, TagRelationRow[]>> {
  const byArtifact = new Map<string, TagRelationRow[]>();

  for (
    let start = 0;
    start < artifactIds.length;
    start += TAG_RELATION_ID_CHUNK_SIZE
  ) {
    const idChunk = artifactIds.slice(
      start,
      start + TAG_RELATION_ID_CHUNK_SIZE
    );
    const relations = await withDb((db) =>
      db.tagArtifact.findMany({
        where: { artifactId: { in: idChunk } },
        include: { tag: true },
      })
    );
    for (const relation of relations) {
      const existing = byArtifact.get(relation.artifactId);
      if (existing) {
        existing.push(relation);
        continue;
      }
      byArtifact.set(relation.artifactId, [relation]);
    }
  }

  return byArtifact;
}
