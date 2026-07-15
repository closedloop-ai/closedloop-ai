import { createContext, type ReactNode, useContext } from "react";
import type { RenderCommitEvent } from "../../../shared/render-commit-event";

// FEA-1998: makes the renderer OTel runtime's `reportRenderCommit` reachable to
// the instrumented session views without prop-drilling. `renderer/main.tsx`
// seeds the provider from the runtime singleton (the single construction site);
// the default is a no-op so the views render safely with no provider (tests,
// or a renderer where the runtime never started).

export type RenderCommitReporter = (event: RenderCommitEvent) => void;

const noopRenderCommitReporter: RenderCommitReporter = () => {};

const RenderCommitTelemetryContext = createContext<RenderCommitReporter>(
  noopRenderCommitReporter
);

export function RenderCommitTelemetryProvider({
  reportRenderCommit,
  children,
}: {
  reportRenderCommit: RenderCommitReporter;
  children: ReactNode;
}) {
  return (
    <RenderCommitTelemetryContext.Provider value={reportRenderCommit}>
      {children}
    </RenderCommitTelemetryContext.Provider>
  );
}

export function useRenderCommitReporter(): RenderCommitReporter {
  return useContext(RenderCommitTelemetryContext);
}
