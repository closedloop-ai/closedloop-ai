import { createContext, type ReactNode, useContext } from "react";

export type RendererExceptionReporter = (
  error: Error,
  componentStack?: string
) => void;

/**
 * ISS-8370 D9 — the renderer's ONE exception path, reachable from inside the
 * tree.
 *
 * `main.tsx` owns the OTel runtime as a module local and already hands its
 * `reportException` to `RootErrorBoundary`. This publishes that same function
 * so a boundary mounted deeper — the Settings v2 panel boundary, which catches a
 * crashed panel before it can reach the root — reports through the existing
 * renderer-exception signal rather than growing a second logging path. With no
 * provider (a unit mount, Storybook) the hook reads `undefined`, and a boundary
 * handed nothing simply does not report.
 */
export function RendererExceptionReporterProvider({
  children,
  reportException,
}: {
  children: ReactNode;
  reportException: RendererExceptionReporter;
}) {
  return (
    <RendererExceptionReporterContext value={reportException}>
      {children}
    </RendererExceptionReporterContext>
  );
}

export function useRendererExceptionReporter():
  | RendererExceptionReporter
  | undefined {
  return useContext(RendererExceptionReporterContext);
}

const RendererExceptionReporterContext = createContext<
  RendererExceptionReporter | undefined
>(undefined);
