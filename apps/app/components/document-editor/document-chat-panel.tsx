"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import {
  ResizableHandle,
  ResizablePanel,
} from "@repo/design-system/components/ui/resizable";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { DocumentChatDrawer } from "@/components/chat/DocumentChatDrawer";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";

type DocumentChatPanelProps = {
  document: DocumentDetail;
  visible: boolean;
  onViewFullTrace: (trace: ExecutionTrace, sessionId?: string) => void;
};

const DOCUMENT_TYPE_CHAT_SLUG: Record<DocumentType, string> = {
  [DocumentType.Prd]: "prd",
  [DocumentType.ImplementationPlan]: "plan",
  [DocumentType.Feature]: "feature",
  [DocumentType.Template]: "template",
};

/**
 * Right-hand side panel that houses the interactive chat drawer and the
 * execution log summary. Shared across PRD, Plan, and Feature editor hosts so
 * the chat/log UX is identical.
 */
export function DocumentChatPanel({
  document,
  visible,
  onViewFullTrace,
}: Readonly<DocumentChatPanelProps>) {
  if (!visible) {
    return null;
  }
  const documentType = DOCUMENT_TYPE_CHAT_SLUG[document.type];
  return (
    <>
      <ResizableHandle className="z-20 after:w-[3px]! hover:after:bg-primary" />
      <ResizablePanel defaultSize={25} maxSize={40} minSize={15}>
        <Tabs className="flex h-full flex-col" defaultValue="chat">
          <TabsList className="mx-3 mt-3 w-auto">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="execution-log">Execution Log</TabsTrigger>
          </TabsList>
          <TabsContent className="min-h-0 flex-1 overflow-hidden" value="chat">
            <DocumentChatDrawer
              documentId={document.id}
              documentSlug={document.slug}
              documentTitle={document.title}
              documentType={documentType}
              fillParent
              targetRepo={document.targetRepo}
            />
          </TabsContent>
          <TabsContent
            className="min-h-0 flex-1 overflow-y-auto p-4"
            value="execution-log"
          >
            <ExecutionLogSummary
              documentId={document.id}
              onViewFullTrace={onViewFullTrace}
            />
          </TabsContent>
        </Tabs>
      </ResizablePanel>
    </>
  );
}
