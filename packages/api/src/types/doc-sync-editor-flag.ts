/**
 * PLN-2189 (ISS-12504): moves the document editor's live draft, presence,
 * carets and room events from Liveblocks to the doc-sync service. Default off;
 * retired at full cutover by keeping the doc-sync branch.
 */
export const DOC_SYNC_EDITOR_FLAG_KEY = "doc-sync-editor" as const;
