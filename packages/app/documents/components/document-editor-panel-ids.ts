/**
 * Stable ids for the document editor's resizable panels.
 *
 * react-resizable-panels@4 keys a persisted layout by panel id, so a panel that
 * lets its id default to `useId()` can never have its size restored. These
 * values are therefore part of the persistence contract: changing one reads as
 * a different panel and silently resets every saved split.
 */
export const DocumentEditorPanelId = {
  Body: "document-editor-body",
} as const;
export type DocumentEditorPanelId =
  (typeof DocumentEditorPanelId)[keyof typeof DocumentEditorPanelId];

export const DOCUMENT_EDITOR_PANEL_IDS = [DocumentEditorPanelId.Body] as const;
