import type { AgentHookListener } from "../agent-monitor/agent-monitor-listener.js";
import type { OtlpHttpReceiver } from "../telemetry/otlp-http-receiver.js";
import type { AgentDashboardRuntimeLifecycle } from "./agent-dashboard-runtime-lifecycle.js";

/** Called only by the consent-gated collector start. Mesh owns no second gate. */
export function startAgentCaptureReceivers(options: {
  lifecycle: Pick<
    AgentDashboardRuntimeLifecycle,
    "ensureStarted" | "isCurrentStart"
  >;
  golden: boolean;
  hookListener: Pick<
    AgentHookListener,
    "start" | "isReady" | "publishEphemeralPort"
  >;
  otlpReceiver: Pick<OtlpHttpReceiver, "start">;
  onSessionMeshReady?: () => void;
  reconcileSessionMeshHooks: () => void;
  log: (message: string) => void;
}): Promise<void> {
  return options.lifecycle.ensureStarted(() => {
    if (options.golden) {
      return Promise.resolve();
    }
    const hookReady = options.hookListener.start().then(() => {
      if (
        options.lifecycle.isCurrentStart(pendingStart) &&
        options.hookListener.isReady()
      ) {
        options.hookListener.publishEphemeralPort();
        options.onSessionMeshReady?.();
      }
    });
    const otlpReady = options.otlpReceiver
      .start()
      .then(async (state) => {
        if (!state.available) {
          options.log(`OTLP receiver unavailable: ${state.reason}`);
          return;
        }
        await hookReady;
        if (
          options.lifecycle.isCurrentStart(pendingStart) &&
          options.hookListener.isReady()
        ) {
          // Hook binding may win the race and install while OTLP is unavailable.
          // Reconcile again with the now-published Codex OTLP endpoint.
          options.reconcileSessionMeshHooks();
        }
      })
      .catch((error: unknown) => {
        options.log(`OTLP receiver unavailable: ${String(error)}`);
      });
    const pendingStart = Promise.all([hookReady, otlpReady]).then(
      () => undefined
    );
    return pendingStart;
  });
}
