import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import type { SpanTelemetry } from "@closedloop-ai/telemetry-contract/span";
import { SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";
import { spanPayload } from "@closedloop-ai/telemetry-contract/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import { emit, ReservedLoggerMetadataKey } from "../telemetry/contract";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telemetry contract observability adapter", () => {
  it("calls the existing log.info channel with span metadata", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const attributes = SpanTelemetrySchema.parse(spanPayload());

    emit(TelemetrySchemaName.Span, {
      name: "http.request",
      attributes,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("http.request", {
      ...attributes,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  it("strips reserved logger metadata before invoking log.info", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const attributes = {
      ...SpanTelemetrySchema.parse(spanPayload()),
      [ReservedLoggerMetadataKey.Origin]: "spoofed",
      [ReservedLoggerMetadataKey.Level]: "error",
    } as SpanTelemetry;

    emit(TelemetrySchemaName.Span, {
      name: "http.request",
      attributes,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "http.request",
      expect.objectContaining({
        [TelemetryAttribute.HttpRequestMethod]: "GET",
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
    const metadata = info.mock.calls[0]?.[1];
    expect(metadata).not.toHaveProperty(ReservedLoggerMetadataKey.Origin);
    expect(metadata).not.toHaveProperty(ReservedLoggerMetadataKey.Level);
  });
});
