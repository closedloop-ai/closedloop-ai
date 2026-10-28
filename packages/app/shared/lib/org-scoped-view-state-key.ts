/**
 * The one builder for an identity-namespaced persisted view-state key
 * (ISS-9726).
 *
 * Every `table:*` localStorage key in the product was global to the browser
 * profile, so a reader who switched organizations was handed the previous
 * organization's search text, filters, sort, scroll offset, and column layout
 * on the same surface. Two of those genuinely carry the other organization's
 * DATA — `table:filters:*` persists assignee and tag UUIDs, `table:search:*`
 * persists free text about the other organization's artifacts — and all of
 * them silently narrow the population the reader believes they are seeing.
 *
 * No surface hand-writes the format. It exists here so a rename reaches every
 * key at once, and so a new surface cannot invent a second namespace shape.
 */

/**
 * Separates a base key from the identity that owns the value under it.
 *
 * Deliberately not a bare `:`. Some base keys already end in a `:`-joined
 * entity id (`table:sort:project-artifacts:<projectId>`), so a bare separator
 * would make `<base>:<id>` and a base key whose last segment happened to be
 * that id indistinguishable.
 */
export const VIEW_STATE_KEY_SEPARATOR = "::id:" as const;

/**
 * The identity-namespaced key for `baseKey`, or `null` when there is no
 * identity to attribute the value to.
 *
 * Both halves of the identity matter, for different reasons. The ORGANIZATION
 * because the persisted payload names organization-scoped entities — that is
 * the leak this ticket exists to close. The USER because two accounts share one
 * browser profile more often than anyone plans for, and inside a shared
 * organization the organization alone would hand one person's saved filters
 * (which name teammates by UUID) and search text to the next account signed in
 * on that machine. Same pair, same order, that `queryCacheScopeOf` scopes the
 * query cache by, and the same threat `use-persisted-table-view-state` already
 * namespaces its saved views against.
 *
 * `null` is a value, not a failure: it is the "do not persist" contract
 * `useViewStatePersistence` already speaks, and the two other storage hooks were
 * taught it for this change. Falling back to the un-namespaced key while the
 * identity is still resolving would reintroduce exactly the cross-organization
 * read this builder exists to remove, and inventing a shared "unknown identity"
 * bucket would be the same leak under a longer name. Rendering defaults for that
 * window and persisting nothing is the only answer that cannot attribute one
 * reader's view to another.
 *
 * An empty or whitespace-only id is treated as absent. The auth port types both
 * fields as `string | null`, but a shell adapter supplying `""` is reachable and
 * would otherwise mint one namespace shared by everyone.
 */
export function orgScopedViewStateKey(
  baseKey: string,
  userId: string | null | undefined,
  organizationId: string | null | undefined
): string | null {
  if (!(userId?.trim() && organizationId?.trim())) {
    return null;
  }
  return `${baseKey}${VIEW_STATE_KEY_SEPARATOR}${userId}:${organizationId}`;
}
