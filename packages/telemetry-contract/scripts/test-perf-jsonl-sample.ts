import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TelemetryAttribute } from "../src/attributes";
import {
  SAMPLE_DIST_PATH,
  SAMPLE_SOURCE_PATH,
} from "./sample-export-constants";

const GENERATED_GEN_AI_SCHEMA_PATH = "dist/schemas/gen-ai.schema.json";
const SAMPLE_TEMP_PREFIX = "perf-jsonl-schema.";
const CHILD_TIMEOUT_MS = 5000;
const STALLED_FETCH_TIMEOUT_MS = 20_000;
const CURL_STALL_MAX_TIME_SECONDS = "2";
const SECRET_ROW_TEXT = "row-secret-must-not-leak";
const SECRET_SCHEMA_TEXT = "schema-secret-must-not-leak";
const SECRET_HTTP_TEXT = "http-secret-must-not-leak";
const GEN_AI_SCHEMA_NAME = "gen_ai";
const ROW_ERROR_PREFIX_PATTERN = /perf\.jsonl row \d+:/;
const SCHEMA_MAX_BYTES_DECLARATION_PATTERN =
  /^readonly SCHEMA_MAX_BYTES=(\d+)$/m;
const mode = parseMode();
const packageRoot = process.cwd();
const smokeRoot = mkdtempSync(join(tmpdir(), "telemetry-contract-sample-"));
const samplePath = join(
  packageRoot,
  mode === "source" ? SAMPLE_SOURCE_PATH : SAMPLE_DIST_PATH
);
const SCHEMA_MAX_BYTES = readSampleSchemaMaxBytes(samplePath);

type SampleMode = "source" | "dist";

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
};

type RunOptions = {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
};

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
  process.exit(1);
});

async function main() {
  try {
    assertToolAvailable("jq");
    assertSampleIsRunnable(samplePath);
    await assertCommandHelperReportsSpawnAndTimeoutFailures();

    if (mode === "source") {
      await runSourceMode();
      return;
    }

    assertToolAvailable("curl");
    await runDistMode();
  } finally {
    rmSync(smokeRoot, { force: true, recursive: true });
  }
}

async function runSourceMode() {
  const schema = genAiSchemaFixture();
  const schemaPath = writeJson("source-gen-ai.schema.json", schema);
  const inputPath = writeJsonl("source-valid.jsonl", [
    canonicalRow({
      [TelemetryAttribute.GenAiUsageInputTokens]: 10,
    }),
  ]);

  await expectSuccess(["--schema", schemaPath, inputPath]);
  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify({})}\n`,
    },
    missingRequiredError(1, TelemetryAttribute.GenAiRequestModel)
  );
  await assertRowFailures(schemaPath, schema);
  await assertSchemaSetupFailures(schemaPath, schema);
}

async function runDistMode() {
  const schemaPath = join(packageRoot, GENERATED_GEN_AI_SCHEMA_PATH);
  invariant(
    existsSync(schemaPath),
    "dist GenAI schema must exist before dist mode"
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as JsonSchema;

  await assertCanonicalRows(schemaPath);
  await assertRowFailures(schemaPath, schema);
  await assertLegacyAliases(schemaPath);
  await assertTemporaryRequiredAttribute(schema);
  await assertUrlSchemaFetches(schemaPath);
  await assertSchemaSetupFailures(schemaPath, schema);
  await assertUrlTempFilesAreCleaned(schemaPath);
}

async function assertCanonicalRows(schemaPath: string) {
  const filePath = writeJsonl("valid-file.jsonl", [
    canonicalRow({
      [TelemetryAttribute.GenAiResponseId]: "resp_abc",
      [TelemetryAttribute.GenAiUsageInputTokens]: 10,
      [TelemetryAttribute.GenAiUsageOutputTokens]: 20,
      [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]: 3,
      [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: 4,
    }),
  ]);

  await expectSuccess(["--schema", schemaPath, filePath]);
  await expectSuccess(["--schema", schemaPath], {
    stdin: `${JSON.stringify(canonicalRow())}\n`,
  });
}

async function assertRowFailures(schemaPath: string, schema: JsonSchema) {
  await expectFailure(
    ["--schema", schemaPath],
    { stdin: `${JSON.stringify({})}\n` },
    missingRequiredError(1, TelemetryAttribute.GenAiRequestModel)
  );

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify({
        ...canonicalRow(),
        "gen_ai.system": "anthropic",
      })}\n`,
    },
    unknownAttributeError(1, "gen_ai.system")
  );

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify(
        canonicalRow({ [TelemetryAttribute.GenAiUsageInputTokens]: "10" })
      )}\n`,
    },
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiUsageInputTokens,
      "expected integer"
    )
  );

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify(
        canonicalRow({ [TelemetryAttribute.GenAiUsageInputTokens]: -1 })
      )}\n`,
    },
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiUsageInputTokens,
      "must be >= 0"
    )
  );

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify(
        canonicalRow({
          [TelemetryAttribute.GenAiUsageInputTokens]: 1_000_000_001,
        })
      )}\n`,
    },
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiUsageInputTokens,
      "must be <= 1000000000"
    )
  );

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify(
        canonicalRow({ [TelemetryAttribute.GenAiRequestModel]: "" })
      )}\n`,
    },
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiRequestModel,
      "must have length >= 1"
    )
  );

  const rawLongModel = `${SECRET_ROW_TEXT}-${"x".repeat(256)}`;
  const maxLengthResult = await runSample(["--schema", schemaPath], {
    stdin: `${JSON.stringify(
      canonicalRow({ [TelemetryAttribute.GenAiRequestModel]: rawLongModel })
    )}\n`,
  });
  assertFailure(
    maxLengthResult,
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiRequestModel,
      "must have length <= 256"
    )
  );
  doesNotMatch(maxLengthResult.stderr, new RegExp(SECRET_ROW_TEXT));

  const malformedRow = `{"${SECRET_ROW_TEXT}":`;
  const invalidJson = await runSample(["--schema", schemaPath], {
    stdin: `${malformedRow}\n`,
  });
  assertFailure(invalidJson, invalidJsonError(1));
  doesNotMatch(invalidJson.stderr, new RegExp(SECRET_ROW_TEXT));

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: [
        JSON.stringify(canonicalRow()),
        JSON.stringify({}),
        JSON.stringify(canonicalRow()),
      ].join("\n"),
    },
    missingRequiredError(2, TelemetryAttribute.GenAiRequestModel)
  );

  const longModelSchema = writeJson("model-pattern.schema.json", {
    ...schema,
    properties: {
      ...schema.properties,
      [TelemetryAttribute.GenAiRequestModel]: {
        ...schema.properties[TelemetryAttribute.GenAiRequestModel],
        pattern: "^claude-[0-9]+$",
      },
    },
  });
  await expectFailure(
    ["--schema", longModelSchema],
    { stdin: `${JSON.stringify(canonicalRow())}\n` },
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiRequestModel,
      "must match pattern"
    )
  );

  await assertContractPatternFastPaths();
}

async function assertContractPatternFastPaths() {
  const schemaPath = writeJson("contract-pattern-fast-paths.schema.json", {
    $id: "https://closedloop.ai/schemas/telemetry-contract/gen-ai/v0.1.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      [TelemetryAttribute.GenAiRequestModel]: {
        type: "string",
        pattern: "^[^\\u0000-\\u001f\\u007f]+$",
      },
      [TelemetryAttribute.UrlPath]: {
        type: "string",
        pattern:
          "^(?!//)(?!/[^/?#]*:[^/?#]*@)(?!.*://)(?!.*[?#])/[^\\u0000-\\u001f\\u007f]*$",
      },
    },
    required: [
      TelemetryAttribute.GenAiRequestModel,
      TelemetryAttribute.UrlPath,
    ],
  });
  const validPatternRow = {
    [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
    [TelemetryAttribute.UrlPath]: "/api/loops",
  };

  await expectSuccess(["--schema", schemaPath], {
    stdin: `${JSON.stringify(validPatternRow)}\n`,
  });

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify({
        ...validPatternRow,
        [TelemetryAttribute.GenAiRequestModel]: `model${String.fromCharCode(1)}`,
      })}\n`,
    },
    invalidAttributeError(
      1,
      TelemetryAttribute.GenAiRequestModel,
      "must match pattern"
    )
  );

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify({
        ...validPatternRow,
        [TelemetryAttribute.UrlPath]: "//api/loops",
      })}\n`,
    },
    invalidAttributeError(1, TelemetryAttribute.UrlPath, "must match pattern")
  );
}

async function assertLegacyAliases(schemaPath: string) {
  const aliasCases = [
    {
      legacy: "model",
      canonical: TelemetryAttribute.GenAiRequestModel,
      value: "gpt-5",
      conflict: "claude-opus",
    },
    {
      legacy: "input_tokens",
      canonical: TelemetryAttribute.GenAiUsageInputTokens,
      value: 10,
      conflict: 11,
    },
    {
      legacy: "output_tokens",
      canonical: TelemetryAttribute.GenAiUsageOutputTokens,
      value: 20,
      conflict: 21,
    },
    {
      legacy: "cache_creation_input_tokens",
      canonical: TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
      value: 3,
      conflict: 4,
    },
    {
      legacy: "cache_read_input_tokens",
      canonical: TelemetryAttribute.GenAiUsageCacheReadInputTokens,
      value: 5,
      conflict: 6,
    },
  ] as const;

  for (const aliasCase of aliasCases) {
    const aliasOnly =
      aliasCase.legacy === "model"
        ? { [aliasCase.legacy]: aliasCase.value }
        : { ...canonicalRow(), [aliasCase.legacy]: aliasCase.value };
    await expectSuccess(["--schema", schemaPath], {
      stdin: `${JSON.stringify(aliasOnly)}\n`,
    });

    await expectSuccess(["--schema", schemaPath], {
      stdin: `${JSON.stringify({
        ...canonicalRow({ [aliasCase.canonical]: aliasCase.value }),
        [aliasCase.legacy]: aliasCase.value,
      })}\n`,
    });

    await expectFailure(
      ["--schema", schemaPath],
      {
        stdin: `${JSON.stringify({
          ...canonicalRow({ [aliasCase.canonical]: aliasCase.value }),
          [aliasCase.legacy]: aliasCase.conflict,
        })}\n`,
      },
      legacyConflictError(1, aliasCase.legacy, aliasCase.canonical)
    );
  }

  await expectFailure(
    ["--schema", schemaPath],
    {
      stdin: `${JSON.stringify({
        ...canonicalRow(),
        total_tokens: 30,
      })}\n`,
    },
    unknownAttributeError(1, "total_tokens")
  );
}

async function assertTemporaryRequiredAttribute(schema: JsonSchema) {
  const requiredInputSchema = writeJson("required-input-tokens.schema.json", {
    ...schema,
    required: [
      ...(schema.required ?? []),
      TelemetryAttribute.GenAiUsageInputTokens,
    ],
  });

  await expectFailure(
    ["--schema", requiredInputSchema],
    { stdin: `${JSON.stringify(canonicalRow())}\n` },
    missingRequiredError(1, TelemetryAttribute.GenAiUsageInputTokens)
  );
}

async function assertUrlSchemaFetches(schemaPath: string) {
  const schemaSource = readFileSync(schemaPath, "utf-8");
  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(schemaSource);
    },
    async (url) => {
      await expectSuccess(["--schema", `${url}/gen-ai.schema.json`], {
        stdin: `${JSON.stringify(canonicalRow())}\n`,
      });
    }
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(SECRET_HTTP_TEXT);
    },
    async (url) => {
      const result = await runSample(
        ["--schema", `${url}/missing.schema.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: fetch failed");
      doesNotMatch(result.stderr, new RegExp(SECRET_HTTP_TEXT));
    }
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(302, { location: "file:///etc/passwd" });
      response.end();
    },
    async (url) => {
      const result = await runSample(
        ["--schema", `${url}/redirect.schema.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: fetch failed");
    }
  );

  await withHttpServer(
    (_request, _response) => {
      // Leave the response open so curl's finite max-time path is exercised.
    },
    async (url) => {
      const result = await runSample(["--schema", `${url}/stall.schema.json`], {
        env: {
          ...process.env,
          PERF_JSONL_VALIDATE_CURL_MAX_TIME: CURL_STALL_MAX_TIME_SECONDS,
        },
        stdin: `${JSON.stringify(canonicalRow())}\n`,
        timeoutMs: STALLED_FETCH_TIMEOUT_MS,
      });
      assertSetupFailure(result, "perf.jsonl schema: fetch failed");
    }
  );

  const closedPort = await closedLocalPort();
  const closedPortResult = await runSample(
    ["--schema", `http://127.0.0.1:${closedPort}/gen-ai.schema.json`],
    {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }
  );
  assertSetupFailure(closedPortResult, "perf.jsonl schema: fetch failed");
}

async function assertSchemaSetupFailures(
  schemaPath: string,
  schema: JsonSchema
) {
  const oversizedSchemaPath = join(smokeRoot, "oversized.schema.json");
  writeFileSync(oversizedSchemaPath, `${" ".repeat(SCHEMA_MAX_BYTES + 1)}\n`);
  assertSetupFailure(
    await runSample(["--schema", oversizedSchemaPath], {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }),
    "perf.jsonl schema: schema too large"
  );

  const malformedSchemaPath = join(smokeRoot, "malformed.schema.json");
  writeFileSync(malformedSchemaPath, `{"${SECRET_SCHEMA_TEXT}":`);
  const malformedSchemaResult = await runSample(
    ["--schema", malformedSchemaPath],
    {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }
  );
  assertSetupFailure(
    malformedSchemaResult,
    "perf.jsonl schema: malformed JSON"
  );
  doesNotMatch(malformedSchemaResult.stderr, new RegExp(SECRET_SCHEMA_TEXT));
  doesNotMatch(
    malformedSchemaResult.stderr,
    new RegExp(escapeRegExp(smokeRoot))
  );

  const unsupportedSchemaPath = writeJson("unsupported.schema.json", {
    $id: "https://closedloop.ai/schemas/telemetry-contract/gen-ai/v0.1.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      [TelemetryAttribute.GenAiRequestModel]: {
        type: "string",
        enum: ["gpt-5"],
      },
    },
    required: [TelemetryAttribute.GenAiRequestModel],
  });
  assertSetupFailure(
    await runSample(["--schema", unsupportedSchemaPath], {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }),
    "perf.jsonl schema: unsupported schema shape"
  );

  const malformedPatternSchemaPath = writeJson(
    "malformed-pattern.schema.json",
    {
      ...schema,
      properties: {
        ...schema.properties,
        [TelemetryAttribute.GenAiResponseId]: {
          ...schema.properties[TelemetryAttribute.GenAiResponseId],
          pattern: "[",
        },
      },
    }
  );
  assertSetupFailure(
    await runSample(["--schema", malformedPatternSchemaPath], {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }),
    "perf.jsonl schema: unsupported schema shape"
  );

  assertSetupFailure(
    await runSample(["--schema", "file:///etc/passwd"], {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }),
    "perf.jsonl schema: unsupported location"
  );

  assertSetupFailure(
    await runSample(["--schema", join(smokeRoot, "missing.schema.json")], {
      stdin: `${JSON.stringify(canonicalRow())}\n`,
    }),
    "perf.jsonl schema: schema file not found"
  );

  invariant(existsSync(schemaPath), "schema path sanity check");
}

async function assertUrlTempFilesAreCleaned(schemaPath: string) {
  const tmpRoot = join(smokeRoot, "url-tmp");
  rmSync(tmpRoot, { force: true, recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  const schemaSource = readFileSync(schemaPath, "utf-8");
  const runWithTmpDir = (args: string[], options: RunOptions = {}) =>
    runSample(args, {
      ...options,
      env: { ...process.env, ...options.env, TMPDIR: tmpRoot },
    });

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(schemaSource);
    },
    async (url) => {
      const result = await runWithTmpDir(["--schema", `${url}/schema.json`], {
        stdin: `${JSON.stringify(canonicalRow())}\n`,
      });
      assertSuccess(result);
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(schemaSource);
    },
    async (url) => {
      const result = await runWithTmpDir(["--schema", `${url}/schema.json`], {
        stdin: `${JSON.stringify({})}\n`,
      });
      assertFailure(
        result,
        missingRequiredError(1, TelemetryAttribute.GenAiRequestModel)
      );
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(SECRET_HTTP_TEXT);
    },
    async (url) => {
      const result = await runWithTmpDir(["--schema", `${url}/missing.json`], {
        stdin: `${JSON.stringify(canonicalRow())}\n`,
      });
      assertSetupFailure(result, "perf.jsonl schema: fetch failed");
      doesNotMatch(result.stderr, new RegExp(SECRET_HTTP_TEXT));
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      response.writeHead(302, { location: "file:///etc/passwd" });
      response.end();
    },
    async (url) => {
      const result = await runWithTmpDir(["--schema", `${url}/redirect.json`], {
        stdin: `${JSON.stringify(canonicalRow())}\n`,
      });
      assertSetupFailure(result, "perf.jsonl schema: fetch failed");
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"${SECRET_SCHEMA_TEXT}":`);
    },
    async (url) => {
      const result = await runWithTmpDir(
        ["--schema", `${url}/malformed.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: malformed JSON");
      doesNotMatch(result.stderr, new RegExp(SECRET_SCHEMA_TEXT));
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...genAiSchemaFixture(),
          properties: {
            ...genAiSchemaFixture().properties,
            [TelemetryAttribute.GenAiRequestModel]: {
              type: "string",
              enum: ["gpt-5"],
            },
          },
        })
      );
    },
    async (url) => {
      const result = await runWithTmpDir(
        ["--schema", `${url}/unsupported.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: unsupported schema shape");
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      const oversizedBody = oversizedSchemaBody();
      response.writeHead(200, {
        "content-length": Buffer.byteLength(oversizedBody),
        "content-type": "application/json",
      });
      response.end(oversizedBody);
    },
    async (url) => {
      const result = await runWithTmpDir(
        ["--schema", `${url}/oversized.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: schema too large");
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      writeChunkedOversizedSchemaResponse(response);
    },
    async (url) => {
      const result = await runWithTmpDir(
        ["--schema", `${url}/oversized-unknown-length.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: schema too large");
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, response) => {
      const oversizedBody = `{"truncated":${" ".repeat(SCHEMA_MAX_BYTES + 1)}}`;
      response.writeHead(200, {
        "content-length": 2,
        "content-type": "application/json",
      });
      response.end(oversizedBody);
    },
    async (url) => {
      const result = await runWithTmpDir(
        ["--schema", `${url}/oversized-misleading-length.json`],
        {
          stdin: `${JSON.stringify(canonicalRow())}\n`,
        }
      );
      assertSetupFailure(result, "perf.jsonl schema: malformed JSON");
    }
  );
  assertNoSampleTempFiles(tmpRoot);

  await withHttpServer(
    (_request, _response) => {
      // Leave the response open until the harness timeout kills the sample.
    },
    async (url) => {
      const result = await runWithTmpDir(["--schema", `${url}/stall.json`], {
        stdin: `${JSON.stringify(canonicalRow())}\n`,
        timeoutMs: 100,
      });
      equal(result.error, null);
      equal(result.timedOut, true);
    }
  );
  assertNoSampleTempFiles(tmpRoot);
}

function genAiSchemaFixture(): JsonSchema {
  return {
    $id: "https://closedloop.ai/schemas/telemetry-contract/gen-ai/v0.1.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      [TelemetryAttribute.GenAiRequestModel]: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "^[^\\u0000-\\u001f\\u007f]+$",
      },
      [TelemetryAttribute.GenAiUsageInputTokens]: {
        type: "integer",
        minimum: 0,
        maximum: 1_000_000_000,
      },
      [TelemetryAttribute.GenAiUsageOutputTokens]: {
        type: "integer",
        minimum: 0,
        maximum: 1_000_000_000,
      },
      [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]: {
        type: "integer",
        minimum: 0,
        maximum: 1_000_000_000,
      },
      [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: {
        type: "integer",
        minimum: 0,
        maximum: 1_000_000_000,
      },
    },
    required: [TelemetryAttribute.GenAiRequestModel],
  };
}

function canonicalRow(overrides: Record<string, unknown> = {}) {
  return {
    [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
    ...overrides,
  };
}

function writeJson(fileName: string, value: unknown): string {
  const filePath = join(smokeRoot, fileName);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function writeJsonl(fileName: string, rows: Record<string, unknown>[]): string {
  const filePath = join(smokeRoot, fileName);
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
  return filePath;
}

function readSampleSchemaMaxBytes(path: string): number {
  const source = readFileSync(path, "utf-8");
  const match = SCHEMA_MAX_BYTES_DECLARATION_PATTERN.exec(source);
  invariant(match?.[1], "Sample script must declare SCHEMA_MAX_BYTES");
  return Number.parseInt(match[1], 10);
}

function oversizedSchemaBody(): string {
  return `${" ".repeat(SCHEMA_MAX_BYTES + 1)}\n`;
}

function writeChunkedOversizedSchemaResponse(response: ServerResponse) {
  response.writeHead(200, { "content-type": "application/json" });
  let remainingBytes = SCHEMA_MAX_BYTES + 2;
  while (remainingBytes > 0) {
    const chunkSize = Math.min(65_536, remainingBytes);
    response.write(" ".repeat(chunkSize));
    remainingBytes -= chunkSize;
  }
  response.end();
}

async function expectSuccess(args: string[], options: RunOptions = {}) {
  assertSuccess(await runSample(args, options));
}

async function expectFailure(
  args: string[],
  options: RunOptions,
  stderrMessage: string
) {
  assertFailure(await runSample(args, options), stderrMessage);
}

function runSample(args: string[], options: RunOptions = {}) {
  return runCommand(samplePath, args, options);
}

function assertSuccess(result: CommandResult) {
  equal(result.error, null);
  equal(result.timedOut, false);
  equal(result.code, 0, result.stderr);
  equal(result.signal, null);
  equal(result.stderr, "");
}

function assertFailure(result: CommandResult, stderrMessage: string) {
  equal(result.error, null);
  equal(result.timedOut, false);
  notEqual(result.code, 0);
  matches(result.stderr, new RegExp(escapeRegExp(stderrMessage)));
  equal(result.stdout, "");
}

function assertSetupFailure(result: CommandResult, stderrMessage: string) {
  assertFailure(result, stderrMessage);
  doesNotMatch(result.stderr, ROW_ERROR_PREFIX_PATTERN);
}

function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? CHILD_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut, error: null });
    });

    if (options.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.stdin);
    }
  });
}

async function assertCommandHelperReportsSpawnAndTimeoutFailures() {
  const spawnFailure = await runCommand(
    join(smokeRoot, "definitely-missing-command"),
    [],
    { timeoutMs: 100 }
  );
  invariant(spawnFailure.error, "spawn failures must resolve with error state");

  const timeoutFailure = await runCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000);"],
    { timeoutMs: 50 }
  );
  equal(timeoutFailure.timedOut, true);
  equal(timeoutFailure.signal, "SIGTERM");
}

async function withHttpServer(
  handler: HttpHandler,
  callback: (baseUrl: string) => Promise<void>
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "HTTP server must bind");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections();
    });
  }
}

async function closedLocalPort(): Promise<number> {
  const server = createServer((_request, response) => {
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "HTTP server must bind");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

function assertNoSampleTempFiles(directory: string) {
  if (!existsSync(directory)) {
    return;
  }
  const leaked = readdirSync(directory).filter((entry) =>
    entry.startsWith(SAMPLE_TEMP_PREFIX)
  );
  equal(leaked.length, 0, `Sample temp files leaked: ${leaked.join(", ")}`);
}

function assertSampleIsRunnable(path: string) {
  invariant(existsSync(path), `Sample script is missing: ${basename(path)}`);
  const sampleStat = statSync(path);
  invariant(sampleStat.size > 0, "Sample script must not be empty");
  if (process.platform !== "win32") {
    notEqual(
      executableMode(sampleStat.mode),
      0,
      "Sample script must be executable"
    );
  }
}

function assertToolAvailable(toolName: string) {
  const result = spawnSync("which", [toolName], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`${toolName} is required to run perf.jsonl sample tests`);
  }
}

function parseMode(): SampleMode {
  const modeIndex = process.argv.indexOf("--mode");
  const value = modeIndex === -1 ? "dist" : process.argv[modeIndex + 1];
  if (value === "source" || value === "dist") {
    return value;
  }
  throw new Error("--mode must be source or dist");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function missingRequiredError(rowNumber: number, attribute: string): string {
  return `perf.jsonl row ${rowNumber}: missing required attribute '${attribute}' (schema: ${GEN_AI_SCHEMA_NAME})`;
}

function unknownAttributeError(rowNumber: number, attribute: string): string {
  return `perf.jsonl row ${rowNumber}: unknown attribute '${attribute}' (schema: ${GEN_AI_SCHEMA_NAME})`;
}

function invalidJsonError(rowNumber: number): string {
  return `perf.jsonl row ${rowNumber}: invalid JSON (schema: ${GEN_AI_SCHEMA_NAME})`;
}

function invalidAttributeError(
  rowNumber: number,
  attribute: string,
  reason: string
): string {
  return `perf.jsonl row ${rowNumber}: invalid attribute '${attribute}': ${reason} (schema: ${GEN_AI_SCHEMA_NAME})`;
}

function legacyConflictError(
  rowNumber: number,
  legacyAttribute: string,
  canonicalAttribute: string
): string {
  return `perf.jsonl row ${rowNumber}: conflicting legacy attribute '${legacyAttribute}' with canonical attribute '${canonicalAttribute}' (schema: ${GEN_AI_SCHEMA_NAME})`;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function equal<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message ??
        `Expected ${formatValue(actual)} to equal ${formatValue(expected)}`
    );
  }
}

function notEqual<T>(actual: T, expected: T, message?: string) {
  if (actual === expected) {
    throw new Error(
      message ??
        `Expected ${formatValue(actual)} not to equal ${formatValue(expected)}`
    );
  }
}

function matches(value: string, pattern: RegExp) {
  if (!pattern.test(value)) {
    throw new Error(`Expected ${formatValue(value)} to match ${pattern}`);
  }
}

function doesNotMatch(value: string, pattern: RegExp) {
  if (pattern.test(value)) {
    throw new Error(`Expected ${formatValue(value)} not to match ${pattern}`);
  }
}

function executableMode(mode: number): number {
  const permissions = mode % 0o1000;
  return [0o100, 0o010, 0o001]
    .map((bit) => Math.trunc(permissions / bit) % 2)
    .reduce((sum, value) => sum + value, 0);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

type JsonSchema = {
  $id: string;
  $schema: string;
  type: "object";
  additionalProperties: false;
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};
