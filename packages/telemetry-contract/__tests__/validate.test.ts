import { describe, expect, it } from "vitest";
import { TelemetryAttribute } from "../src/attributes";
import { TelemetrySchemaName } from "../src/schema-name";
import {
  appPayload,
  genAiPayload,
  permissionPayload,
  spanEnvelopePayload,
  spanPayload,
  syncPayload,
} from "../src/test-fixtures";
import {
  type SpanEnvelopeValidationResult,
  type TelemetryValidationFailure,
  TelemetryValidationIssueCode,
  type TelemetryValidationResult,
  validate,
  validateSpanEnvelope,
} from "../src/validate";

const UnknownTelemetryAttribute = {
  NotInSchema: "not.in.schema",
  AlsoNotInSchema: "also.not.in.schema",
  ServiceInstanceId: "service.instance.id",
} as const;

const SimilarTelemetrySchemaName = {
  Spans: "spans",
} as const;

const RawSecretValue = {
  ApiKey: "secret-api-key",
} as const;

const LongUnknownAttributeName = `${"secret.".repeat(20)}token`;
const ControlCharacterUnknownAttributeName = "bad\u0001attribute";

describe("validate", () => {
  it("returns typed success for app, resource, span, gen_ai, sync, and permission payloads", () => {
    const app = validate(appPayload(), TelemetrySchemaName.App);
    const resource = validate(
      {
        [TelemetryAttribute.ServiceName]: "cl-api",
      },
      TelemetrySchemaName.Resource
    );
    const span = validate(spanPayload(), TelemetrySchemaName.Span);
    const genAi = validate(genAiPayload(), TelemetrySchemaName.GenAi);
    const sync = validate(syncPayload(), TelemetrySchemaName.Sync);
    const permission = validate(
      permissionPayload(),
      TelemetrySchemaName.Permission
    );

    expect(app).toMatchObject({
      ok: true,
      value: {
        [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
      },
    });
    expect(resource).toEqual({
      ok: true,
      value: {
        [TelemetryAttribute.ServiceName]: "cl-api",
      },
    });
    expect(span).toMatchObject({
      ok: true,
      value: {
        [TelemetryAttribute.HttpRequestMethod]: "GET",
      },
    });
    expect(genAi).toMatchObject({
      ok: true,
      value: {
        [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
      },
    });
    expect(sync).toMatchObject({
      ok: true,
      value: {
        [TelemetryAttribute.SyncEvent]: "batch",
      },
    });
    expect(permission).toMatchObject({
      ok: true,
      value: {
        [TelemetryAttribute.GenAiPermissionDecision]: "allow",
      },
    });
  });

  it("returns safe permission validation failures", () => {
    const wrongType = expectInvalid(
      validate(
        permissionPayload({
          [TelemetryAttribute.GenAiPermissionDecision]: RawSecretValue.ApiKey,
        }),
        TelemetrySchemaName.Permission
      )
    );
    const unknown = expectInvalid(
      validate(
        permissionPayload({
          [UnknownTelemetryAttribute.NotInSchema]: RawSecretValue.ApiKey,
        }),
        TelemetrySchemaName.Permission
      )
    );

    expect(wrongType.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Permission,
        path: [TelemetryAttribute.GenAiPermissionDecision],
        attributePath: TelemetryAttribute.GenAiPermissionDecision,
      }),
    ]);
    expect(unknown.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Permission,
        path: [UnknownTelemetryAttribute.NotInSchema],
        attributePath: UnknownTelemetryAttribute.NotInSchema,
        code: TelemetryValidationIssueCode.UnrecognizedKeys,
      }),
    ]);
    expect(
      JSON.stringify([...wrongType.errors, ...unknown.errors])
    ).not.toContain(RawSecretValue.ApiKey);
  });

  it("returns structured failures for missing required fields and wrong primitive types", () => {
    const missing = expectInvalid(validate({}, TelemetrySchemaName.Resource));
    const wrongType = expectInvalid(
      validate(
        {
          [TelemetryAttribute.ServiceName]: RawSecretValue.ApiKey,
          [TelemetryAttribute.ServiceVersion]: false,
        },
        TelemetrySchemaName.Resource
      )
    );

    expect(missing.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Resource,
        path: [TelemetryAttribute.ServiceName],
        attributePath: TelemetryAttribute.ServiceName,
        code: "invalid_type",
      }),
    ]);
    expect(wrongType.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Resource,
        path: [TelemetryAttribute.ServiceVersion],
        attributePath: TelemetryAttribute.ServiceVersion,
        code: "invalid_type",
      }),
    ]);
    expect(JSON.stringify(wrongType.errors)).not.toContain(
      RawSecretValue.ApiKey
    );
  });

  it("returns safe app validation failures", () => {
    const wrongType = expectInvalid(
      validate(
        appPayload({
          [TelemetryAttribute.AppInstallationId]: RawSecretValue.ApiKey,
          [TelemetryAttribute.AppExceptionOrigin]: "worker",
        }),
        TelemetrySchemaName.App
      )
    );
    const unknown = expectInvalid(
      validate(
        appPayload({
          [UnknownTelemetryAttribute.NotInSchema]: RawSecretValue.ApiKey,
        }),
        TelemetrySchemaName.App
      )
    );

    expect(wrongType.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.App,
        path: [TelemetryAttribute.AppExceptionOrigin],
        attributePath: TelemetryAttribute.AppExceptionOrigin,
        code: "invalid_value",
      }),
    ]);
    expect(unknown.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.App,
        path: [UnknownTelemetryAttribute.NotInSchema],
        attributePath: UnknownTelemetryAttribute.NotInSchema,
        code: TelemetryValidationIssueCode.UnrecognizedKeys,
      }),
    ]);
    expect(
      JSON.stringify([...wrongType.errors, ...unknown.errors])
    ).not.toContain(RawSecretValue.ApiKey);
  });

  it("returns one safe error per unknown attribute", () => {
    const result = expectInvalid(
      validate(
        spanPayload({
          [UnknownTelemetryAttribute.NotInSchema]: RawSecretValue.ApiKey,
          [UnknownTelemetryAttribute.AlsoNotInSchema]: 1,
        }),
        TelemetrySchemaName.Span
      )
    );

    expect(result.errors).toEqual([
      {
        schemaName: TelemetrySchemaName.Span,
        path: [UnknownTelemetryAttribute.NotInSchema],
        attributePath: UnknownTelemetryAttribute.NotInSchema,
        code: TelemetryValidationIssueCode.UnrecognizedKeys,
        message: expect.any(String),
      },
      {
        schemaName: TelemetrySchemaName.Span,
        path: [UnknownTelemetryAttribute.AlsoNotInSchema],
        attributePath: UnknownTelemetryAttribute.AlsoNotInSchema,
        code: TelemetryValidationIssueCode.UnrecognizedKeys,
        message: expect.any(String),
      },
    ]);
    expect(JSON.stringify(result.errors)).not.toContain(RawSecretValue.ApiKey);
  });

  it("returns safe sync validation failures", () => {
    const wrongType = expectInvalid(
      validate(
        syncPayload({
          [TelemetryAttribute.SyncPayloadBytes]: RawSecretValue.ApiKey,
        }),
        TelemetrySchemaName.Sync
      )
    );
    const unknown = expectInvalid(
      validate(
        syncPayload({
          [UnknownTelemetryAttribute.NotInSchema]: RawSecretValue.ApiKey,
        }),
        TelemetrySchemaName.Sync
      )
    );

    expect(wrongType.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Sync,
        path: [TelemetryAttribute.SyncPayloadBytes],
        attributePath: TelemetryAttribute.SyncPayloadBytes,
        code: "invalid_type",
      }),
    ]);
    expect(unknown.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Sync,
        path: [UnknownTelemetryAttribute.NotInSchema],
        attributePath: UnknownTelemetryAttribute.NotInSchema,
        code: TelemetryValidationIssueCode.UnrecognizedKeys,
      }),
    ]);
    expect(
      JSON.stringify([...wrongType.errors, ...unknown.errors])
    ).not.toContain(RawSecretValue.ApiKey);
  });

  it("bounds and normalizes unknown attribute messages", () => {
    const unknownAttributes = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`unknown.${index}`, index])
    );
    const result = expectInvalid(
      validate(
        spanPayload({
          ...unknownAttributes,
          [LongUnknownAttributeName]: RawSecretValue.ApiKey,
          [ControlCharacterUnknownAttributeName]: RawSecretValue.ApiKey,
        }),
        TelemetrySchemaName.Span
      )
    );

    expect(result.errors).toHaveLength(22);
    expect(result.errors.map((error) => error.message)).toContain(
      "Unrecognized telemetry attribute: <145 chars>"
    );
    expect(result.errors.map((error) => error.message)).toContain(
      "Unrecognized telemetry attribute: bad?attribute"
    );
    expect(
      JSON.stringify(result.errors.map((error) => error.message))
    ).not.toContain(LongUnknownAttributeName);
    expect(
      JSON.stringify(result.errors.map((error) => error.message))
    ).not.toContain("\u0001");
    for (const error of result.errors) {
      expect(error.message.length).toBeLessThanOrEqual(80);
    }
  });

  it("rejects wrong schema-name dispatch without throwing", () => {
    const result = expectInvalid(
      validate(
        { [TelemetryAttribute.ServiceName]: "cl-api" },
        SimilarTelemetrySchemaName.Spans
      )
    );

    expect(result.errors).toEqual([
      {
        schemaName: SimilarTelemetrySchemaName.Spans,
        path: [],
        attributePath: "",
        code: TelemetryValidationIssueCode.UnknownSchemaName,
        message: expect.any(String),
      },
    ]);
  });
});

describe("validateSpanEnvelope", () => {
  it("validates envelopes and schema-selected nested attributes", () => {
    const result = validateSpanEnvelope(
      spanEnvelopePayload({
        parent_span_id: "1111111111111111",
        links: [
          {
            trace_id: "22222222222222222222222222222222",
            span_id: "3333333333333333",
          },
        ],
      })
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        parent_span_id: "1111111111111111",
        attributes: {
          [TelemetryAttribute.HttpRequestMethod]: "GET",
        },
      },
    });
  });

  it("validates non-span envelope attributes through the central schema registry", () => {
    const result = validateSpanEnvelope(
      spanEnvelopePayload({
        schema_name: TelemetrySchemaName.App,
        attributes: appPayload(),
      })
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        schema_name: TelemetrySchemaName.App,
        attributes: {
          [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
        },
      },
    });
  });

  it("preserves flat span validation compatibility", () => {
    expect(validate(spanPayload(), TelemetrySchemaName.Span)).toMatchObject({
      ok: true,
      value: {
        [TelemetryAttribute.DurationMs]: 1,
      },
    });
  });

  it("returns safe envelope failures without raw values", () => {
    const result = expectInvalid(
      validateSpanEnvelope(
        spanEnvelopePayload({
          trace_id: RawSecretValue.ApiKey,
          parent_span_id: null,
          "secret.extra": RawSecretValue.ApiKey,
        })
      )
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaName: "span_envelope",
          path: ["trace_id"],
          attributePath: "trace_id",
        }),
        expect.objectContaining({
          schemaName: "span_envelope",
          path: ["parent_span_id"],
          attributePath: "parent_span_id",
        }),
        expect.objectContaining({
          schemaName: "span_envelope",
          path: ["secret.extra"],
          attributePath: "secret.extra",
          code: TelemetryValidationIssueCode.UnrecognizedKeys,
        }),
      ])
    );
    expect(JSON.stringify(result.errors)).not.toContain(RawSecretValue.ApiKey);
  });

  it("rejects unknown envelope schema-name selectors", () => {
    const result = expectInvalid(
      validateSpanEnvelope(
        spanEnvelopePayload({
          schema_name: SimilarTelemetrySchemaName.Spans,
        })
      )
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        schemaName: "span_envelope",
        path: ["schema_name"],
        attributePath: "schema_name",
      }),
    ]);
  });

  it("prefixes nested attribute failures from the central schema registry", () => {
    const result = expectInvalid(
      validateSpanEnvelope(
        spanEnvelopePayload({
          attributes: spanPayload({
            [UnknownTelemetryAttribute.NotInSchema]: RawSecretValue.ApiKey,
          }),
        })
      )
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        schemaName: TelemetrySchemaName.Span,
        path: ["attributes", UnknownTelemetryAttribute.NotInSchema],
        attributePath: `attributes.${UnknownTelemetryAttribute.NotInSchema}`,
        code: TelemetryValidationIssueCode.UnrecognizedKeys,
      }),
    ]);
    expect(JSON.stringify(result.errors)).not.toContain(RawSecretValue.ApiKey);
  });

  it("rejects nested attributes that do not match a non-span schema selector", () => {
    const result = expectInvalid(
      validateSpanEnvelope(
        spanEnvelopePayload({
          schema_name: TelemetrySchemaName.App,
          attributes: spanPayload(),
        })
      )
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaName: TelemetrySchemaName.App,
          path: ["attributes", TelemetryAttribute.HttpRequestMethod],
          attributePath: `attributes.${TelemetryAttribute.HttpRequestMethod}`,
          code: TelemetryValidationIssueCode.UnrecognizedKeys,
        }),
      ])
    );
  });

  it("rejects mismatched duplicate duration for span attributes", () => {
    const result = expectInvalid(
      validateSpanEnvelope(
        spanEnvelopePayload({
          duration_ms: 2,
          attributes: spanPayload({ [TelemetryAttribute.DurationMs]: 1 }),
        })
      )
    );

    expect(result.errors).toEqual([
      {
        schemaName: TelemetrySchemaName.Span,
        path: ["attributes", TelemetryAttribute.DurationMs],
        attributePath: `attributes.${TelemetryAttribute.DurationMs}`,
        code: "custom",
        message:
          "Span envelope attributes.duration_ms must equal envelope duration_ms",
      },
    ]);
  });
});

function expectInvalid(
  result: SpanEnvelopeValidationResult | TelemetryValidationResult
): TelemetryValidationFailure {
  if (result.ok) {
    throw new Error("Expected validation to fail");
  }
  return result;
}
