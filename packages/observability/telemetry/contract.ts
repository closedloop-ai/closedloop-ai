import {
  createEmit,
  type TelemetryEmitChannel,
} from "@closedloop-ai/telemetry-contract/emit";
import { log } from "../log";

/** Logger metadata keys controlled by @repo/observability, not callers. */
export const ReservedLoggerMetadataKey = {
  Origin: "origin",
  Message: "message",
  Level: "level",
  Service: "service",
  Ddsource: "ddsource",
  Ddtags: "ddtags",
  Timestamp: "timestamp",
} as const;

/** Literal union of metadata keys stripped from contract emit payloads. */
export type ReservedLoggerMetadataKey =
  (typeof ReservedLoggerMetadataKey)[keyof typeof ReservedLoggerMetadataKey];

const ReservedLoggerMetadataKeys = new Set<string>(
  Object.values(ReservedLoggerMetadataKey)
);

const telemetryContractLogChannel: TelemetryEmitChannel = {
  info(message, meta) {
    log.info(message, stripReservedLoggerMetadata(meta));
  },
};

/** Typed telemetry-contract emitter bound to the existing log.info channel. */
export const emit = createEmit(telemetryContractLogChannel);

/** Removes reserved logger metadata so payload attributes cannot spoof logs. */
export function stripReservedLoggerMetadata(
  meta: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!ReservedLoggerMetadataKeys.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
