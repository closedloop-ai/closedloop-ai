import type { TagSummary } from "@repo/api/src/types/tag";

/**
 * The Prisma selection and row mapping for the generic `TagArtifact` join,
 * split out of `@/app/tags/service` (ISS-8712).
 *
 * WHY ITS OWN MODULE, and it is load-bearing rather than tidiness: these two
 * helpers are pure shape, but `tags/service` also owns the tag WRITE path, which
 * reaches `@/lib/github/artifact-tag-label-reconciliation` and from there
 * `packages/github/installation-auth`, whose first line is `import "server-only"`.
 *
 * That import is inert inside a Next server bundle and throws under plain Node.
 * `apps/api` runs the desktop gateway outside Next (`tsx`), and its
 * `server:import-smoke` step imports that entrypoint for exactly this reason —
 * so any module the gateway can reach must not pull `server-only` in. Branches
 * got away with reading these from the service because nothing the gateway
 * imports reaches `branch-tag-projection`; Sessions does not, because the
 * gateway reaches the agent-sessions service.
 *
 * So: anything a READ path needs from the tag vocabulary belongs here, and
 * `tags/service` re-exports both names so existing importers are unaffected.
 */
export const TAG_SUMMARY_SELECT = {
  id: true,
  name: true,
  color: true,
} as const;

export const TAG_RELATION_INCLUDE = {
  tag: { select: TAG_SUMMARY_SELECT },
} as const;

export function mapTagRelations(
  relations: Array<{ tag: { id: string; name: string; color: string } }>
) {
  return relations.map((r) => r.tag) as TagSummary[];
}
