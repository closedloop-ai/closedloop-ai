import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  SAMPLE_EXPORT_PATH,
  SAMPLE_EXPORT_TARGET,
} from "./sample-export-constants";

const RELATIVE_PATH_PREFIX_PATTERN = /^\.\//;
const HTTP_URL_PATTERN = /^https?:/;

const ConditionalExportSchema = z
  .object({
    types: z.string().optional(),
    default: z.string().optional(),
  })
  .strict();

const PackedExportEntrySchema = z
  .object({
    import: z.union([z.string(), ConditionalExportSchema]).optional(),
    require: z.union([z.string(), ConditionalExportSchema]).optional(),
    default: z.string().optional(),
    types: z.string().optional(),
  })
  .strict();

const PackedPackageJsonSchema = z.object({
  exports: z.record(z.string(), PackedExportEntrySchema),
});
const packageRoot = process.cwd();
const smokeRoot = mkdtempSync(join(tmpdir(), "telemetry-contract-smoke-"));

try {
  const tarballDirectory = join(smokeRoot, "tarball");
  const unpackDirectory = join(smokeRoot, "unpack");
  const consumerDirectory = join(smokeRoot, "consumer");
  const installedPackageDirectory = join(
    consumerDirectory,
    "node_modules",
    "@closedloop-ai",
    "telemetry-contract"
  );

  mkdirSync(tarballDirectory, { recursive: true });
  mkdirSync(unpackDirectory, { recursive: true });
  mkdirSync(installedPackageDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  execFileSync("pnpm", ["pack", "--pack-destination", tarballDirectory], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  const tarballName = readdirSync(tarballDirectory).find((name) =>
    name.endsWith(".tgz")
  );
  if (!tarballName) {
    throw new Error(`No .tgz tarball found in ${tarballDirectory}`);
  }
  const tarballPath = join(tarballDirectory, tarballName);
  execFileSync("tar", ["-xzf", tarballPath, "-C", unpackDirectory], {
    stdio: "inherit",
  });
  cpSync(join(unpackDirectory, "package"), installedPackageDirectory, {
    recursive: true,
  });

  assertExportTypesUseDist(installedPackageDirectory);

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2)
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          resolveJsonModule: true,
          skipLibCheck: true,
        },
        include: ["smoke.ts", "smoke.cts"],
      },
      null,
      2
    )
  );
  // ESM-side smoke. With `"type": "module"` in the consumer's
  // package.json, a `.ts` file is ESM; tsc under moduleResolution: nodenext
  // resolves via the package's "import" condition and uses the .d.ts types.
  writeFileSync(
    join(consumerDirectory, "smoke.ts"),
    [
      'import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";',
      'import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";',
      'import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";',
      'import { ResourceTelemetrySchema } from "@closedloop-ai/telemetry-contract/resource";',
      'import { SpanEnvelopeSchema, SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";',
      'import { GenAiTelemetrySchema } from "@closedloop-ai/telemetry-contract/gen-ai";',
      'import { SyncTelemetrySchema } from "@closedloop-ai/telemetry-contract/sync";',
      'import { PermissionTelemetrySchema } from "@closedloop-ai/telemetry-contract/permission";',
      'import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";',
      'import { type SchemaShape } from "@closedloop-ai/telemetry-contract/schema-shape";',
      'import { validate, validateSpanEnvelope } from "@closedloop-ai/telemetry-contract/validate";',
      'import { createEmit, createSpanEmit, TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";',
      'import { appPayload, spanEnvelopePayload, spanPayload, genAiPayload, syncPayload, permissionPayload } from "@closedloop-ai/telemetry-contract/test-fixtures";',
      'import appSchema from "@closedloop-ai/telemetry-contract/schemas/app.schema.json" with { type: "json" };',
      'import resourceSchema from "@closedloop-ai/telemetry-contract/schemas/resource.schema.json" with { type: "json" };',
      'import spanSchema from "@closedloop-ai/telemetry-contract/schemas/span.schema.json" with { type: "json" };',
      'import genAiSchema from "@closedloop-ai/telemetry-contract/schemas/gen-ai.schema.json" with { type: "json" };',
      'import syncSchema from "@closedloop-ai/telemetry-contract/schemas/sync.schema.json" with { type: "json" };',
      'import permissionSchema from "@closedloop-ai/telemetry-contract/schemas/permission.schema.json" with { type: "json" };',
      "",
      "const resource = ResourceTelemetrySchema.parse({",
      '  [TelemetryAttribute.ServiceName]: "cl-api",',
      "});",
      "const appAttributes: SchemaShape<typeof TelemetrySchemaName.App> = AppTelemetrySchema.parse(appPayload({",
      "  [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,",
      "}));",
      "SpanTelemetrySchema.parse({",
      '  [TelemetryAttribute.HttpRequestMethod]: "GET",',
      "  [TelemetryAttribute.HttpResponseStatusCode]: 200,",
      '  [TelemetryAttribute.UrlPath]: "/api/loops",',
      "  [TelemetryAttribute.DurationMs]: 1,",
      "});",
      "GenAiTelemetrySchema.parse({",
      '  [TelemetryAttribute.GenAiRequestModel]: "gpt-5",',
      "});",
      "SyncTelemetrySchema.parse({",
      '  [TelemetryAttribute.SyncEvent]: "batch",',
      '  [TelemetryAttribute.SyncOutcome]: "success",',
      "});",
      "const spanAttributes: SchemaShape<typeof TelemetrySchemaName.Span> = SpanTelemetrySchema.parse(spanPayload());",
      "const genAiAttributes = GenAiTelemetrySchema.parse(genAiPayload());",
      "const syncAttributes = SyncTelemetrySchema.parse(syncPayload());",
      "const permissionAttributes = PermissionTelemetrySchema.parse(permissionPayload());",
      "const spanEnvelope = SpanEnvelopeSchema.parse(spanEnvelopePayload());",
      "const emitWithChannel = createEmit({",
      "  info(message, meta) {",
      "    console.log(message, meta[TelemetryEmitMetadataKey.SchemaName]);",
      "  },",
      "});",
      "const emitSpanWithChannel = createSpanEmit({",
      "  span(envelope) {",
      "    console.log(envelope.name);",
      "  },",
      "});",
      "emitSpanWithChannel(spanEnvelope);",
      "emitWithChannel(TelemetrySchemaName.Span, {",
      '  name: "http.request",',
      "  attributes: spanAttributes,",
      "});",
      "emitWithChannel(TelemetrySchemaName.App, {",
      '  name: "app.lifecycle",',
      "  attributes: appAttributes,",
      "});",
      "emitWithChannel(TelemetrySchemaName.Sync, {",
      '  name: "sync.batch",',
      "  attributes: syncAttributes,",
      "});",
      "emitWithChannel(TelemetrySchemaName.Permission, {",
      '  name: "gen_ai.permission",',
      "  attributes: permissionAttributes,",
      "});",
      "const appValidation = validate(appAttributes, TelemetrySchemaName.App);",
      "if (!appValidation.ok) {",
      '  throw new Error("app validation failed");',
      "}",
      "const spanValidation = validate(spanAttributes, TelemetrySchemaName.Span);",
      "if (!spanValidation.ok) {",
      '  throw new Error("span validation failed");',
      "}",
      "const genAiValidation = validate(genAiAttributes, TelemetrySchemaName.GenAi);",
      "if (!genAiValidation.ok) {",
      '  throw new Error("gen_ai validation failed");',
      "}",
      "const syncValidation = validate(syncAttributes, TelemetrySchemaName.Sync);",
      "if (!syncValidation.ok) {",
      '  throw new Error("sync validation failed");',
      "}",
      "const permissionValidation = validate(permissionAttributes, TelemetrySchemaName.Permission);",
      "if (!permissionValidation.ok) {",
      '  throw new Error("permission validation failed");',
      "}",
      "const spanEnvelopeValidation = validateSpanEnvelope(spanEnvelope);",
      "if (!spanEnvelopeValidation.ok) {",
      '  throw new Error("span envelope validation failed");',
      "}",
      "console.log(resource, appSchema, resourceSchema, spanSchema, genAiSchema, syncSchema, permissionSchema);",
      "",
    ].join("\n")
  );
  // CJS-side smoke. `.cts` files are CommonJS regardless of the
  // consumer's package.json `type` field. Under moduleResolution: nodenext,
  // tsc resolves these imports via the package's "require" condition and
  // uses the .d.cts types. This catches the dual-mode-types bug class:
  // if `require` resolves to ESM-typed .d.ts, tsc fails with a
  // module-format mismatch.
  writeFileSync(
    join(consumerDirectory, "smoke.cts"),
    [
      'import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";',
      'import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";',
      'import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";',
      'import { ResourceTelemetrySchema } from "@closedloop-ai/telemetry-contract/resource";',
      'import { SpanEnvelopeSchema, SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";',
      'import { GenAiTelemetrySchema } from "@closedloop-ai/telemetry-contract/gen-ai";',
      'import { SyncTelemetrySchema } from "@closedloop-ai/telemetry-contract/sync";',
      'import { PermissionTelemetrySchema } from "@closedloop-ai/telemetry-contract/permission";',
      'import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";',
      'import { type SchemaShape } from "@closedloop-ai/telemetry-contract/schema-shape";',
      'import { validate, validateSpanEnvelope } from "@closedloop-ai/telemetry-contract/validate";',
      'import { createEmit, createSpanEmit, TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";',
      'import { appPayload, spanEnvelopePayload, spanPayload, genAiPayload, syncPayload, permissionPayload } from "@closedloop-ai/telemetry-contract/test-fixtures";',
      'import appSchema = require("@closedloop-ai/telemetry-contract/schemas/app.schema.json");',
      'import syncSchema = require("@closedloop-ai/telemetry-contract/schemas/sync.schema.json");',
      'import permissionSchema = require("@closedloop-ai/telemetry-contract/schemas/permission.schema.json");',
      "",
      "const resource = ResourceTelemetrySchema.parse({",
      '  [TelemetryAttribute.ServiceName]: "cl-api",',
      "});",
      "const appAttributes: SchemaShape<typeof TelemetrySchemaName.App> = AppTelemetrySchema.parse(appPayload({",
      "  [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,",
      "}));",
      "SpanTelemetrySchema.parse({",
      '  [TelemetryAttribute.HttpRequestMethod]: "GET",',
      "  [TelemetryAttribute.HttpResponseStatusCode]: 200,",
      '  [TelemetryAttribute.UrlPath]: "/api/loops",',
      "  [TelemetryAttribute.DurationMs]: 1,",
      "});",
      "GenAiTelemetrySchema.parse({",
      '  [TelemetryAttribute.GenAiRequestModel]: "gpt-5",',
      "});",
      "SyncTelemetrySchema.parse({",
      '  [TelemetryAttribute.SyncEvent]: "batch",',
      '  [TelemetryAttribute.SyncOutcome]: "success",',
      "});",
      "const spanAttributes: SchemaShape<typeof TelemetrySchemaName.Span> = SpanTelemetrySchema.parse(spanPayload());",
      "const genAiAttributes = GenAiTelemetrySchema.parse(genAiPayload());",
      "const syncAttributes = SyncTelemetrySchema.parse(syncPayload());",
      "const permissionAttributes = PermissionTelemetrySchema.parse(permissionPayload());",
      "const spanEnvelope = SpanEnvelopeSchema.parse(spanEnvelopePayload());",
      "const emitWithChannel = createEmit({",
      "  info(message, meta) {",
      "    console.log(message, meta[TelemetryEmitMetadataKey.SchemaName]);",
      "  },",
      "});",
      "const emitSpanWithChannel = createSpanEmit({",
      "  span(envelope) {",
      "    console.log(envelope.name);",
      "  },",
      "});",
      "emitSpanWithChannel(spanEnvelope);",
      "emitWithChannel(TelemetrySchemaName.Span, {",
      '  name: "http.request",',
      "  attributes: spanAttributes,",
      "});",
      "emitWithChannel(TelemetrySchemaName.App, {",
      '  name: "app.lifecycle",',
      "  attributes: appAttributes,",
      "});",
      "emitWithChannel(TelemetrySchemaName.Sync, {",
      '  name: "sync.batch",',
      "  attributes: syncAttributes,",
      "});",
      "emitWithChannel(TelemetrySchemaName.Permission, {",
      '  name: "gen_ai.permission",',
      "  attributes: permissionAttributes,",
      "});",
      "const appValidation = validate(appAttributes, TelemetrySchemaName.App);",
      "if (!appValidation.ok) {",
      '  throw new Error("app validation failed");',
      "}",
      "const spanValidation = validate(spanAttributes, TelemetrySchemaName.Span);",
      "if (!spanValidation.ok) {",
      '  throw new Error("span validation failed");',
      "}",
      "const genAiValidation = validate(genAiAttributes, TelemetrySchemaName.GenAi);",
      "if (!genAiValidation.ok) {",
      '  throw new Error("gen_ai validation failed");',
      "}",
      "const syncValidation = validate(syncAttributes, TelemetrySchemaName.Sync);",
      "if (!syncValidation.ok) {",
      '  throw new Error("sync validation failed");',
      "}",
      "const permissionValidation = validate(permissionAttributes, TelemetrySchemaName.Permission);",
      "if (!permissionValidation.ok) {",
      '  throw new Error("permission validation failed");',
      "}",
      "const spanEnvelopeValidation = validateSpanEnvelope(spanEnvelope);",
      "if (!spanEnvelopeValidation.ok) {",
      '  throw new Error("span envelope validation failed");',
      "}",
      "console.log(resource, appSchema, syncSchema, permissionSchema);",
      "",
    ].join("\n")
  );

  execFileSync(
    "pnpm",
    ["exec", "tsc", "--noEmit", "-p", join(consumerDirectory, "tsconfig.json")],
    {
      cwd: packageRoot,
      stdio: "inherit",
    }
  );
} finally {
  rmSync(smokeRoot, { force: true, recursive: true });
}

function assertExportTypesUseDist(installedPackageDirectory: string) {
  const packageJson = PackedPackageJsonSchema.parse(
    JSON.parse(
      readFileSync(join(installedPackageDirectory, "package.json"), "utf-8")
    )
  );

  if ("." in packageJson.exports) {
    throw new Error("Root package export must not be present");
  }

  assertSampleExport(installedPackageDirectory, packageJson);

  for (const [exportPath, exportValue] of Object.entries(packageJson.exports)) {
    // Top-level "types" fallback (kept for any future flat-shape entries).
    if (exportValue.types !== undefined) {
      assertTypesPathPointsAtDist(
        installedPackageDirectory,
        `${exportPath} (top-level)`,
        exportValue.types
      );
    }
    // Nested conditional types — the supported shape for code subpaths.
    for (const condition of ["import", "require"] as const) {
      const conditionValue = exportValue[condition];
      if (
        conditionValue === undefined ||
        typeof conditionValue === "string" ||
        conditionValue.types === undefined
      ) {
        continue;
      }
      assertTypesPathPointsAtDist(
        installedPackageDirectory,
        `${exportPath} (${condition})`,
        conditionValue.types
      );
    }
  }
}

function assertSampleExport(
  installedPackageDirectory: string,
  packageJson: z.infer<typeof PackedPackageJsonSchema>
) {
  const sampleExport = packageJson.exports[SAMPLE_EXPORT_PATH];
  if (!sampleExport) {
    throw new Error("Sample export is missing");
  }
  const exportKeys = Object.keys(sampleExport);
  if (
    exportKeys.length !== 1 ||
    exportKeys[0] !== "default" ||
    sampleExport.default !== SAMPLE_EXPORT_TARGET
  ) {
    throw new Error("Sample export must point only at dist sample");
  }
  if (
    sampleExport.default.includes("./samples/") ||
    sampleExport.default.includes("./src/") ||
    HTTP_URL_PATTERN.test(sampleExport.default)
  ) {
    throw new Error("Sample export points at a private or remote target");
  }
  const absoluteSamplePath = join(
    installedPackageDirectory,
    sampleExport.default.replace(RELATIVE_PATH_PREFIX_PATTERN, "")
  );
  if (!existsSync(absoluteSamplePath)) {
    throw new Error(
      `Sample export target is missing: ${basename(absoluteSamplePath)}`
    );
  }
}

function assertTypesPathPointsAtDist(
  installedPackageDirectory: string,
  label: string,
  typesPath: string
) {
  if (typesPath.startsWith("./src/")) {
    throw new Error(`${label} points types at private source`);
  }
  if (!typesPath.startsWith("./dist/")) {
    throw new Error(`${label} types must point at dist`);
  }
  const absoluteTypesPath = join(
    installedPackageDirectory,
    typesPath.replace(RELATIVE_PATH_PREFIX_PATTERN, "")
  );
  if (!existsSync(absoluteTypesPath)) {
    throw new Error(
      `${label} types path is missing: ${basename(absoluteTypesPath)}`
    );
  }
}
