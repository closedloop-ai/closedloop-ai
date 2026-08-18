"use client";

import type { ScaffoldSlotContext } from "@repo/app/documents/components/document-editor-scaffold";
import { DocumentChatPanelWrapper } from "@/components/document-editor/document-chat-panel-wrapper";
import { DocumentChatTab } from "@/components/document-editor/document-chat-tab";

/**
 * The single app-owned web chat adapter for {@link DocumentEditorScaffold}.
 *
 * Every web editor (PRD, Implementation Plan, Issue, Document) wires the same
 * two chat slots the same way: the legacy right-rail `DocumentChatPanel` is
 * gated on `chatEnabled && !feedEnabled` (the Feed sidebar owns the chat tab
 * once its flag is on), and the in-feed chat tab renders when chat is enabled.
 * Centralizing that policy here keeps a single owner, so a future gating change
 * cannot drift by artifact type and a new editor cannot silently omit it — pass
 * these two builders to the scaffold from every editor instead of re-copying
 * the `DocumentChatPanelWrapper` mapping and the visibility predicate.
 */
export function renderDocumentChatPanelSlot(ctx: ScaffoldSlotContext) {
  return (
    <DocumentChatPanelWrapper
      document={ctx.document}
      enabled={ctx.chatEnabled && !ctx.feedEnabled}
      visible={ctx.chrome.showMetadataPanel}
    />
  );
}

export function renderDocumentChatTabSlot(ctx: ScaffoldSlotContext) {
  return <DocumentChatTab document={ctx.document} />;
}
