import type { ZodIssue } from "zod";
import { AppTelemetrySchema } from "../app";
import { IpcTelemetrySchema } from "../ipc";
import { PermissionTelemetrySchema } from "../permission";
import { SyncTelemetrySchema } from "../sync";
import { TelemetryAttribute } from "./attributes";
import { GenAiTelemetrySchema } from "./gen-ai";
import { ResourceTelemetrySchema } from "./resource";
import { TelemetrySchemaName } from "./schema-name";
import type { SchemaShape } from "./schema-shape";
import {
  type SpanEnvelope,
  SpanEnvelopeSchema,
  SpanTelemetrySchema,
} from "./span";

const UNKNOWN_ATTRIBUTE_MESSAGE_KEY_MAX_LENGTH = 64;
const CONTROL_CHARACTER_MAX_CODE_POINT = 0x1f;
const DELETE_CHARACTER_CODE_POINT = 0x7f;
const SPAN_ENVELOPE_SCHEMA_NAME = "span_envelope";

/** Validation issue codes added by the telemetry contract wrapper. */
export const TelemetryValidationIssueCode = {
  UnknownSchemaName: "unknown_schema_name",
  UnrecognizedKeys: "unrecognized_keys",
} as const;

/** Literal union of telemetry contract validation wrapper issue codes. */
export type TelemetryValidationIssueCode =
  (typeof TelemetryValidationIssueCode)[keyof typeof TelemetryValidationIssueCode];

/** Attribute path segments returned in safe validation failures. */
export type TelemetryValidationPathSegment = string | number;

/** Safe validation error envelope; raw received values are never included. */
export type TelemetryValidationError = {
  schemaName: string;
  path: TelemetryValidationPathSegment[];
  attributePath: string;
  code: string;
  message: string;
};

/** Successful validation result with the parsed schema-specific value. */
export type TelemetryValidationSuccess<
  K extends TelemetrySchemaName = TelemetrySchemaName,
> = {
  ok: true;
  value: SchemaShape<K>;
};

/** Failed validation result containing safe, structured errors. */
export type TelemetryValidationFailure = {
  ok: false;
  errors: TelemetryValidationError[];
};

/** Result envelope returned by validate(); callers should branch on ok. */
export type TelemetryValidationResult<
  K extends TelemetrySchemaName = TelemetrySchemaName,
> = TelemetryValidationSuccess<K> | TelemetryValidationFailure;

/** Successful validation result with the parsed span envelope. */
export type SpanEnvelopeValidationSuccess = {
  ok: true;
  value: SpanEnvelope;
};

/** Result envelope returned by validateSpanEnvelope(). */
export type SpanEnvelopeValidationResult =
  | SpanEnvelopeValidationSuccess
  | TelemetryValidationFailure;

const TelemetrySchemaByName = {
  [TelemetrySchemaName.App]: AppTelemetrySchema,
  [TelemetrySchemaName.Resource]: ResourceTelemetrySchema,
  [TelemetrySchemaName.Span]: SpanTelemetrySchema,
  [TelemetrySchemaName.GenAi]: GenAiTelemetrySchema,
  [TelemetrySchemaName.Sync]: SyncTelemetrySchema,
  [TelemetrySchemaName.Permission]: PermissionTelemetrySchema,
  [TelemetrySchemaName.Ipc]: IpcTelemetrySchema,
} as const satisfies Record<
  TelemetrySchemaName,
  | typeof AppTelemetrySchema
  | typeof IpcTelemetrySchema
  | typeof SyncTelemetrySchema
  | typeof PermissionTelemetrySchema
  | typeof ResourceTelemetrySchema
  | typeof SpanTelemetrySchema
  | typeof GenAiTelemetrySchema
>;

/** Validates a payload against the selected telemetry schema without throwing. */
export function validate<K extends TelemetrySchemaName>(
  payload: unknown,
  schemaName: K
): TelemetryValidationResult<K>;
export function validate(
  payload: unknown,
  schemaName: string
): TelemetryValidationResult;
export function validate(
  payload: unknown,
  schemaName: string
): TelemetryValidationResult {
  if (!isTelemetrySchemaName(schemaName)) {
    return {
      ok: false,
      errors: [
        {
          schemaName,
          path: [],
          attributePath: "",
          code: TelemetryValidationIssueCode.UnknownSchemaName,
          message: `Unknown telemetry schema name: ${schemaName}`,
        },
      ],
    };
  }

  const result = TelemetrySchemaByName[schemaName].safeParse(payload);
  if (result.success) {
    return {
      ok: true,
      value: result.data,
    };
  }

  return {
    ok: false,
    errors: result.error.issues.flatMap((issue) =>
      validationErrorsFromIssue(schemaName, issue)
    ),
  };
}

/** Validates a strict span envelope and its schema-selected attributes. */
export function validateSpanEnvelope(
  payload: unknown
): SpanEnvelopeValidationResult {
  const envelopeResult = SpanEnvelopeSchema.safeParse(payload);
  if (!envelopeResult.success) {
    return {
      ok: false,
      errors: envelopeResult.error.issues.flatMap((issue) =>
        validationErrorsFromIssue(SPAN_ENVELOPE_SCHEMA_NAME, issue)
      ),
    };
  }

  const envelope = envelopeResult.data;
  const attributesResult = validate(envelope.attributes, envelope.schema_name);
  if (!attributesResult.ok) {
    return {
      ok: false,
      errors: attributesResult.errors.map(prefixAttributeErrorPath),
    };
  }

  if (hasMismatchedSpanDuration(envelope)) {
    return {
      ok: false,
      errors: [
        {
          schemaName: envelope.schema_name,
          path: ["attributes", TelemetryAttribute.DurationMs],
          attributePath: `attributes.${TelemetryAttribute.DurationMs}`,
          code: "custom",
          message:
            "Span envelope attributes.duration_ms must equal envelope duration_ms",
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      ...envelope,
      attributes: attributesResult.value,
    },
  };
}

function isTelemetrySchemaName(
  schemaName: string
): schemaName is TelemetrySchemaName {
  return schemaName in TelemetrySchemaByName;
}

function validationErrorsFromIssue(
  schemaName: string,
  issue: ZodIssue
): TelemetryValidationError[] {
  if (isUnrecognizedKeysIssue(issue)) {
    return issue.keys.map((key) => ({
      schemaName,
      path: [key],
      attributePath: key,
      code: TelemetryValidationIssueCode.UnrecognizedKeys,
      message: unknownAttributeMessage(key),
    }));
  }

  const path = normalizePath(issue.path);
  return [
    {
      schemaName,
      path,
      attributePath: path.join("."),
      code: issue.code,
      message: issue.message,
    },
  ];
}

function prefixAttributeErrorPath(
  error: TelemetryValidationError
): TelemetryValidationError {
  return {
    ...error,
    path: ["attributes", ...error.path],
    attributePath: ["attributes", error.attributePath]
      .filter(Boolean)
      .join("."),
  };
}

function hasMismatchedSpanDuration(envelope: SpanEnvelope): boolean {
  if (envelope.schema_name !== TelemetrySchemaName.Span) {
    return false;
  }

  const nestedDuration = envelope.attributes[TelemetryAttribute.DurationMs];
  return (
    typeof nestedDuration === "number" &&
    nestedDuration !== envelope.duration_ms
  );
}

function isUnrecognizedKeysIssue(
  issue: ZodIssue
): issue is ZodIssue & { keys: string[] } {
  return (
    issue.code === TelemetryValidationIssueCode.UnrecognizedKeys &&
    "keys" in issue &&
    Array.isArray(issue.keys)
  );
}

function unknownAttributeMessage(key: string) {
  const normalizedKey = Array.from(key, normalizeControlCharacter).join("");
  const keyDescription =
    normalizedKey.length > UNKNOWN_ATTRIBUTE_MESSAGE_KEY_MAX_LENGTH
      ? `<${normalizedKey.length} chars>`
      : normalizedKey;
  return `Unrecognized telemetry attribute: ${keyDescription}`;
}

function normalizeControlCharacter(character: string) {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined &&
    (codePoint <= CONTROL_CHARACTER_MAX_CODE_POINT ||
      codePoint === DELETE_CHARACTER_CODE_POINT)
    ? "?"
    : character;
}

function normalizePath(
  path: readonly PropertyKey[]
): TelemetryValidationPathSegment[] {
  return path.map((segment) =>
    typeof segment === "number" ? segment : String(segment)
  );
}
