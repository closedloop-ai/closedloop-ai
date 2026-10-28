import { DEAD_END_TELEMETRY_CHANNEL } from "../../shared/dead-end-telemetry-contract.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const DeadEndTelemetryIpcChannel = {
  RecordDeadEnd: DEAD_END_TELEMETRY_CHANNEL,
} as const;

export type DeadEndTelemetryIpcChannel =
  (typeof DeadEndTelemetryIpcChannel)[keyof typeof DeadEndTelemetryIpcChannel];

type IpcMainLike = {
  handle: (
    channel: DeadEndTelemetryIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type DeadEndTelemetryIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /** Whether the record was taken. Optional: no runtime ⇒ nothing reported. */
  recordDeadEndTelemetry?: (payload: unknown) => boolean;
};

/**
 * ISS-7249: renderer→main channel for dead-end records. Sender trust is the
 * boundary; the recorder re-parses behind it, because a process boundary is
 * where the types stop constraining the value.
 */
export function registerDeadEndTelemetryIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DeadEndTelemetryIpcDeps
): void {
  ipcMainLike.handle(
    DeadEndTelemetryIpcChannel.RecordDeadEnd,
    (event, rawPayload) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      // Whether the record was TAKEN, not merely that the channel was reached:
      // a flat `ok: true` over a rejected payload is the confident value that
      // makes a dropped signal look delivered.
      return { ok: deps.recordDeadEndTelemetry?.(rawPayload) ?? false };
    }
  );
}
