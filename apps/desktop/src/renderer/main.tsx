import { DesignSystemProvider } from "@closedloop-ai/design-system";
import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import "@closedloop-ai/design-system/styles/globals.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./globals.css";
import { RendererReadyPhase } from "../shared/renderer-ready-phase";
import App from "./App";
import { createRendererOtelRuntime } from "./app-otel-runtime";
import { RenderCommitTelemetryProvider } from "./components/sessions/render-commit-telemetry-context";
import { registerMainEntrypointExceptionCapture } from "./main-entrypoint-exception-capture";
import { RootErrorBoundary } from "./root-error-boundary";
import { DesktopAppCoreProvider } from "./shared-agent-sessions/desktop-app-core-provider";

const rendererOtelRuntime = createRendererOtelRuntime({
  exportTelemetry: window.desktopApi.exportOtelTelemetry,
});

registerMainEntrypointExceptionCapture(rendererOtelRuntime);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

rendererOtelRuntime.start().catch(() => undefined);

createRoot(rootElement).render(
  <StrictMode>
    <DesignSystemProvider
      attribute="class"
      defaultTheme="light"
      disableTransitionOnChange
      enableSystem
    >
      <RootErrorBoundary
        reportException={(error, componentStack) =>
          rendererOtelRuntime.reportException({ error, componentStack })
        }
      >
        <DesktopAppCoreProvider>
          <RenderCommitTelemetryProvider
            reportRenderCommit={(event) =>
              rendererOtelRuntime.reportRenderCommit(event)
            }
          >
            <App />
            <RendererReadySignal />
          </RenderCommitTelemetryProvider>
        </DesktopAppCoreProvider>
      </RootErrorBoundary>
    </DesignSystemProvider>
  </StrictMode>
);

let rendererReadyNotified = false;

function RendererReadySignal() {
  useLayoutEffect(() => {
    if (rendererReadyNotified) {
      return;
    }

    rendererReadyNotified = true;
    // ISS-5346: the MOUNTED phase — this effect runs after React commits the
    // first render, so it is the signal the initial window reveal waits for.
    // `renderer-ready-signal.ts` already sent the pre-mount `Shell` phase, which
    // only arms the (bounded) wait.
    window.desktopApi.notifyRendererReady(RendererReadyPhase.Mounted);
  }, []);

  return null;
}
