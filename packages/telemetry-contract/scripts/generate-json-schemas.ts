import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AppTelemetrySchema } from "../app";
import { IpcTelemetrySchema } from "../ipc";
import { PermissionTelemetrySchema } from "../permission";
import { TelemetryAttribute } from "../src/attributes";
import { GenAiOperationName, GenAiTelemetrySchema } from "../src/gen-ai";
import { ResourceTelemetrySchema } from "../src/resource";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import { SpanTelemetrySchema } from "../src/span";
import { SyncTelemetrySchema } from "../sync";
import { type SchemaPath, schemaManifest } from "./schema-manifest";

const SCHEMA_DIRECTORY = "dist/schemas";
const NO_CONTROL_CHARACTERS_JSON_PATTERN = "^[^\\u0000-\\u001f\\u007f]+$";
const URL_PATH_JSON_PATTERN =
  "^(?!//)(?!/[^/?#]*:[^/?#]*@)(?!.*://)(?!.*[?#])/[^\\u0000-\\u001f\\u007f]*$";
// ISS-7217/ISS-7224: these mirror `ERROR_TYPE_PATTERN` and
// `ARTIFACT_TOKEN_PATTERN` in `src/span.ts`. The Zod refinement and the
// published JSON Schema must reject the same strings — an off-contract consumer
// validating against the JSON Schema alone is exactly who the narrow shape is
// protecting.
const ERROR_TYPE_JSON_PATTERN = "^[A-Za-z_$][A-Za-z0-9_$.]*$";
const ARTIFACT_TOKEN_JSON_PATTERN = "^[A-Z][A-Z0-9_]*$";

const ToJSONSchemaOutputShape = z
  .object({
    properties: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .loose();

type JsonSchema = z.infer<typeof ToJSONSchemaOutputShape>;

// Keyed by SchemaPath, so a path in one list and not the other fails `tsc`:
// a manifest entry with no Zod schema is a missing key, and a Zod schema with
// no manifest entry — which would silently never be generated — is an excess
// one. The two lists cannot drift apart without CI going red.
const zodSchemaByPath: Record<SchemaPath, z.ZodType> = {
  "dist/schemas/app.schema.json": AppTelemetrySchema,
  "dist/schemas/resource.schema.json": ResourceTelemetrySchema,
  "dist/schemas/span.schema.json": SpanTelemetrySchema,
  "dist/schemas/gen-ai.schema.json": GenAiTelemetrySchema,
  "dist/schemas/sync.schema.json": SyncTelemetrySchema,
  "dist/schemas/permission.schema.json": PermissionTelemetrySchema,
  "dist/schemas/ipc.schema.json": IpcTelemetrySchema,
};

const schemas = schemaManifest.map((entry) => ({
  ...entry,
  schema: zodSchemaByPath[entry.path],
}));

mkdirSync(SCHEMA_DIRECTORY, { recursive: true });

for (const schemaDefinition of schemas) {
  const jsonSchema = addContractPatterns(
    schemaDefinition.path,
    ToJSONSchemaOutputShape.parse(z.toJSONSchema(schemaDefinition.schema))
  );
  writeFileSync(
    schemaDefinition.path,
    `${JSON.stringify(
      {
        $id: schemaDefinition.id,
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...jsonSchema,
      },
      null,
      2
    )}\n`
  );
}

function addContractPatterns(path: string, schema: JsonSchema): JsonSchema {
  if (path.endsWith("resource.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ServiceName,
      TelemetryTextMaxLength.ServiceName
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ServiceVersion,
      TelemetryTextMaxLength.ServiceVersion
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.DeviceId,
      TelemetryTextMaxLength.DeviceId
    );
  }
  if (path.endsWith("app.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.AppInstallationId,
      TelemetryTextMaxLength.AppInstallationId
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.AppOrganizationId,
      TelemetryTextMaxLength.AppOrganizationId
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.DeploymentEnvironmentName,
      TelemetryTextMaxLength.DeploymentEnvironmentName
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ExceptionType,
      TelemetryTextMaxLength.ExceptionType
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ExceptionMessage,
      TelemetryTextMaxLength.ExceptionMessage
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ExceptionStacktrace,
      TelemetryTextMaxLength.ExceptionStacktrace
    );
  }
  if (path.endsWith("span.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.UrlPath,
      TelemetryTextMaxLength.UrlPath,
      URL_PATH_JSON_PATTERN
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.CodeFunctionName,
      TelemetryTextMaxLength.CodeFunctionName
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.CodeFilePath,
      TelemetryTextMaxLength.CodeFilePath
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ErrorType,
      TelemetryTextMaxLength.ErrorType,
      ERROR_TYPE_JSON_PATTERN
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.AppOrganizationId,
      TelemetryTextMaxLength.AppOrganizationId
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ArtifactType,
      TelemetryTextMaxLength.ArtifactType,
      ARTIFACT_TOKEN_JSON_PATTERN
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ArtifactStatus,
      TelemetryTextMaxLength.ArtifactStatus,
      ARTIFACT_TOKEN_JSON_PATTERN
    );
  }
  if (path.endsWith("sync.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.AppOrganizationId,
      TelemetryTextMaxLength.AppOrganizationId
    );
  }
  if (path.endsWith("ipc.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.ErrorType,
      TelemetryTextMaxLength.ErrorType
    );
  }
  if (path.endsWith("gen-ai.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.GenAiRequestModel,
      TelemetryTextMaxLength.GenAiRequestModel
    );
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.GenAiResponseId,
      TelemetryTextMaxLength.GenAiResponseId
    );
    // ISS-11347: the published `samples/validate-perf-jsonl.sh` reads this
    // schema and accepts only type, bound and pattern keywords, so the closed
    // set is spelled as an anchored pattern rather than `enum`.
    schema.properties[TelemetryAttribute.GenAiOperationName] = {
      type: "string",
      pattern: `^(${Object.values(GenAiOperationName).join("|")})$`,
    };
  }
  return schema;
}

function setBoundedTextProperty(
  schema: JsonSchema,
  propertyName: string,
  maxLength: number,
  pattern = NO_CONTROL_CHARACTERS_JSON_PATTERN
) {
  const property = schema.properties[propertyName];
  if (!property) {
    throw new Error(`Schema is missing property ${propertyName}`);
  }
  property.pattern = pattern;
  property.maxLength = maxLength;
}
