import {
  parseRendererOtelBridgePayload,
  type RendererOtelBridgeParseResult,
} from "../shared/renderer-otel-bridge.js";
import {
  RENDERER_OTEL_RATE_LIMIT_MAX_BATCHES,
  RENDERER_OTEL_RATE_LIMIT_WINDOW_MS,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants.js";
import type { DesktopOtelRuntime } from "./app-otel-runtime.js";

export type RendererOtelExportDeps = {
  isTrustedSender: (sender: unknown) => boolean;
  runtime: DesktopOtelRuntime;
  now?: () => number;
  parsePayload?: (payload: unknown) => RendererOtelBridgeParseResult;
};

type RendererOtelExportEvent = { sender: unknown };

export function createRendererOtelExportHandler(deps: RendererOtelExportDeps) {
  const now = deps.now ?? Date.now;
  const parsePayload = deps.parsePayload ?? parseRendererOtelBridgePayload;
  const rateLimit = createRendererOtelRateLimit(now);

  return (
    event: RendererOtelExportEvent,
    payload: unknown
  ): RendererOtelExportResult => {
    if (!deps.isTrustedSender(event.sender)) {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.UntrustedSender,
      };
    }

    if (!rateLimit.tryEnter()) {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.RateLimited,
      };
    }

    try {
      const parsed = parsePayload(payload);
      if (!parsed.ok) {
        return parsed.result;
      }
      return deps.runtime.exportExternalRecords(parsed.payload.records);
    } catch {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.ExportFailed,
      };
    }
  };
}

function createRendererOtelRateLimit(now: () => number) {
  let windowStartedAt = 0;
  let acceptedInWindow = 0;

  return {
    // The IPC export handler is synchronous and Electron processes each
    // ipcMain message as a separate event-loop task, so there is never more
    // than one export in flight; a window-based cap is the only meaningful
    // rate limit here.
    tryEnter() {
      const currentTime = now();
      if (currentTime - windowStartedAt >= RENDERER_OTEL_RATE_LIMIT_WINDOW_MS) {
        windowStartedAt = currentTime;
        acceptedInWindow = 0;
      }
      if (acceptedInWindow >= RENDERER_OTEL_RATE_LIMIT_MAX_BATCHES) {
        return false;
      }
      acceptedInWindow += 1;
      return true;
    },
  };
}
