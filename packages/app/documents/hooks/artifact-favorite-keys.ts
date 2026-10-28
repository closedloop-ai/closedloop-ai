/**
 * Query-key factory for the batched `/artifacts/favorites` read.
 *
 * Split out of `use-artifact-favorites` (ISS-9578) for the same reason
 * `document-keys` was split out of `use-documents`: an invalidation set that
 * has to name this family must not pull the hooks module in with it, and a
 * suite that stubs those hooks must not take the key root with them.
 */
export const artifactFavoriteKeys = {
  all: ["artifact-favorites"] as const,
  list: () => [...artifactFavoriteKeys.all, "list"] as const,
  toggle: () => [...artifactFavoriteKeys.all, "toggle"] as const,
};
