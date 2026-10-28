/**
 * ISS-12039: what caused a read. Perrin Upcott ruling, 2026-10-05.
 *
 * `User` is a query key's first fetch (mount, navigation, a filter, sort or
 * page change) or an explicit refresh. `Background` is a refetch of a key that
 * has already settled: an interval poll, a window-focus refetch, or a
 * live-bridge invalidation. Transport metadata only, never a filter.
 */
export const ReadInitiator = {
  User: "user",
  Background: "background",
} as const;
export type ReadInitiator = (typeof ReadInitiator)[keyof typeof ReadInitiator];
