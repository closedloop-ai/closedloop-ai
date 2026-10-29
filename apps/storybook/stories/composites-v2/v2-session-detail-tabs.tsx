import {
  SessionActivityPanel,
  SessionArtifactPanel,
  SessionDetailsPanel,
} from "@repo/app/agents/components/detail/detail-design/session-detail-design-preview";
import type { SessionTraceHandle } from "@repo/app/agents/components/detail/session-trace-contract";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { type ReactNode, useRef, useState } from "react";

// The Session Detail page's tab bodies (PRD-751), each in a page-height frame
// so it scrolls as it does on the page. Shared by the Composites tab
// stories under Artifacts/Sessions/Session Detail.

function TabFrame({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background">{children}</div>
    </TooltipProvider>
  );
}

/**
 * Artifact: the Session Timeline and the trace it jumps to, on the framed
 * canvas. No Properties: they are the Details tab (ISS-12403).
 */
export function SessionArtifactTabDemo() {
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const traceRef = useRef<SessionTraceHandle>(null);
  return (
    <TabFrame>
      <SessionArtifactPanel
        activeRow={activeRow}
        onJump={(row) => {
          setActiveRow(row);
          if (row !== null) {
            traceRef.current?.scrollToRow(row);
          }
        }}
        traceRef={traceRef}
      />
    </TabFrame>
  );
}

export function SessionDetailsTabDemo() {
  return (
    <TabFrame>
      <SessionDetailsPanel />
    </TabFrame>
  );
}

export function SessionActivityTabDemo() {
  return (
    <TabFrame>
      <SessionActivityPanel />
    </TabFrame>
  );
}
