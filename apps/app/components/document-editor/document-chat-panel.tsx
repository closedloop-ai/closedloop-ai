"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  ResizableHandle,
  ResizablePanel,
} from "@repo/design-system/components/ui/resizable";
import { DocumentChatTab } from "./document-chat-tab";

type DocumentChatPanelProps = {
  document: DocumentDetail;
  visible: boolean;
};

/**
 * Right-hand side panel that houses the interactive chat drawer. Shared
 * across PRD, Plan, and Feature editor hosts so the chat UX is identical.
 * Used when the `comments-v2-feed-sidebar` flag is OFF — when that flag
 * is ON, the chat lives inside `FeedSidebar`'s Chat tab instead.
 */
export function DocumentChatPanel({
  document,
  visible,
}: Readonly<DocumentChatPanelProps>) {
  if (!visible) {
    return null;
  }
  return (
    <>
      <ResizableHandle className="z-20 after:w-[3px]! hover:after:bg-primary" />
      <ResizablePanel defaultSize={25} maxSize={40} minSize={15}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <DocumentChatTab document={document} />
        </div>
      </ResizablePanel>
    </>
  );
}
