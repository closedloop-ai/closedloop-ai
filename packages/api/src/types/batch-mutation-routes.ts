/**
 * Origin-relative paths of the batch-mutation POST routes in `apps/api`.
 *
 * Owned here because the desktop cloud-api-fetch bridge
 * (`apps/desktop/src/main/ipc/cloud-api-fetch-ipc.ts`) must name each route in
 * its non-GET allowlist and may not carry a bare literal there (ISS-9466).
 * ISS-9464 adds `/v2` siblings under the same prefixes; the bridge admits
 * either suffix for those families. V2-only routes include that suffix here,
 * so the bridge never opens a nonexistent v1 sibling.
 */
export const BatchMutationRoute = {
  DocumentsUpdateStatus: "/documents/batch-update-status",
  DocumentsUpdatePriority: "/documents/batch-update-priority",
  DocumentsUpdateAssignee: "/documents/batch-update-assignee/v2",
  DocumentsMove: "/documents/batch-move",
  DocumentsDelete: "/documents/batch-delete",
  EntityTags: "/entity-tags/batch",
  EntityTagsRemove: "/entity-tags/batch-remove",
  AgentSessionsAssign: "/agent-sessions/bulk-assign",
  ArtifactLinksMove: "/artifact-links/batch-move",
  ArtifactsFavorites: "/artifacts/favorites/batch/v2",
} as const;
export type BatchMutationRoute =
  (typeof BatchMutationRoute)[keyof typeof BatchMutationRoute];
