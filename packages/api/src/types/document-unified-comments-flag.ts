/**
 * PLN-2187 DD-2: switches an organization's document comments from Liveblocks
 * to the unified comments stack. Released by organization only, never by
 * percentage, so every member of an org writes to the same store.
 */
export const DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY =
  "document-unified-comments" as const;
