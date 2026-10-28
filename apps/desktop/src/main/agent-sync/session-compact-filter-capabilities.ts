/** Versioned DB-host read operations whose SQL predicates match the list. */
export const SESSION_COMPACT_FILTER_VERSION = 1 as const;

export type SessionCompactFilterCapabilities = {
  cursor: number;
  count: number;
  usage: number;
  analytics: number;
  /** Writer-connection change count; absent on older DB hosts. */
  storeRevision?: number;
};
