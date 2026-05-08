"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import {
  ResizableHandle,
  ResizablePanel,
} from "@repo/design-system/components/ui/resizable";
import { DocumentChatDrawer } from "@/components/chat/DocumentChatDrawer";

type DocumentChatPanelProps = {
  document: DocumentDetail;
  visible: boolean;
};

const DOCUMENT_TYPE_CHAT_SLUG: Record<DocumentType, string> = {
  [DocumentType.Prd]: "prd",
  [DocumentType.ImplementationPlan]: "plan",
  [DocumentType.Feature]: "feature",
  [DocumentType.Template]: "template",
};

/**
 * Right-hand side panel that houses the interactive chat drawer. Shared across
 * PRD, Plan, and Feature editor hosts so the chat UX is identical.
 */
export function DocumentChatPanel({
  document,
  visible,
}: Readonly<DocumentChatPanelProps>) {
  if (!visible) {
    return null;
  }
  const documentType = DOCUMENT_TYPE_CHAT_SLUG[document.type];
  return (
    <>
      <ResizableHandle className="z-20 after:w-[3px]! hover:after:bg-primary" />
      <ResizablePanel defaultSize={25} maxSize={40} minSize={15}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <DocumentChatDrawer
            documentId={document.id}
            documentSlug={document.slug}
            documentTitle={document.title}
            documentType={documentType}
            fillParent
            targetRepo={document.targetRepo}
          />
        </div>
      </ResizablePanel>
    </>
  );
}
