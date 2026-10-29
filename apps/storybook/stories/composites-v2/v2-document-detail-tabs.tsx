import {
  DocumentActivityDesignPanel,
  DocumentArtifactPanel,
  DocumentDetailsDesignPanel,
  DocumentSessionsDesignPanel,
} from "@repo/app/documents/components/detail-design/document-detail-design-preview";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

// The Document Detail page's tab bodies (PRD-751, ISS-12586), each in a
// page-height frame so it scrolls as it does on the page. Shared by the
// Composites tab stories under Labs/Documents/Document Detail.

function TabFrame({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background">{children}</div>
    </TooltipProvider>
  );
}

/** Artifact: the document canvas, alone; its page-level actions are inert here. */
export function DocumentArtifactTabDemo() {
  return (
    <TabFrame>
      <DocumentArtifactPanel />
    </TabFrame>
  );
}

export function DocumentSessionsTabDemo() {
  return (
    <TabFrame>
      <DocumentSessionsDesignPanel />
    </TabFrame>
  );
}

export function DocumentDetailsTabDemo() {
  return (
    <TabFrame>
      <DocumentDetailsDesignPanel />
    </TabFrame>
  );
}

export function DocumentActivityTabDemo() {
  return (
    <TabFrame>
      <DocumentActivityDesignPanel />
    </TabFrame>
  );
}
