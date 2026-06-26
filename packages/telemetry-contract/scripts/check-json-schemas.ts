import { existsSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { TelemetryAttribute } from "../src/attributes";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import {
  appPayload,
  genAiPayload,
  permissionPayload,
  spanPayload,
  syncPayload,
} from "../src/test-fixtures";
import {
  assertLocalAbsolutePathPositiveControls,
  assertNoLocalAbsolutePath,
} from "./privacy-scan";

const GeneratedJsonSchemaShape = z
  .object({
    $id: z.string(),
    $schema: z.string(),
    type: z.literal("object"),
    additionalProperties: z.literal(false),
    properties: z.record(z.string(), z.record(z.string(), z.unknown())),
    required: z.array(z.string()).optional(),
  })
  .loose();

type SchemaCheck = {
  path: string;
  id: string;
  validPayloads: Array<{
    name: string;
    payload: Record<string, unknown>;
  }>;
  invalidPayloads: Array<{
    name: string;
    payload: Record<string, unknown>;
  }>;
};

const NON_BMP_CHARACTER = String.fromCodePoint(0x1_f9_ea);

const maxUnicodeText = (maxLength: number) =>
  NON_BMP_CHARACTER.repeat(maxLength);

const overflowUnicodeText = (maxLength: number) =>
  NON_BMP_CHARACTER.repeat(maxLength + 1);

const schemaChecks: SchemaCheck[] = [
  {
    path: "dist/schemas/app.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/app/v0.3.schema.json",
    validPayloads: [
      {
        name: "empty app payload",
        payload: {},
      },
      {
        name: "all app fields",
        payload: {
          [TelemetryAttribute.AppInstallationId]: maxUnicodeText(
            TelemetryTextMaxLength.AppInstallationId
          ),
          [TelemetryAttribute.DeploymentEnvironmentName]: maxUnicodeText(
            TelemetryTextMaxLength.DeploymentEnvironmentName
          ),
          [TelemetryAttribute.ExceptionType]: maxUnicodeText(
            TelemetryTextMaxLength.ExceptionType
          ),
          [TelemetryAttribute.ExceptionMessage]: maxUnicodeText(
            TelemetryTextMaxLength.ExceptionMessage
          ),
          [TelemetryAttribute.ExceptionStacktrace]: maxUnicodeText(
            TelemetryTextMaxLength.ExceptionStacktrace
          ),
          [TelemetryAttribute.AppExceptionOrigin]: "main",
          [TelemetryAttribute.AppOperatingMode]: "single_player",
          [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
        },
      },
    ],
    invalidPayloads: [
      {
        name: "unknown app attribute",
        payload: appPayload({ "app.unknown": "value" }),
      },
      {
        name: "wrong app exception origin",
        payload: appPayload({
          [TelemetryAttribute.AppExceptionOrigin]: "worker",
        }),
      },
      {
        name: "wrong operating mode",
        payload: appPayload({
          [TelemetryAttribute.AppOperatingMode]: "co_op",
        }),
      },
      {
        name: "wrong lifecycle event",
        payload: appPayload({
          [TelemetryAttribute.AppLifecycleEvent]: "restart",
        }),
      },
      {
        name: "wrong type installation id",
        payload: appPayload({
          [TelemetryAttribute.AppInstallationId]: 123,
        }),
      },
      {
        name: "control character exception message",
        payload: appPayload({
          [TelemetryAttribute.ExceptionMessage]: "boom\nfailed",
        }),
      },
      {
        name: "installation id above Unicode maximum",
        payload: appPayload({
          [TelemetryAttribute.AppInstallationId]: overflowUnicodeText(
            TelemetryTextMaxLength.AppInstallationId
          ),
        }),
      },
      {
        name: "deployment environment above Unicode maximum",
        payload: appPayload({
          [TelemetryAttribute.DeploymentEnvironmentName]: overflowUnicodeText(
            TelemetryTextMaxLength.DeploymentEnvironmentName
          ),
        }),
      },
      {
        name: "exception type above Unicode maximum",
        payload: appPayload({
          [TelemetryAttribute.ExceptionType]: overflowUnicodeText(
            TelemetryTextMaxLength.ExceptionType
          ),
        }),
      },
      {
        name: "exception message above Unicode maximum",
        payload: appPayload({
          [TelemetryAttribute.ExceptionMessage]: overflowUnicodeText(
            TelemetryTextMaxLength.ExceptionMessage
          ),
        }),
      },
      {
        name: "exception stacktrace above Unicode maximum",
        payload: appPayload({
          [TelemetryAttribute.ExceptionStacktrace]: overflowUnicodeText(
            TelemetryTextMaxLength.ExceptionStacktrace
          ),
        }),
      },
    ],
  },
  {
    path: "dist/schemas/resource.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/resource/v0.4.schema.json",
    validPayloads: [
      {
        name: "all resource fields",
        payload: {
          [TelemetryAttribute.ServiceName]: maxUnicodeText(
            TelemetryTextMaxLength.ServiceName
          ),
          [TelemetryAttribute.ServiceVersion]: maxUnicodeText(
            TelemetryTextMaxLength.ServiceVersion
          ),
          [TelemetryAttribute.HarnessName]: "claude",
        },
      },
    ],
    invalidPayloads: [
      {
        name: "unknown resource attribute",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          "service.instance.id": "local",
        },
      },
      {
        name: "unknown harness name",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.HarnessName]: "gemini",
        },
      },
      {
        name: "wrong type harness name",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.HarnessName]: 7,
        },
      },
      { name: "missing service name", payload: {} },
      {
        name: "control character service name",
        payload: { [TelemetryAttribute.ServiceName]: "cl\napi" },
      },
      {
        name: "service name above Unicode maximum",
        payload: {
          [TelemetryAttribute.ServiceName]: overflowUnicodeText(
            TelemetryTextMaxLength.ServiceName
          ),
        },
      },
      {
        name: "service version above Unicode maximum",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.ServiceVersion]: overflowUnicodeText(
            TelemetryTextMaxLength.ServiceVersion
          ),
        },
      },
      {
        name: "wrong type service name",
        payload: { [TelemetryAttribute.ServiceName]: 123 },
      },
      {
        name: "wrong type service version",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.ServiceVersion]: false,
        },
      },
    ],
  },
  {
    path: "dist/schemas/span.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/span/v0.1.schema.json",
    validPayloads: [
      {
        name: "all span fields",
        payload: {
          [TelemetryAttribute.HttpRequestMethod]: "GET",
          [TelemetryAttribute.HttpResponseStatusCode]: 200,
          [TelemetryAttribute.UrlPath]: `/${maxUnicodeText(
            TelemetryTextMaxLength.UrlPath - 1
          )}`,
          [TelemetryAttribute.DurationMs]: 12,
          [TelemetryAttribute.CodeFunctionName]: maxUnicodeText(
            TelemetryTextMaxLength.CodeFunctionName
          ),
          [TelemetryAttribute.CodeFilePath]: maxUnicodeText(
            TelemetryTextMaxLength.CodeFilePath
          ),
          [TelemetryAttribute.CodeLineNumber]: 42,
          [TelemetryAttribute.CodeColumnNumber]: 0,
          [TelemetryAttribute.ErrorType]: maxUnicodeText(
            TelemetryTextMaxLength.ErrorType
          ),
        },
      },
    ],
    invalidPayloads: [
      {
        name: "unknown span attribute",
        payload: {
          [TelemetryAttribute.HttpRequestMethod]: "GET",
          [TelemetryAttribute.HttpResponseStatusCode]: 200,
          [TelemetryAttribute.UrlPath]: "/ok",
          [TelemetryAttribute.DurationMs]: 1,
          "http.request.body.size": 10,
        },
      },
      {
        name: "full URL path",
        payload: spanPayload({
          [TelemetryAttribute.UrlPath]: "https://x.test/a",
        }),
      },
      {
        name: "leading authority URL path",
        payload: spanPayload({ [TelemetryAttribute.UrlPath]: "//x.test/a" }),
      },
      {
        name: "userinfo authority URL path",
        payload: spanPayload({
          [TelemetryAttribute.UrlPath]: "/user:pass@example.com/a",
        }),
      },
      {
        name: "spaced userinfo authority URL path",
        payload: spanPayload({
          [TelemetryAttribute.UrlPath]: "/user: pass@example.com/a",
        }),
      },
      {
        name: "split userinfo authority URL path",
        payload: spanPayload({
          [TelemetryAttribute.UrlPath]: "/user:pass @example.com/a",
        }),
      },
      {
        name: "query URL path",
        payload: spanPayload({ [TelemetryAttribute.UrlPath]: "/a?b=1" }),
      },
      {
        name: "fragment URL path",
        payload: spanPayload({ [TelemetryAttribute.UrlPath]: "/a#b" }),
      },
      {
        name: "invalid status",
        payload: spanPayload({
          [TelemetryAttribute.HttpResponseStatusCode]: 99,
        }),
      },
      {
        name: "invalid duration",
        payload: spanPayload({ [TelemetryAttribute.DurationMs]: -1 }),
      },
      {
        name: "duration above maximum",
        payload: spanPayload({
          [TelemetryAttribute.DurationMs]: 86_400_001,
        }),
      },
      {
        name: "URL path above Unicode maximum",
        payload: spanPayload({
          [TelemetryAttribute.UrlPath]: `/${maxUnicodeText(
            TelemetryTextMaxLength.UrlPath
          )}`,
        }),
      },
      {
        name: "code function name above Unicode maximum",
        payload: spanPayload({
          [TelemetryAttribute.CodeFunctionName]: overflowUnicodeText(
            TelemetryTextMaxLength.CodeFunctionName
          ),
        }),
      },
      {
        name: "code file path above Unicode maximum",
        payload: spanPayload({
          [TelemetryAttribute.CodeFilePath]: overflowUnicodeText(
            TelemetryTextMaxLength.CodeFilePath
          ),
        }),
      },
      {
        name: "error type above Unicode maximum",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: overflowUnicodeText(
            TelemetryTextMaxLength.ErrorType
          ),
        }),
      },
      {
        name: "fractional duration",
        payload: spanPayload({ [TelemetryAttribute.DurationMs]: 1.5 }),
      },
    ],
  },
  {
    path: "dist/schemas/gen-ai.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/gen-ai/v0.4.schema.json",
    validPayloads: [
      {
        name: "all gen ai fields",
        payload: {
          [TelemetryAttribute.GenAiRequestModel]: maxUnicodeText(
            TelemetryTextMaxLength.GenAiRequestModel
          ),
          [TelemetryAttribute.GenAiResponseId]: maxUnicodeText(
            TelemetryTextMaxLength.GenAiResponseId
          ),
          [TelemetryAttribute.GenAiUsageInputTokens]: 10,
          [TelemetryAttribute.GenAiUsageOutputTokens]: 20,
          [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]: 3,
          [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: 4,
          [TelemetryAttribute.GenAiCostUsage]: 0.0234,
        },
      },
    ],
    invalidPayloads: [
      {
        name: "negative cost",
        payload: genAiPayload({ [TelemetryAttribute.GenAiCostUsage]: -0.01 }),
      },
      {
        name: "wrong type cost",
        payload: genAiPayload({ [TelemetryAttribute.GenAiCostUsage]: "0.02" }),
      },
      {
        name: "unknown gen ai attribute",
        payload: {
          [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
          "gen_ai.system": "anthropic",
        },
      },
      { name: "missing model", payload: {} },
      {
        name: "request model above Unicode maximum",
        payload: {
          [TelemetryAttribute.GenAiRequestModel]: overflowUnicodeText(
            TelemetryTextMaxLength.GenAiRequestModel
          ),
        },
      },
      {
        name: "empty response id",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiResponseId]: "",
        }),
      },
      {
        name: "wrong type response id",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiResponseId]: 123,
        }),
      },
      {
        name: "control character response id",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiResponseId]: "resp\nabc",
        }),
      },
      {
        name: "response id above Unicode maximum",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiResponseId]: overflowUnicodeText(
            TelemetryTextMaxLength.GenAiResponseId
          ),
        }),
      },
      {
        name: "negative tokens",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiUsageInputTokens]: -1,
        }),
      },
      {
        name: "fractional tokens",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiUsageOutputTokens]: 1.5,
        }),
      },
      {
        name: "huge tokens",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiUsageInputTokens]: 1_000_000_001,
        }),
      },
    ],
  },
  {
    path: "dist/schemas/sync.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/sync/v0.3.schema.json",
    validPayloads: [
      {
        name: "empty sync payload",
        payload: {},
      },
      {
        name: "all sync fields",
        payload: {
          [TelemetryAttribute.SyncEvent]: "batch",
          [TelemetryAttribute.SyncOutcome]: "dead_letter",
          [TelemetryAttribute.SyncPayloadBytes]: 512,
          [TelemetryAttribute.SyncLatencyMs]: 12.5,
        },
      },
    ],
    invalidPayloads: [
      {
        name: "unknown sync attribute",
        payload: syncPayload({ "sync.session_id": "session-123" }),
      },
      {
        name: "wrong sync event",
        payload: syncPayload({ [TelemetryAttribute.SyncEvent]: "session" }),
      },
      {
        name: "wrong sync outcome",
        payload: syncPayload({
          [TelemetryAttribute.SyncOutcome]: "partial",
        }),
      },
      {
        name: "negative sync payload bytes",
        payload: syncPayload({ [TelemetryAttribute.SyncPayloadBytes]: -1 }),
      },
      {
        name: "fractional sync payload bytes",
        payload: syncPayload({ [TelemetryAttribute.SyncPayloadBytes]: 1.5 }),
      },
      {
        name: "negative sync latency",
        payload: syncPayload({ [TelemetryAttribute.SyncLatencyMs]: -1 }),
      },
      {
        name: "wrong type sync latency",
        payload: syncPayload({ [TelemetryAttribute.SyncLatencyMs]: "12" }),
      },
    ],
  },
  {
    path: "dist/schemas/permission.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/permission/v0.4.schema.json",
    validPayloads: [
      {
        name: "empty permission payload",
        payload: {},
      },
      {
        name: "all permission fields",
        payload: {
          [TelemetryAttribute.GenAiPermissionDecision]: "deny",
          [TelemetryAttribute.GenAiPermissionSource]: "user_reject",
        },
      },
    ],
    invalidPayloads: [
      {
        name: "unknown permission attribute",
        payload: permissionPayload({ "gen_ai.permission.tool": "Bash" }),
      },
      {
        name: "wrong permission decision",
        payload: permissionPayload({
          [TelemetryAttribute.GenAiPermissionDecision]: "ask",
        }),
      },
      {
        name: "wrong permission source",
        payload: permissionPayload({
          [TelemetryAttribute.GenAiPermissionSource]: "user",
        }),
      },
      {
        name: "wrong type permission decision",
        payload: permissionPayload({
          [TelemetryAttribute.GenAiPermissionDecision]: 1,
        }),
      },
      {
        name: "wrong type permission source",
        payload: permissionPayload({
          [TelemetryAttribute.GenAiPermissionSource]: true,
        }),
      },
    ],
  },
];

if (!existsSync("dist")) {
  throw new Error("dist/ must exist before generated schemas are checked");
}

assertLocalAbsolutePathPositiveControls();

const ajv = new Ajv2020({ allErrors: true, strict: true });

for (const check of schemaChecks) {
  if (!existsSync(check.path)) {
    throw new Error(`Missing generated schema: ${check.path}`);
  }

  const source = readFileSync(check.path, "utf-8");
  assertPrivateSourceFree(check.path, source);

  const parsed = GeneratedJsonSchemaShape.parse(JSON.parse(source));
  if (parsed.$id !== check.id) {
    throw new Error(`${check.path} has unexpected $id`);
  }

  const validate = ajv.compile(parsed);
  for (const validPayload of check.validPayloads) {
    if (!validate(validPayload.payload)) {
      throw new Error(
        `${check.path} rejected valid payload: ${validPayload.name}: ${ajv.errorsText(
          validate.errors
        )}`
      );
    }
  }

  for (const invalidPayload of check.invalidPayloads) {
    if (validate(invalidPayload.payload)) {
      throw new Error(
        `${check.path} accepted invalid payload: ${invalidPayload.name}`
      );
    }
  }
}

function assertPrivateSourceFree(path: string, source: string) {
  for (const forbidden of [
    "sourceMappingURL",
    "sourcesContent",
    "src/",
    "scripts/",
    "__tests__/",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`${path} contains forbidden package-private text`);
    }
  }

  assertNoLocalAbsolutePath(path, source);
}
