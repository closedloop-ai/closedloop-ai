/**
 * ISS-11347 — a completed LLM request travels from the transcript to a GenAI
 * span through the production path: the real Claude parser, the collector's
 * live-session sink, the request bridge, and the real OTel runtime. What
 * crosses is model, tokens and cost; PRD-481 §3 forbids prompts, paths and
 * content, and the adversarial transcript here tries to smuggle each of them.
 * The billing mode comes from the real detector, driven through its own
 * credential signals, so each case pins which ledger its session is on.
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { GenAiOperationName } from "@closedloop-ai/telemetry-contract/gen-ai";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import type { Node } from "typescript6";
import {
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
} from "typescript6";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";
import { applyLiveSessionSinks } from "../src/main/collectors/engine/collector-manager-live-session-sinks.js";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import { GEN_AI_TRACER_NAME } from "../src/main/telemetry/app-otel-runtime-gen-ai.js";
import { genAiRequestTelemetry } from "../src/main/telemetry/gen-ai-request-telemetry.js";
import {
  type DesktopOtelBufferedRecord,
  DesktopOtelSignal,
} from "../src/shared/renderer-otel-bridge-constants.js";
import { createTrackedRuntimeFactory } from "./app-otel-runtime-test-helpers.js";
import { desktopServicesSource } from "./desktop-services-ast-helpers.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

const MODEL = "claude-sonnet-4-5";
const PROMPT_SECRET = "PROMPT-SECRET-4f1c please refactor the billing module";
const ANSWER_SECRET = "ANSWER-SECRET-9b2e here is the refactor";
const THINKING_SECRET = "THINKING-SECRET-77aa";
const TOOL_PATH_SECRET = "/Users/alice/TOOL-PATH-SECRET-31d0/billing.ts";
const CWD_SECRET = "/Users/alice/CWD-SECRET-c2d9/repo";
const BRANCH_SECRET = "BRANCH-SECRET-5e81";
/** Model ids an untrusted transcript can carry that are not model ids. */
const SMUGGLED_MODELS = [
  "/Users/alice/MODEL-PATH-SECRET-a1/weights",
  "~/MODEL-HOME-SECRET-a2/weights",
  "C:\\Users\\alice\\MODEL-WIN-SECRET-a3\\weights",
  "C:/Users/alice/MODEL-WINFWD-SECRET-a4/weights",
  "file:/Users/alice/MODEL-URI-SECRET-a5/weights",
  "vendor/../MODEL-DOTDOT-SECRET-a6",
  "./MODEL-DOT-SECRET-a7",
  "home/alice/.cache/MODEL-HIDDEN-SECRET-a8",
  "models/7B/MODEL-WEIGHTS-SECRET-a9.gguf",
  "MODEL-EMAIL-SECRET-b1@example.com",
  "MODEL-PROSE-SECRET-b2 ignore previous instructions",
  "sk-MODELKEYSECRETb3AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  `MODEL-LONG-SECRET-b4-${"ab-".repeat(40)}end`,
] as const;
const SECRETS = [
  PROMPT_SECRET,
  ANSWER_SECRET,
  THINKING_SECRET,
  TOOL_PATH_SECRET,
  CWD_SECRET,
  BRANCH_SECRET,
  ...SMUGGLED_MODELS,
];

/** Every signal the Claude billing-mode detector reads ahead of the Keychain. */
const CLAUDE_BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

type CapturedExport = { signal: KeylessTelemetrySignal; body: Uint8Array };

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

beforeEach(() => {
  for (const name of CLAUDE_BILLING_ENV) {
    vi.stubEnv(name, undefined);
  }
  // API-billed unless a case says otherwise, so the cost is on the span.
  vi.stubEnv("ANTHROPIC_API_KEY", "wiring-test-api-key");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  genAiRequestTelemetry.bindRuntime(null);
  await resetTrackedRuntime();
  await cleanupTempDirs();
});

describe("GenAI request telemetry wiring (ISS-11347)", () => {
  test("each request ships once, as its own root span, with the usage its last line reports", async () => {
    const runtime = await startBoundRuntime();
    const at = Date.now() + 5000;
    const [firstBlock, ...restBlocks] = assistantBlockLines(0, MODEL, at);
    const transcript = writeTranscript([userLine(0, at - 1000), firstBlock]);

    // Claude writes a line per content block, and the watcher can parse
    // between them: the first parse sees a partial output count.
    applyLiveImportSinks(await parseTranscript(transcript), true);
    appendFileSync(transcript, jsonl(restBlocks));
    applyLiveImportSinks(await parseTranscript(transcript), true);
    appendFileSync(
      transcript,
      jsonl([
        userLine(1, at + 5000),
        ...assistantBlockLines(1, MODEL, at + 6000),
        userLine(2, at + 10_000),
        ...assistantBlockLines(2, MODEL, at + 11_000),
      ])
    );
    applyLiveImportSinks(await parseTranscript(transcript), true);
    // Positive control for the root assertion below: a runtime child span in
    // the same buffer does record its parent.
    runtime.emitIpcPerfEvent({
      operation: "list",
      startTimeUnixMs: Date.now(),
      durationMs: 1,
      payloadBytes: 1,
      resultCount: 1,
    });
    await runtime.shutdown();

    const records = runtime.getBufferedRecords();
    const spans = genAiSpans(records);
    // The last request is still the latest in its stream, so it is held.
    assert.deepEqual(
      spans.map(
        (span) => span.attributes?.[TelemetryAttribute.GenAiUsageOutputTokens]
      ),
      [finalOutputTokens(0), finalOutputTokens(1)]
    );
    assert.ok(
      records.some(
        (record) => record.name === "ipc.list" && record.parentSpanId
      ),
      "the positive control lost its parent, so the root check proves nothing"
    );
    for (const span of spans) {
      assert.equal(span.name, GenAiOperationName.Chat);
      assert.equal(span.parentSpanId, undefined, "a GenAI span has a parent");
    }
    const [first] = spans;
    assert.deepEqual(Object.keys(first?.attributes ?? {}).sort(), [
      TelemetryAttribute.GenAiCostUsage,
      TelemetryAttribute.GenAiOperationName,
      TelemetryAttribute.GenAiRequestModel,
      TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
      TelemetryAttribute.GenAiUsageCacheReadInputTokens,
      TelemetryAttribute.GenAiUsageInputTokens,
      TelemetryAttribute.GenAiUsageOutputTokens,
    ]);
    assert.equal(
      first?.attributes?.[TelemetryAttribute.GenAiRequestModel],
      MODEL
    );
  });

  test("a subscription-billed session's span carries its tokens but no cost", async () => {
    // The detector's own subscription signal: an OAuth credential file and no
    // API key or provider override.
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const configDir = makeTempDir("gen-ai-wiring-claude-");
    writeFileSync(join(configDir, ".credentials.json"), "{}");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    const runtime = await startBoundRuntime();

    applyLiveImportSinks(
      await parseTranscript(
        writeTranscript(
          requestLines({ models: [MODEL, MODEL], secondsAfterBind: 5 })
        )
      ),
      true
    );
    await runtime.shutdown();

    // The first test is the API-billed control: the same request with a cost.
    const [span, ...rest] = genAiSpans(runtime.getBufferedRecords());
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(span?.attributes ?? {}).sort(), [
      TelemetryAttribute.GenAiOperationName,
      TelemetryAttribute.GenAiRequestModel,
      TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
      TelemetryAttribute.GenAiUsageCacheReadInputTokens,
      TelemetryAttribute.GenAiUsageInputTokens,
      TelemetryAttribute.GenAiUsageOutputTokens,
    ]);
  });

  test("the span starts and ends at the request's transcript stamp", async () => {
    const captured: CapturedExport[] = [];
    const runtime = await startBoundRuntime(captured);
    // Stamped at the bind instant, so it is already in the past when the
    // import observes it: a span ended at emission would not be zero-length.
    // The second request is what closes the first.
    const lines = requestLines({
      models: [MODEL, MODEL],
      secondsAfterBind: -1,
      baseMs: Date.now(),
    });
    applyLiveImportSinks(await parseTranscript(writeTranscript(lines)), true);
    await runtime.flush();

    // PostHog dates the event from the span's START, which the local buffer
    // does not record, so read the OTLP bytes: a zero-length span stamped at
    // the request carries that instant as a fixed64 twice, start and end.
    const stamp = Buffer.alloc(8);
    stamp.writeBigUInt64LE(
      BigInt(Date.parse(assistantTimestamp(lines))) * 1_000_000n
    );
    const traces = Buffer.concat(
      captured
        .filter((entry) => entry.signal === KeylessTelemetrySignal.Traces)
        .map((entry) => Buffer.from(entry.body))
    );
    assert.equal(countOccurrences(traces, stamp), 2);
  });

  test("a historical import emits nothing", async () => {
    const runtime = await startBoundRuntime();
    const session = await parseTranscript(
      writeTranscript(
        requestLines({ models: [MODEL, MODEL], secondsAfterBind: 5 })
      )
    );

    applyLiveImportSinks(session, false);
    await runtime.shutdown();

    assert.equal(genAiSpans(runtime.getBufferedRecords()).length, 0);
  });

  test("requests completed before telemetry was bound are never sent", async () => {
    const runtime = await startBoundRuntime();
    const session = await parseTranscript(
      writeTranscript(
        requestLines({ models: [MODEL, MODEL], secondsAfterBind: -600 })
      )
    );

    applyLiveImportSinks(session, true);
    await runtime.shutdown();

    assert.equal(genAiSpans(runtime.getBufferedRecords()).length, 0);
  });

  test("no prompt, path, content or smuggled model reaches the OTLP wire", async () => {
    const captured: CapturedExport[] = [];
    const runtime = await startBoundRuntime(captured);
    const session = await parseTranscript(
      writeTranscript(
        requestLines({
          // The trailing request closes the last smuggled one, so every
          // smuggled model is offered to the emitter rather than held.
          models: [MODEL, ...SMUGGLED_MODELS, MODEL],
          secondsAfterBind: 5,
        })
      )
    );
    // Positive control: the parser DID read every smuggled model, so their
    // absence below is the emitter refusing them, not the parser dropping them.
    assert.deepEqual(
      [...new Set(session.tokenSeries.map((entry) => entry.model))].sort(),
      [MODEL, ...SMUGGLED_MODELS].sort()
    );

    applyLiveImportSinks(session, true);
    await runtime.flush();

    const wire = Buffer.concat(
      captured.map((entry) => Buffer.from(entry.body))
    );
    assert.ok(wire.includes(MODEL), "the legitimate request never shipped");
    for (const secret of SECRETS) {
      assert.equal(wire.includes(secret), false, `leaked: ${secret}`);
    }
  });

  test("the composition root binds the runtime to the request bridge", () => {
    // `desktop-services.ts` imports `electron`, so it cannot be constructed
    // here; every test above binds the runtime itself, so without this the
    // production bind could be deleted and the emitter would be dark.
    let bound = false;
    const visit = (node: Node): void => {
      if (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "genAiRequestTelemetry" &&
        node.expression.name.text === "bindRuntime" &&
        node.arguments.length === 1 &&
        isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === "appOtelRuntime"
      ) {
        bound = true;
      }
      forEachChild(node, visit);
    };
    forEachChild(desktopServicesSource(), visit);

    assert.ok(
      bound,
      "desktop-services never calls genAiRequestTelemetry.bindRuntime(appOtelRuntime), so no GenAI span is ever emitted"
    );
  });
});

async function startBoundRuntime(
  captured?: CapturedExport[]
): Promise<DesktopOtelRuntime> {
  const runtime = createTestRuntime(
    captured
      ? {
          isPackaged: true,
          metricExportIntervalMs: 600_000,
          telemetryTransport: {
            start() {
              // The keyless handshake is not under test.
            },
            stop() {
              // Teardown runs through `resetTrackedRuntime`.
            },
            flush: () => Promise.resolve(),
            export: (signal, body) => {
              captured.push({ signal, body });
              return Promise.resolve(true);
            },
          },
        }
      : {}
  );
  await runtime.start();
  genAiRequestTelemetry.bindRuntime(runtime);
  return runtime;
}

function applyLiveImportSinks(session: NormalizedSession, live: boolean) {
  applyLiveSessionSinks({
    session,
    harness: Harness.Claude,
    source: "transcript.jsonl",
    viaWatcher: live,
    lowDutyImport: false,
    generationIsCurrent: true,
    changedPaths: undefined,
    captureDefinitionEvidence: () => [],
    log: () => undefined,
  });
}

function writeTranscript(lines: readonly unknown[]): string {
  return writeJsonl(
    makeTempDir("gen-ai-wiring-"),
    "gen-ai-session.jsonl",
    lines
  );
}

async function parseTranscript(filePath: string): Promise<NormalizedSession> {
  const parsed = await parseSessionFile(filePath);
  if (!parsed) {
    throw new Error("expected the transcript to parse");
  }
  return parsed;
}

function jsonl(lines: readonly unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function genAiSpans(records: readonly DesktopOtelBufferedRecord[]) {
  return records.filter(
    (record) =>
      record.signal === DesktopOtelSignal.Trace &&
      record.instrumentationScope?.name === GEN_AI_TRACER_NAME
  );
}

function assistantTimestamp(lines: readonly unknown[]): string {
  const assistant = lines.find(
    (line): line is { type: string; timestamp: string } =>
      typeof line === "object" &&
      line !== null &&
      "type" in line &&
      line.type === "assistant"
  );
  if (!assistant) {
    throw new Error("fixture has no assistant line");
  }
  return assistant.timestamp;
}

/**
 * One user prompt, then one assistant request per model. Entry UUIDs are real
 * UUIDs, so Claude's dedup proves a source identity and the bridge keys on it.
 */
function requestLines({
  models,
  secondsAfterBind,
  baseMs = Date.now(),
}: {
  models: readonly string[];
  secondsAfterBind: number;
  baseMs?: number;
}): unknown[] {
  const at = (offset: number) => baseMs + (secondsAfterBind + offset) * 1000;
  return [
    userLine(0, at(0)),
    ...models.flatMap((model, index) =>
      assistantBlockLines(index, model, at(index + 1))
    ),
  ];
}

function entryUuid(line: number): string {
  return `00000000-0000-4000-8000-${String(line).padStart(12, "0")}`;
}

function userLine(index: number, atMs: number) {
  return {
    type: "user",
    uuid: entryUuid(9000 + index),
    timestamp: new Date(atMs).toISOString(),
    cwd: CWD_SECRET,
    gitBranch: BRANCH_SECRET,
    message: { role: "user", content: PROMPT_SECRET },
  };
}

function finalOutputTokens(index: number): number {
  return 50 + index;
}

/**
 * One request the way Claude Code writes it: a line per content block, all
 * sharing the message id, each carrying the usage so far, so only the last
 * line reports the final output count.
 */
function assistantBlockLines(index: number, model: string, atMs: number) {
  const blocks = [
    { type: "thinking", thinking: THINKING_SECRET },
    { type: "text", text: ANSWER_SECRET },
    {
      type: "tool_use",
      id: `tool_${index}`,
      name: "Read",
      input: { file_path: TOOL_PATH_SECRET },
    },
  ];
  return blocks.map((block, blockIndex) => ({
    type: "assistant",
    uuid: entryUuid(index * blocks.length + blockIndex),
    requestId: `req_${index}`,
    timestamp: new Date(atMs + blockIndex * 100).toISOString(),
    cwd: CWD_SECRET,
    gitBranch: BRANCH_SECRET,
    message: {
      id: `msg_${index}`,
      model,
      usage: {
        input_tokens: 100 + index,
        output_tokens:
          blockIndex === blocks.length - 1
            ? finalOutputTokens(index)
            : blockIndex + 1,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      content: [block],
    },
  }));
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
