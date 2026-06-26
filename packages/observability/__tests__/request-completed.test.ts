import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import {
  emitRequestCompletedSpan,
  normalizeRequestCompletedUrlPath,
  REQUEST_COMPLETED_CONTRACT_EVENT_NAME,
} from "../telemetry/request-completed";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeRequestCompletedUrlPath", () => {
  it.each([
    ["strips query", "https://api.test/api/loops?token=secret", "/api/loops"],
    [
      "ignores query control characters",
      "https://api.test/api/loops?token=\u0000secret",
      "/api/loops",
    ],
    ["strips fragment", "https://api.test/api/loops#section", "/api/loops"],
    [
      "preserves percent encoding",
      "https://api.test/api/%2Fencoded",
      "/api/%2Fencoded",
    ],
  ])("%s", (_name, requestUrl, expectedPath) => {
    expect(normalizeRequestCompletedUrlPath(requestUrl)).toBe(expectedPath);
  });

  it.each([
    ["embedded full URL", "https://api.test/http://evil.test/a"],
    ["protocol-relative path", "https://api.test//evil.test/a"],
    ["userinfo-like first segment", "https://api.test/user:pass@example.com/a"],
    ["raw control character", "https://api.test/api/\u0000loops"],
    ["parse failure", "not a valid absolute url"],
  ])("falls back for %s", (_name, requestUrl) => {
    expect(normalizeRequestCompletedUrlPath(requestUrl)).toBe("/");
  });
});

describe("emitRequestCompletedSpan", () => {
  it("emits a schema-marked span payload through the log channel", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    emitRequestCompletedSpan({
      requestUrl: "https://api.test/api/loops?token=secret",
      method: "POST",
      statusCode: 201,
      durationMs: 34,
    });

    expect(info).toHaveBeenCalledWith(REQUEST_COMPLETED_CONTRACT_EVENT_NAME, {
      [TelemetryAttribute.HttpRequestMethod]: "POST",
      [TelemetryAttribute.HttpResponseStatusCode]: 201,
      [TelemetryAttribute.UrlPath]: "/api/loops",
      [TelemetryAttribute.DurationMs]: 34,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  it("contains contract emitter failures", () => {
    vi.spyOn(log, "info").mockImplementation((message) => {
      if (message === REQUEST_COMPLETED_CONTRACT_EVENT_NAME) {
        throw new Error("sink unavailable");
      }
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(() =>
      emitRequestCompletedSpan({
        requestUrl: "https://api.test/api/loops",
        method: "GET",
        statusCode: 200,
        durationMs: 1,
      })
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      `${REQUEST_COMPLETED_CONTRACT_EVENT_NAME} emit skipped`,
      expect.objectContaining({
        reason: "emit_failed",
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
  });
});
