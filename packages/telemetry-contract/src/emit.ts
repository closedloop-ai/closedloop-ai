import type { TelemetrySchemaName } from "./schema-name";
import type { TelemetryEmitFunction } from "./schema-shape";

/** Metadata key stamped onto every emitted log payload with the schema name. */
export const TelemetryEmitMetadataKey = {
  SchemaName: "telemetry.schema_name",
} as const;

/** Literal union of metadata keys reserved by the telemetry emit helper. */
export type TelemetryEmitMetadataKey =
  (typeof TelemetryEmitMetadataKey)[keyof typeof TelemetryEmitMetadataKey];

/** Minimal sink contract used by typed emitters to avoid owning transport. */
export type TelemetryEmitChannel = {
  info(message: string, meta: Record<string, unknown>): void;
};

/** Raised by direct emit() when no process-wide channel is configured. */
export class TelemetryEmitChannelNotConfiguredError extends Error {
  constructor() {
    super("Telemetry emit channel is not configured");
    this.name = "TelemetryEmitChannelNotConfiguredError";
  }
}

let configuredTelemetryEmitChannel: TelemetryEmitChannel | null = null;

/** Creates a typed emitter bound to an injected channel without validation. */
export function createEmit(
  channel: TelemetryEmitChannel
): TelemetryEmitFunction {
  return (schemaName, payload) => {
    emitToChannel(channel, schemaName, payload.name, payload.attributes);
  };
}

/** Configures the process-wide channel used by direct emit(). */
export function configureTelemetryEmitChannel(
  channel: TelemetryEmitChannel | null
): void {
  configuredTelemetryEmitChannel = channel;
}

/** Emits through the configured channel; callers must validate beforehand. */
export const emit: TelemetryEmitFunction = (schemaName, payload) => {
  if (!configuredTelemetryEmitChannel) {
    throw new TelemetryEmitChannelNotConfiguredError();
  }
  emitToChannel(
    configuredTelemetryEmitChannel,
    schemaName,
    payload.name,
    payload.attributes
  );
};

function emitToChannel(
  channel: TelemetryEmitChannel,
  schemaName: TelemetrySchemaName,
  message: string,
  attributes: Record<string, unknown>
): void {
  channel.info(message, {
    ...attributes,
    [TelemetryEmitMetadataKey.SchemaName]: schemaName,
  });
}
