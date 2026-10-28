import { logs } from "@opentelemetry/api-logs";
import { normalizeAttributes } from "../../shared/renderer-otel-bridge-utils.js";

/** A telemetry-contract emit channel onto the process-global OTel logger. */
export function createDesktopOtelLogEmitChannel(loggerName: string) {
  return {
    info(message: string, meta: Record<string, unknown>): void {
      logs.getLogger(loggerName).emit({
        eventName: message,
        attributes: normalizeAttributes(meta),
      });
    },
  };
}
