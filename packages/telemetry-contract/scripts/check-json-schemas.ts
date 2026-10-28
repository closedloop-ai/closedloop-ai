import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { TelemetryAttribute } from "../src/attributes";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import { SpanErrorSource } from "../src/span";
import {
  genAiPayload,
  ipcPayload,
  ipcPayloadWithoutSessionCount,
  permissionPayload,
  spanEnvelopePayload,
  spanPayload,
  syncPayload,
} from "../src/test-fixtures";
import { appSchemaCheck } from "./json-schema-parity-cases-app";
import {
  assertEnumParity,
  identifierText,
  maxUnicodeText,
  overflowUnicodeText,
  type SchemaCheck,
  upperTokenText,
} from "./json-schema-parity-fixtures";
import {
  assertLocalAbsolutePathPositiveControls,
  assertNoLocalAbsolutePath,
} from "./privacy-scan";
import { schemaManifest } from "./schema-manifest";

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

const schemaChecks: SchemaCheck[] = [
  appSchemaCheck,
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
          [TelemetryAttribute.DeviceId]: maxUnicodeText(
            TelemetryTextMaxLength.DeviceId
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
        name: "device id above Unicode maximum",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.DeviceId]: overflowUnicodeText(
            TelemetryTextMaxLength.DeviceId
          ),
        },
      },
      {
        name: "control character device id",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.DeviceId]: "device\nid",
        },
      },
      {
        name: "wrong type service name",
        payload: { [TelemetryAttribute.ServiceName]: 123 },
      },
      {
        name: "wrong type device id",
        payload: {
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.DeviceId]: false,
        },
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
          [TelemetryAttribute.ErrorType]: identifierText(
            TelemetryTextMaxLength.ErrorType
          ),
          [TelemetryAttribute.AppErrorSource]: SpanErrorSource.RouteHandler,
          [TelemetryAttribute.AppOrganizationId]: maxUnicodeText(
            TelemetryTextMaxLength.AppOrganizationId
          ),
          [TelemetryAttribute.ArtifactType]: upperTokenText(
            TelemetryTextMaxLength.ArtifactType
          ),
          [TelemetryAttribute.ArtifactStatus]: upperTokenText(
            TelemetryTextMaxLength.ArtifactStatus
          ),
          [TelemetryAttribute.SyncBatchId]:
            "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c",
        },
      },
      {
        name: "dotted error type carrying a stable machine code",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: "PrismaClientKnownRequestError.P2002",
        }),
      },
      {
        // Same pairing the Sync schema pins: the exported `pattern` carries no
        // `i` flag, so case-insensitivity has to live in the character classes
        // or the two representations of `sync.batch_id` accept different sets.
        name: "uppercase span sync batch id",
        payload: spanPayload({
          [TelemetryAttribute.SyncBatchId]:
            "D4B6B0A2-6A3E-4F9C-8B1D-2C3E4F5A6B7C",
        }),
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
        name: "span envelope is not accepted by flat span schema",
        payload: spanEnvelopePayload(),
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
        name: "error type above maximum",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: identifierText(
            TelemetryTextMaxLength.ErrorType + 1
          ),
        }),
      },
      // ISS-7217: the span rides a keyless lane, so an error MESSAGE must be
      // unrepresentable, not merely discouraged. Each of these is a shape a
      // real message takes — prose, a path, a query string, an address — and
      // the pattern has to reject every one of them.
      {
        name: "error type carrying prose",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: "Invalid document id supplied",
        }),
      },
      {
        name: "error type carrying a filesystem path",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: "ENOENT:/srv/app/secrets.json",
        }),
      },
      {
        name: "error type carrying a query string",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: "BadRequest?token=abc",
        }),
      },
      {
        name: "error type carrying an address",
        payload: spanPayload({
          [TelemetryAttribute.ErrorType]: "Rejected@example.com",
        }),
      },
      {
        name: "artifact type outside the uppercase token shape",
        payload: spanPayload({
          [TelemetryAttribute.ArtifactType]: "My Draft PRD",
        }),
      },
      {
        name: "artifact status outside the uppercase token shape",
        payload: spanPayload({
          [TelemetryAttribute.ArtifactStatus]: "in-review",
        }),
      },
      {
        name: "error source outside the closed enum",
        payload: spanPayload({
          [TelemetryAttribute.AppErrorSource]: "database",
        }),
      },
      {
        name: "fractional duration",
        payload: spanPayload({ [TelemetryAttribute.DurationMs]: 1.5 }),
      },
      {
        name: "non-uuid span sync batch id",
        payload: spanPayload({ [TelemetryAttribute.SyncBatchId]: "batch-1" }),
      },
      {
        name: "nil-uuid span sync batch id",
        payload: spanPayload({
          [TelemetryAttribute.SyncBatchId]:
            "00000000-0000-0000-0000-000000000000",
        }),
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
          [TelemetryAttribute.GenAiOperationName]: "chat",
        },
      },
    ],
    invalidPayloads: [
      {
        name: "operation name outside the closed set",
        payload: genAiPayload({
          [TelemetryAttribute.GenAiOperationName]: "embeddings",
        }),
      },
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
    id: "https://closedloop.ai/schemas/telemetry-contract/sync/v0.6.schema.json",
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
          [TelemetryAttribute.SyncReason]: "ack_timeout",
          [TelemetryAttribute.SyncBatchId]:
            "d4b6b0a2-6a3e-4f9c-8b1d-2c3e4f5a6b7c",
          [TelemetryAttribute.SyncSessionCount]: 3,
          [TelemetryAttribute.SyncAttempt]: 2,
          [TelemetryAttribute.SyncPayloadShaping]: "chunked_head",
          [TelemetryAttribute.SyncTilingStrippedCount]: 2,
          [TelemetryAttribute.AppOrganizationId]:
            "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
          [TelemetryAttribute.AppOperatingMode]: "multiplayer",
        },
      },
      {
        // The Zod validator and this schema must accept the same set; an `i`
        // flag on the Zod side would not survive into the exported `pattern`.
        name: "uppercase sync batch id",
        payload: syncPayload({
          [TelemetryAttribute.SyncBatchId]:
            "D4B6B0A2-6A3E-4F9C-8B1D-2C3E4F5A6B7C",
        }),
      },
      {
        name: "tiling-stripped payload shaping",
        payload: syncPayload({
          [TelemetryAttribute.SyncPayloadShaping]: "tiling_stripped",
        }),
      },
    ],
    invalidPayloads: [
      {
        name: "unknown sync attribute",
        payload: syncPayload({ "sync.session_id": "session-123" }),
      },
      {
        name: "empty sync organization id",
        payload: syncPayload({ [TelemetryAttribute.AppOrganizationId]: "" }),
      },
      {
        name: "unknown sync operating mode",
        payload: syncPayload({
          [TelemetryAttribute.AppOperatingMode]: "enterprise",
        }),
      },
      {
        name: "over-length sync organization id",
        payload: syncPayload({
          [TelemetryAttribute.AppOrganizationId]: "o".repeat(65),
        }),
      },
      {
        name: "control-character sync organization id",
        payload: syncPayload({
          [TelemetryAttribute.AppOrganizationId]: "org\u0001id",
        }),
      },
      {
        name: "non-uuid sync batch id",
        payload: syncPayload({ [TelemetryAttribute.SyncBatchId]: "batch-1" }),
      },
      {
        name: "zero sync attempt",
        payload: syncPayload({ [TelemetryAttribute.SyncAttempt]: 0 }),
      },
      {
        name: "negative sync tiling stripped count",
        payload: syncPayload({
          [TelemetryAttribute.SyncTilingStrippedCount]: -1,
        }),
      },
      {
        name: "negative sync session count",
        payload: syncPayload({ [TelemetryAttribute.SyncSessionCount]: -1 }),
      },
      {
        name: "wrong sync payload shaping",
        payload: syncPayload({
          [TelemetryAttribute.SyncPayloadShaping]: "truncated",
        }),
      },
      {
        name: "wrong sync reason",
        payload: syncPayload({ [TelemetryAttribute.SyncReason]: "partial" }),
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
  {
    path: "dist/schemas/ipc.schema.json",
    id: "https://closedloop.ai/schemas/telemetry-contract/ipc/v0.1.schema.json",
    validPayloads: [
      {
        name: "all ipc fields with error type",
        payload: ipcPayload({
          [TelemetryAttribute.IpcOperation]: "usage",
          [TelemetryAttribute.ErrorType]: "DesktopMigrationError",
        }),
      },
      {
        name: "ipc without optional error type",
        payload: ipcPayload(),
      },
      {
        name: "ipc page_data operation",
        payload: ipcPayload({
          [TelemetryAttribute.IpcOperation]: "page_data",
        }),
      },
      {
        // ISS-8773: the failed call whose follow-up COUNT failed with it. The
        // published JSON Schema has to accept the omission for the same reason
        // the Zod validator does — an off-contract consumer validating against
        // the schema alone must not reject the event `error.type` lives on.
        name: "ipc with an unmeasured session count on a failed call",
        payload: ipcPayloadWithoutSessionCount({
          [TelemetryAttribute.ErrorType]: "DbHostExitError",
        }),
      },
    ],
    invalidPayloads: [
      {
        name: "unknown ipc attribute",
        payload: ipcPayload({ "ipc.duration_ns": 1 }),
      },
      {
        name: "missing required ipc operation",
        // The four core dimensions without the required `ipc.operation`.
        payload: {
          [TelemetryAttribute.DurationMs]: 42,
          [TelemetryAttribute.IpcPayloadBytes]: 2048,
          [TelemetryAttribute.IpcResultCount]: 25,
          [TelemetryAttribute.IpcSessionCount]: 1280,
        },
      },
      {
        name: "wrong ipc operation",
        payload: ipcPayload({ [TelemetryAttribute.IpcOperation]: "analytics" }),
      },
      {
        name: "over-cap ipc duration",
        payload: ipcPayload({ [TelemetryAttribute.DurationMs]: 86_400_001 }),
      },
      {
        name: "negative ipc payload bytes",
        payload: ipcPayload({ [TelemetryAttribute.IpcPayloadBytes]: -1 }),
      },
      {
        name: "fractional ipc result count",
        payload: ipcPayload({ [TelemetryAttribute.IpcResultCount]: 2.5 }),
      },
      {
        name: "empty ipc error type",
        payload: ipcPayload({ [TelemetryAttribute.ErrorType]: "" }),
      },
      {
        name: "control-character ipc error type",
        payload: ipcPayload({
          [TelemetryAttribute.ErrorType]: "bad\u0001type",
        }),
      },
    ],
  },
];

export { schemaChecks };

const isDirectRun =
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(realpathSync(resolve(process.argv[1]))).href;

if (isDirectRun) {
  if (!existsSync("dist")) {
    throw new Error("dist/ must exist before generated schemas are checked");
  }

  const manifestPaths: ReadonlySet<string> = new Set(
    schemaManifest.map((s) => s.path)
  );
  const checkPaths: ReadonlySet<string> = new Set(
    schemaChecks.map((c) => c.path)
  );

  for (const mp of manifestPaths) {
    if (!checkPaths.has(mp)) {
      throw new Error(
        `schema-manifest lists ${mp} but schemaChecks has no entry for it`
      );
    }
  }
  for (const cp of checkPaths) {
    if (!manifestPaths.has(cp)) {
      throw new Error(`schemaChecks lists ${cp} but schema-manifest does not`);
    }
  }

  const distFiles = readdirSync("dist/schemas")
    .filter((f) => f.endsWith(".schema.json"))
    .map((f) => `dist/schemas/${f}`);
  for (const df of distFiles) {
    if (!checkPaths.has(df)) {
      throw new Error(
        `dist/schemas/ contains ${df} but schemaChecks has no entry for it`
      );
    }
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

    assertEnumParity(check.path, parsed.properties, check.enumParity);

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
