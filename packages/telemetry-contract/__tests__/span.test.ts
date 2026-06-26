import { describe, expect, it } from "vitest";
import {
  DeprecatedCodeTelemetryAttributes,
  TelemetryAttribute,
} from "../src/attributes";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import { SpanTelemetrySchema } from "../src/span";
import { spanPayload } from "../src/test-fixtures";

const NON_BMP_CHARACTER = String.fromCodePoint(0x1_f9_ea);

describe("SpanTelemetrySchema", () => {
  it("accepts valid HTTP, code, error, and duration attributes", () => {
    expect(
      SpanTelemetrySchema.parse({
        [TelemetryAttribute.HttpRequestMethod]: "POST",
        [TelemetryAttribute.HttpResponseStatusCode]: 201,
        [TelemetryAttribute.UrlPath]: "/api/loops",
        [TelemetryAttribute.DurationMs]: 25,
        [TelemetryAttribute.CodeFunctionName]: "createLoop",
        [TelemetryAttribute.CodeFilePath]: "apps/api/route.ts",
        [TelemetryAttribute.CodeLineNumber]: 12,
        [TelemetryAttribute.CodeColumnNumber]: 4,
        [TelemetryAttribute.ErrorType]: "ValidationError",
      })
    ).toMatchObject({
      [TelemetryAttribute.UrlPath]: "/api/loops",
    });
  });

  it("rejects invalid HTTP status, duration, path, and unknown attributes", () => {
    for (const payload of [
      spanPayload({ [TelemetryAttribute.HttpResponseStatusCode]: 99 }),
      spanPayload({ [TelemetryAttribute.HttpResponseStatusCode]: 600 }),
      spanPayload({ [TelemetryAttribute.DurationMs]: -1 }),
      spanPayload({ [TelemetryAttribute.DurationMs]: 86_400_001 }),
      spanPayload({ [TelemetryAttribute.DurationMs]: 1.2 }),
      spanPayload({ [TelemetryAttribute.DurationMs]: Number.NaN }),
      spanPayload({
        [TelemetryAttribute.DurationMs]: Number.POSITIVE_INFINITY,
      }),
      spanPayload({ [TelemetryAttribute.UrlPath]: "https://example.com/a" }),
      spanPayload({ [TelemetryAttribute.UrlPath]: "//example.com/a" }),
      spanPayload({
        [TelemetryAttribute.UrlPath]: "/user:pass@example.com/a",
      }),
      spanPayload({ [TelemetryAttribute.UrlPath]: "/a?b=1" }),
      spanPayload({ [TelemetryAttribute.UrlPath]: "/a#b" }),
      spanPayload({ [TelemetryAttribute.UrlPath]: "/a\nb" }),
      spanPayload({ "http.request.body.size": 10 }),
      spanPayload({ "http.response.body.size": 10 }),
    ]) {
      expect(SpanTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });

  it("accepts path segments with @ before : because they are not userinfo", () => {
    expect(
      SpanTelemetrySchema.safeParse(
        spanPayload({
          [TelemetryAttribute.UrlPath]: "/user@domain:3000/path",
        })
      ).success
    ).toBe(true);
  });

  it("counts URL path length with Unicode code point semantics", () => {
    expect(
      SpanTelemetrySchema.safeParse(
        spanPayload({
          [TelemetryAttribute.UrlPath]: `/${NON_BMP_CHARACTER.repeat(
            TelemetryTextMaxLength.UrlPath - 1
          )}`,
        })
      ).success
    ).toBe(true);
    expect(
      SpanTelemetrySchema.safeParse(
        spanPayload({
          [TelemetryAttribute.UrlPath]: `/${NON_BMP_CHARACTER.repeat(
            TelemetryTextMaxLength.UrlPath
          )}`,
        })
      ).success
    ).toBe(false);
  });

  it("rejects deprecated experimental code aliases", () => {
    for (const attribute of Object.values(DeprecatedCodeTelemetryAttributes)) {
      expect(
        SpanTelemetrySchema.safeParse(spanPayload({ [attribute]: "x" })).success
      ).toBe(false);
    }
  });
});
