export const FeedItemKind = {
  LiveblocksComment: "liveblocks-comment",
  PrComment: "pr-comment",
  // Activity + AgentJob added by future sources without breaking existing ones.
} as const;
export type FeedItemKind = (typeof FeedItemKind)[keyof typeof FeedItemKind];

/**
 * Base shape every heterogeneous feed item must satisfy. `id` is unique
 * within a source; `kind` discriminates render paths; `sourceId` matches
 * the producing `FeedSource.id` (used for cross-source merge keys and
 * filter-state lookup). `createdAt` is the cross-source sort key —
 * Liveblocks `ThreadData.createdAt` is already a `Date`; the PR source
 * converts ISO strings at the source boundary.
 */
export type FeedItem = {
  id: string;
  kind: FeedItemKind;
  sourceId: string;
  createdAt: Date;
};
