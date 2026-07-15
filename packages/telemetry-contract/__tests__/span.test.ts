import { describe, expect, it } from "vitest";
import {
  DeprecatedCodeTelemetryAttributes,
  TelemetryAttribute,
} from "../src/attributes";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import {
  MAX_SPAN_NAME_LENGTH,
  MAX_SPAN_STATUS_MESSAGE_LENGTH,
  SpanEnvelopeSchema,
  SpanKind,
  SpanStatusCode,
  SpanTelemetrySchema,
} from "../src/span";
import { spanEnvelopePayload, spanPayload } from "../src/test-fixtures";

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

describe("SpanEnvelopeSchema", () => {
  it("accepts valid root and child envelopes with bounded links", () => {
    expect(SpanEnvelopeSchema.parse(spanEnvelopePayload())).toMatchObject({
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      name: "http.request",
    });

    expect(
      SpanEnvelopeSchema.parse(
        spanEnvelopePayload({
          parent_span_id: "1111111111111111",
          kind: SpanKind.Client,
          status: {
            code: SpanStatusCode.Error,
            message: "failed",
          },
          links: [
            {
              trace_id: "22222222222222222222222222222222",
              span_id: "3333333333333333",
            },
          ],
        })
      )
    ).toMatchObject({
      parent_span_id: "1111111111111111",
      links: [{ span_id: "3333333333333333" }],
    });
  });

  it("rejects malformed ids, invalid kind/status, null parent, and unknown keys", () => {
    for (const payload of [
      spanEnvelopePayload({ trace_id: "0123456789abcdef" }),
      spanEnvelopePayload({ trace_id: "0123456789ABCDEF0123456789ABCDEF" }),
      spanEnvelopePayload({
        trace_id: "00000000000000000000000000000000",
      }),
      spanEnvelopePayload({ span_id: "0123456789abcde" }),
      spanEnvelopePayload({ span_id: "0000000000000000" }),
      spanEnvelopePayload({ parent_span_id: "0000000000000000" }),
      spanEnvelopePayload({ parent_span_id: null }),
      spanEnvelopePayload({ kind: "remote" }),
      spanEnvelopePayload({ status: { code: "failed" } }),
      spanEnvelopePayload({ status: { code: SpanStatusCode.Ok, raw: "x" } }),
      spanEnvelopePayload({ duration_ms: -1 }),
      spanEnvelopePayload({ duration_ms: 1.5 }),
      spanEnvelopePayload({ name: "http\nrequest" }),
      spanEnvelopePayload({ unexpected: true }),
    ]) {
      expect(SpanEnvelopeSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("accepts max-boundary name and status message text", () => {
    expect(
      SpanEnvelopeSchema.safeParse(
        spanEnvelopePayload({
          name: "n".repeat(MAX_SPAN_NAME_LENGTH),
          status: {
            code: SpanStatusCode.Error,
            message: "m".repeat(MAX_SPAN_STATUS_MESSAGE_LENGTH),
          },
        })
      ).success
    ).toBe(true);
  });

  it("rejects overlong name and status message text", () => {
    for (const payload of [
      spanEnvelopePayload({ name: "n".repeat(MAX_SPAN_NAME_LENGTH + 1) }),
      spanEnvelopePayload({
        status: {
          code: SpanStatusCode.Error,
          message: "m".repeat(MAX_SPAN_STATUS_MESSAGE_LENGTH + 1),
        },
      }),
    ]) {
      expect(SpanEnvelopeSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("rejects oversized links, malformed link ids, link attributes, and unknown link keys", () => {
    const links = Array.from({ length: 33 }, (_, index) => ({
      trace_id: `${index.toString(16).padStart(32, "0")}`,
      span_id: `${index.toString(16).padStart(16, "0")}`,
    }));

    for (const payload of [
      spanEnvelopePayload({ links }),
      spanEnvelopePayload({
        links: [{ trace_id: "bad", span_id: "0123456789abcdef" }],
      }),
      spanEnvelopePayload({
        links: [
          {
            trace_id: "00000000000000000000000000000000",
            span_id: "0123456789abcdef",
          },
        ],
      }),
      spanEnvelopePayload({
        links: [
          {
            trace_id: "0123456789abcdef0123456789abcdef",
            span_id: "bad",
          },
        ],
      }),
      spanEnvelopePayload({
        links: [
          {
            trace_id: "0123456789abcdef0123456789abcdef",
            span_id: "0000000000000000",
          },
        ],
      }),
      spanEnvelopePayload({
        links: [
          {
            trace_id: "0123456789abcdef0123456789abcdef",
            span_id: "0123456789abcdef",
            attributes: { secret: "value" },
          },
        ],
      }),
      spanEnvelopePayload({
        links: [
          {
            trace_id: "0123456789abcdef0123456789abcdef",
            span_id: "0123456789abcdef",
            state: "linked",
          },
        ],
      }),
    ]) {
      expect(SpanEnvelopeSchema.safeParse(payload).success).toBe(false);
    }
  });
});
