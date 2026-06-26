import { describe, expect, it } from "vitest";
import { TelemetryAttribute } from "../src/attributes";
import { TelemetryEmitMetadataKey } from "../src/emit";
import { TelemetrySchemaName } from "../src/schema-name";

describe("canonical attribute literals", () => {
  it("exports the exact v0.5 attribute literals", () => {
    expect(TelemetryAttribute).toMatchObject({
      ServiceName: "service.name",
      ServiceVersion: "service.version",
      AppInstallationId: "app.installation.id",
      DeploymentEnvironmentName: "deployment.environment.name",
      ExceptionType: "exception.type",
      ExceptionMessage: "exception.message",
      ExceptionStacktrace: "exception.stacktrace",
      AppExceptionOrigin: "app.exception.origin",
      AppOperatingMode: "app.operating_mode",
      AppLifecycleEvent: "app.lifecycle.event",
      HttpRequestMethod: "http.request.method",
      HttpResponseStatusCode: "http.response.status_code",
      UrlPath: "url.path",
      DurationMs: "duration_ms",
      CodeFunctionName: "code.function.name",
      CodeFilePath: "code.file.path",
      CodeLineNumber: "code.line.number",
      CodeColumnNumber: "code.column.number",
      ErrorType: "error.type",
      GenAiUsageInputTokens: "gen_ai.usage.input_tokens",
      GenAiUsageOutputTokens: "gen_ai.usage.output_tokens",
      GenAiRequestModel: "gen_ai.request.model",
      GenAiResponseId: "gen_ai.response.id",
      GenAiUsageCacheCreationInputTokens:
        "gen_ai.usage.cache_creation.input_tokens",
      GenAiUsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
      SyncEvent: "sync.event",
      SyncOutcome: "sync.outcome",
      SyncPayloadBytes: "sync.payload_bytes",
      SyncLatencyMs: "sync.latency_ms",
      GenAiCostUsage: "gen_ai.cost.usage",
      GenAiPermissionDecision: "gen_ai.permission.decision",
      GenAiPermissionSource: "gen_ai.permission.source",
      HarnessName: "harness.name",
    });
  });

  it("exports the exact schema-name and emit metadata literals", () => {
    expect(TelemetrySchemaName).toEqual({
      App: "app",
      Resource: "resource",
      Span: "span",
      GenAi: "gen_ai",
      Sync: "sync",
      Permission: "permission",
    });
    expect(TelemetryEmitMetadataKey).toEqual({
      SchemaName: "telemetry.schema_name",
    });
  });
});
