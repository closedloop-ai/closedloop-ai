"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentChatPanel } from "@/components/document-editor/document-chat-panel";

type DocumentChatPanelWrapperProps = {
  document: DocumentDetail;
  /**
   * When false, this component renders nothing. Callers pass false when the
   * Feed sidebar owns the chat tab (so the legacy `DocumentChatPanel` is
   * suppressed) or when the `interactive-chat` flag is off.
   */
  enabled: boolean;
  visible: boolean;
};

export function DocumentChatPanelWrapper({
  document,
  enabled,
  visible,
}: Readonly<DocumentChatPanelWrapperProps>) {
  if (!enabled) {
    return null;
  }
  return <DocumentChatPanel document={document} visible={visible} />;
}
