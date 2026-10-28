import { describe, expect, it } from "vitest";
import {
  ApiSpanTelemetryAttributes,
  CodeSpanTelemetryAttributes,
  CompatibilitySpanTelemetryAttributes,
  DeprecatedCodeTelemetryAttributes,
  ErrorSpanTelemetryAttributes,
  HttpSpanTelemetryAttributes,
  TelemetryAttribute,
} from "../src/attributes";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import {
  MAX_SPAN_LINKS,
  MAX_SPAN_NAME_LENGTH,
  MAX_SPAN_STATUS_MESSAGE_LENGTH,
  SpanEnvelopeSchema,
  SpanErrorSource,
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

  it("accepts the cl-api request attribution attributes", () => {
    expect(
      SpanTelemetrySchema.parse(
        spanPayload({
          [TelemetryAttribute.AppOrganizationId]:
            "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
          [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
          [TelemetryAttribute.ArtifactType]: "IMPLEMENTATION_PLAN",
          [TelemetryAttribute.ArtifactStatus]: "IN_REVIEW",
          [TelemetryAttribute.ErrorType]: "PrismaClientKnownRequestError.P2002",
        })
      )
    ).toMatchObject({
      [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
      [TelemetryAttribute.ArtifactType]: "IMPLEMENTATION_PLAN",
    });
  });

  /**
   * ISS-7217: the span rides the keyless lane, so an error MESSAGE has to be
   * unrepresentable in the contract, not merely discouraged in the producer.
   * Each string below is a shape a real 5xx message takes — prose, a path, a
   * query string, an address, a title — and every one needs a character
   * `error.type`'s identifier shape (or the artifact attributes' uppercase
   * token shape) forbids.
   */
  it("makes an error message and a free-text artifact label unrepresentable", () => {
    for (const payload of [
      spanPayload({
        [TelemetryAttribute.ErrorType]: "Invalid document id supplied",
      }),
      spanPayload({
        [TelemetryAttribute.ErrorType]: "ENOENT:/srv/app/secrets.json",
      }),
      spanPayload({
        [TelemetryAttribute.ErrorType]: "BadRequest?token=sk_live_abc",
      }),
      spanPayload({
        [TelemetryAttribute.ErrorType]: "Rejected@example.com",
      }),
      spanPayload({ [TelemetryAttribute.ArtifactType]: "My Draft PRD" }),
      spanPayload({ [TelemetryAttribute.ArtifactStatus]: "in-review" }),
      spanPayload({ [TelemetryAttribute.AppErrorSource]: "database" }),
    ]) {
      expect(SpanTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });

  it("accepts the authenticated user id as a UUID", () => {
    expect(
      SpanTelemetrySchema.parse(
        spanPayload({
          [TelemetryAttribute.UserId]: "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
        })
      )
    ).toMatchObject({
      [TelemetryAttribute.UserId]: "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
    });
  });

  /**
   * ISS-8748: the span rides the keyless lane, so a personal identifier has to
   * be unrepresentable in the contract rather than merely discouraged in the
   * producer. Each string below is what a caller reaches for when it wants to
   * name a person — an address, a display name, the Clerk id, a bare database
   * label — and the UUID shape is what refuses all of them.
   */
  it("makes an email, a name, and a Clerk id unrepresentable as the user id", () => {
    for (const value of [
      "owner@example.com",
      "Ada Lovelace",
      "user_2abcDEFghiJKLmnoPQRstu",
      "user-1",
      "",
      "019c24db-a261-738f-8eff-ea275fb2747",
    ]) {
      expect(
        SpanTelemetrySchema.safeParse(
          spanPayload({ [TelemetryAttribute.UserId]: value })
        ).success,
        value
      ).toBe(false);
    }
  });

  it("accepts the caller-attested Desktop install and build", () => {
    expect(
      SpanTelemetrySchema.parse(
        spanPayload({
          [TelemetryAttribute.AppInstallationId]:
            "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
          [TelemetryAttribute.AppClientVersion]: "1.24.3",
        })
      )
    ).toMatchObject({
      [TelemetryAttribute.AppInstallationId]:
        "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
      [TelemetryAttribute.AppClientVersion]: "1.24.3",
    });
  });

  it("bounds the attested client build and rejects control characters", () => {
    for (const value of [
      "",
      "1.24.3\n",
      "a".repeat(TelemetryTextMaxLength.AppClientVersion + 1),
    ]) {
      expect(
        SpanTelemetrySchema.safeParse(
          spanPayload({ [TelemetryAttribute.AppClientVersion]: value })
        ).success,
        value
      ).toBe(false);
    }
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

  /**
   * Absolute literals, deliberately not derived. Every boundary fixture below
   * re-derives its length from these constants, so widening a bound moves both
   * sides of the comparison at once and leaves those cases green; this is the
   * only case that reddens.
   */
  it("pins the envelope bounds to their contract values", () => {
    expect(MAX_SPAN_NAME_LENGTH).toBe(256);
    expect(MAX_SPAN_STATUS_MESSAGE_LENGTH).toBe(1024);
    expect(MAX_SPAN_LINKS).toBe(32);
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

  it("accepts links at exactly the cap", () => {
    expect(
      SpanEnvelopeSchema.safeParse(
        spanEnvelopePayload({ links: spanLinks(MAX_SPAN_LINKS) })
      ).success
    ).toBe(true);
  });

  it("rejects oversized links, malformed link ids, link attributes, and unknown link keys", () => {
    for (const payload of [
      spanEnvelopePayload({ links: spanLinks(MAX_SPAN_LINKS + 1) }),
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

/**
 * ISS-7227: the five per-schema groups must together advertise exactly what the
 * span schema admits, the same exact-set parity `SyncTelemetryAttributes`
 * carries (`sync.test.ts`).
 *
 * The existing semconv guards only require an attribute to sit in AT LEAST ONE
 * group, so an attribute already grouped under another schema — `sync.batch_id`
 * is in `SyncTelemetryAttributes` — could be added to `SpanTelemetrySchema` and
 * left out of `ApiSpanTelemetryAttributes` with nothing red. That is drift a
 * consumer of the published inventory reads as "a cl-api request span cannot
 * carry this", while the emitter stamps it.
 */
describe("span attribute group inventory", () => {
  it("advertises exactly the key set SpanTelemetrySchema admits", () => {
    expect(
      new Set<string>([
        ...HttpSpanTelemetryAttributes,
        ...CompatibilitySpanTelemetryAttributes,
        ...CodeSpanTelemetryAttributes,
        ...ErrorSpanTelemetryAttributes,
        ...ApiSpanTelemetryAttributes,
      ])
    ).toEqual(new Set(Object.keys(SpanTelemetrySchema.shape)));
  });

  it("names the sync join key, so the published inventory is not a stale answer", () => {
    // A literal, not `TelemetryAttribute.SyncBatchId`: a deleted enum member
    // evaluates to `undefined` on BOTH sides of a reference-based comparison,
    // which is the assertion shape that cannot fail.
    expect(new Set<string>(ApiSpanTelemetryAttributes)).toContain(
      "sync.batch_id"
    );
  });
});

/**
 * Link ids are numbered from 1 so no generated id collides with the all-zero
 * trace or span id, which the schema rejects on its own — a cap fixture built
 * from index 0 would be refused for the wrong reason.
 */
function spanLinks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    trace_id: (index + 1).toString(16).padStart(32, "0"),
    span_id: (index + 1).toString(16).padStart(16, "0"),
  }));
}
