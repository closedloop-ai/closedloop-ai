import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import {
  buildRequestCompletedContractAttributes,
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

describe("buildRequestCompletedContractAttributes", () => {
  it("returns the schema-marked span attributes for the caller to merge", () => {
    expect(
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/api/loops?token=secret",
        method: "POST",
        statusCode: 201,
        durationMs: 34,
      })
    ).toEqual({
      [TelemetryAttribute.HttpRequestMethod]: "POST",
      [TelemetryAttribute.HttpResponseStatusCode]: 201,
      [TelemetryAttribute.UrlPath]: "/api/loops",
      [TelemetryAttribute.DurationMs]: 34,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  });

  // ISS-5039: the whole point of returning attributes is that no second log
  // line is billed. A future refactor that reinstates an emit() here would
  // silently restore the duplicate event this change removed.
  it("emits no log line of its own", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    buildRequestCompletedContractAttributes({
      requestUrl: "https://api.test/api/loops",
      method: "GET",
      statusCode: 200,
      durationMs: 1,
    });

    expect(info).not.toHaveBeenCalled();
  });

  it("returns undefined when the values fail span-schema validation", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/api/loops",
        method: "GET",
        statusCode: 99,
        durationMs: 1,
      })
    ).toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      `${REQUEST_COMPLETED_CONTRACT_EVENT_NAME} build skipped`,
      expect.objectContaining({
        reason: "schema_validation_failed",
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
  });

  it("contains contract build failures", () => {
    vi.spyOn(SpanTelemetrySchema, "safeParse").mockImplementation(() => {
      throw new Error("validator unavailable");
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(() =>
      buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/api/loops",
        method: "GET",
        statusCode: 200,
        durationMs: 1,
      })
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      `${REQUEST_COMPLETED_CONTRACT_EVENT_NAME} build skipped`,
      expect.objectContaining({
        reason: "build_failed",
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
      })
    );
  });
});
