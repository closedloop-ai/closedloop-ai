/**
 * Sessions list URL keys a host owns but shared Sessions code must also read.
 * One spelling, so a host's strip and the shared group-link writer cannot drift.
 */

/**
 * The web host's cross-surface selected-user deep link (ISS-4728). URL-owned:
 * the facet writer never emits or clears it, so every code path that has to
 * strip it names it from here.
 */
export const SESSIONS_SELECTED_USER_PARAM = "userId" as const;

/**
 * The desktop host's list search term, written by the global search box outside
 * the list, so the read site and the clear-filters strip name the same key.
 */
export const SESSIONS_SEARCH_PARAM = "search" as const;
