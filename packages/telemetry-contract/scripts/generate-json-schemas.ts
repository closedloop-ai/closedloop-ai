import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AppTelemetrySchema } from "../app";
import { PermissionTelemetrySchema } from "../permission";
import { TelemetryAttribute } from "../src/attributes";
import { GenAiTelemetrySchema } from "../src/gen-ai";
import { ResourceTelemetrySchema } from "../src/resource";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import { SpanTelemetrySchema } from "../src/span";
import { SyncTelemetrySchema } from "../sync";

const SCHEMA_DIRECTORY = "dist/schemas";
const NO_CONTROL_CHARACTERS_JSON_PATTERN = "^[^\\u0000-\\u001f\\u007f]+$";
const URL_PATH_JSON_PATTERN =
  "^(?!//)(?!/[^/?#]*:[^/?#]*@)(?!.*://)(?!.*[?#])/[^\\u0000-\\u001f\\u007f]*$";

const ToJSONSchemaOutputShape = z
  .object({
    properties: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .loose();

type JsonSchema = z.infer<typeof ToJSONSchemaOutputShape>;

const schemas = [
  {
    path: `${SCHEMA_DIRECTORY}/app.schema.json`,
    id: "https://closedloop.ai/schemas/telemetry-contract/app/v0.3.schema.json",
    schema: AppTelemetrySchema,
  },
  {
    path: `${SCHEMA_DIRECTORY}/resource.schema.json`,
    id: "https://closedloop.ai/schemas/telemetry-contract/resource/v0.4.schema.json",
    schema: ResourceTelemetrySchema,
  },
  {
    path: `${SCHEMA_DIRECTORY}/span.schema.json`,
    id: "https://closedloop.ai/schemas/telemetry-contract/span/v0.1.schema.json",
    schema: SpanTelemetrySchema,
  },
  {
    path: `${SCHEMA_DIRECTORY}/gen-ai.schema.json`,
    id: "https://closedloop.ai/schemas/telemetry-contract/gen-ai/v0.4.schema.json",
    schema: GenAiTelemetrySchema,
  },
  {
    path: `${SCHEMA_DIRECTORY}/sync.schema.json`,
    id: "https://closedloop.ai/schemas/telemetry-contract/sync/v0.3.schema.json",
    schema: SyncTelemetrySchema,
  },
  {
    path: `${SCHEMA_DIRECTORY}/permission.schema.json`,
    id: "https://closedloop.ai/schemas/telemetry-contract/permission/v0.4.schema.json",
    schema: PermissionTelemetrySchema,
  },
] as const;

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
  }
  if (path.endsWith("app.schema.json")) {
    setBoundedTextProperty(
      schema,
      TelemetryAttribute.AppInstallationId,
      TelemetryTextMaxLength.AppInstallationId
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
