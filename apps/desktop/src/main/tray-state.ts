import type { CloudSocketStatus } from "./cloud/cloud-protocol.js";
import type { DesktopTray } from "./tray.js";

/**
 * The live signals the tray indicator is derived from, read fresh on each
 * refresh so the tray always reflects current state rather than a snapshot.
 */
export type TrayStateInputs = {
  tray: DesktopTray;
  gatewayHealthy: boolean;
  getActivePort: () => number;
  agentMonitorFailed: boolean;
  agentMonitorFailureReason: string | null;
  cloudCommandsPaused: boolean;
  cloudStatus: CloudSocketStatus;
};

/**
 * Recompute the tray indicator from the current gateway/monitor/cloud state.
 *
 * Severity order is deliberate and load-bearing: a down gateway outranks a
 * permanently-failed agent monitor, which outranks a user pause, which outranks
 * the cloud link state. `explicitDetails`, when given, replaces the derived
 * detail string but never the derived severity.
 */
export function refreshDesktopTrayState(
  inputs: TrayStateInputs,
  explicitDetails?: string
): void {
  const port = inputs.getActivePort();
  if (!inputs.gatewayHealthy) {
    inputs.tray.setState(
      "error",
      explicitDetails ?? `Gateway down on port ${port}`
    );
    return;
  }

  // A permanently-failed agent monitor keeps the tray degraded even when cloud
  // is online/connecting (gateway-down above remains the higher-severity signal).
  if (inputs.agentMonitorFailed) {
    inputs.tray.setState(
      "degraded",
      explicitDetails ??
        inputs.agentMonitorFailureReason ??
        `Serving on localhost:${port} | agent monitor unavailable`
    );
    return;
  }

  if (inputs.cloudCommandsPaused) {
    inputs.tray.setState(
      "degraded",
      explicitDetails ?? `Serving on localhost:${port} | cloud commands paused`
    );
    return;
  }

  if (inputs.cloudStatus.state === "online") {
    inputs.tray.setState(
      "ready",
      explicitDetails ??
        `Serving on localhost:${port} | cloud: online (${inputs.cloudStatus.targetId})`
    );
    return;
  }

  if (inputs.cloudStatus.state === "degraded") {
    inputs.tray.setState(
      "degraded",
      explicitDetails ??
        `Serving on localhost:${port} | cloud degraded: ${inputs.cloudStatus.error}`
    );
    return;
  }

  inputs.tray.setState(
    "ready",
    explicitDetails ?? `Serving on localhost:${port} | cloud: connecting`
  );
}
