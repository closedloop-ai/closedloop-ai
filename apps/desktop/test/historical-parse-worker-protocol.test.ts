import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { z } from "zod";
import {
  clampSessionsForWorkerResponse,
  createHistoricalParseWorkerFailedResponse,
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerLimits,
  HistoricalParseWorkerRequestType,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerRequestSchema,
  historicalParseWorkerResponseSchema,
  summarizeHistoricalWorkerResponseIssues,
  summarizeHistoricalWorkerStderr,
} from "../src/main/collectors/historical-parse-worker-protocol.js";
import {
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/utility-process-historical-parse-runner.js";

const WORKER_STDERR_SUMMARY_PATTERN =
  /^historical parse worker stderr \(\d+ bytes\): .+$/;
const WORKER_STDERR_SUMMARY_PREFIX_PATTERN =
  /^historical parse worker stderr \(\d+ bytes\): /;
const WORKER_STDERR_TRUNCATION_PATTERN = /\.\.\.$/;
const WORKER_STDERR_WARNING_PATTERN = /Warning: parse failed/;
const WORKER_STDERR_REDACTED_PATH_PATTERN =
  /\[redacted-path\]\/transcript\.jsonl:42/;
const WORKER_STDERR_REDACTED_SECRET_PATTERN =
  /OPENAI_API_KEY=\[redacted-secret\]/;
const WORKER_STDERR_RELATIVE_CONTEXT_PATTERN = /relative-parser\.ts: retrying/;
const INVALID_WORKER_RESPONSE_PATTERN = /invalid response/;
const INVALID_WORKER_RESPONSE_REQUEST_PATTERN =
  /invalid response for historical-parse-1/;
const WORKER_ERROR_PATTERN = /historical parse worker error/;
const WORKER_TERMINAL_FAILURE_PATTERN = /terminal failure/;
const WORKER_STOPPED_PATTERN = /stopped/;
const WORKER_TIMEOUT_PATTERN = /timed out/;
const OFFENDING_FIELD_DIAGNOSTIC_PATTERN = /sessions\.0\.name/;
const ROOT_INVALID_UNION_PATTERN = /<root>:invalid_union/;
const CAPPED_UNION_DIAGNOSTIC_PATTERN = /union-8:invalid_union/;
const UNCAPPED_UNION_LEAF_PATTERN = /leaf:invalid_type/;
const REVIEWED_NORMALIZED_TOOL_USE_FIELDS = {
  name: "Bash",
  timestamp: "2026-06-07T12:00:00.000Z",
  input: { command: "gh pr create" },
  output: "created pull request",
  isError: false,
  mcpServer: "github",
  mcpMethod: "pull_request.create",
  skillName: "github:yeet",
  diffDelta: { add: 3, del: 1 },
  id: "toolu_123",
  resultTimestamp: "2026-06-07T12:00:01.000Z",
  gitBranch: "feat/parser-fix",
} satisfies Record<keyof NormalizedToolUse, unknown>;

test("historical parse worker response rejects malformed sessions", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [{ sessionId: "missing-required-fields" }],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response accepts normalized sessions", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeSession("worker-session")],
  });

  assert.equal(result.success, true);
});

test("historical parse worker schema stays in parity with NormalizedToolUse fields", () => {
  for (const [field, value] of Object.entries(
    REVIEWED_NORMALIZED_TOOL_USE_FIELDS
  )) {
    const acceptedResult = parseWorkerToolUse({
      name: "Bash",
      timestamp: "2026-06-07T12:00:00.000Z",
      [field]: value,
    });
    assert.equal(
      acceptedResult.success,
      true,
      `expected worker schema to accept reviewed NormalizedToolUse.${field}`
    );

    const renamedToolUse = {
      name: "Bash",
      timestamp: "2026-06-07T12:00:00.000Z",
      [`${field}Renamed`]: value,
    };
    Reflect.deleteProperty(renamedToolUse, field);
    const renamedResult = parseWorkerToolUse(renamedToolUse);
    assert.equal(
      renamedResult.success,
      false,
      `expected worker schema to reject renamed NormalizedToolUse.${field}`
    );
  }
});

test("historical parse worker response accepts fully populated tool uses with gitBranch", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-session"),
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:00:00.000Z",
            input: { command: "gh pr create" },
            output: "created pull request",
            isError: false,
            mcpServer: "github",
            mcpMethod: "pull_request.create",
            skillName: "github:yeet",
            diffDelta: { add: 3, del: 1 },
            id: "toolu_123",
            resultTimestamp: "2026-06-07T12:00:01.000Z",
            gitBranch: "feat/parser-fix",
          },
          {
            name: "Read",
            timestamp: null,
            gitBranch: null,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
});

test("historical parse worker response rejects unrelated unknown tool use keys", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("unknown-tool-use-key"),
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:00:00.000Z",
            unexpectedField: "not allowed",
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response rejects unsafe token counters", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("unsafe-token-session"),
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 1,
            output: 1,
            cacheRead: Number.MAX_SAFE_INTEGER + 1,
            cacheWrite: 0,
          },
        },
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker request validates canonical harness values", () => {
  assert.equal(
    historicalParseWorkerRequestSchema.safeParse({
      type: HistoricalParseWorkerRequestType.ParseSource,
      requestId: "historical-parse-1",
      collectorKey: Harness.Claude,
      source: "/tmp/session.jsonl",
    }).success,
    true
  );
  assert.equal(
    historicalParseWorkerRequestSchema.safeParse({
      type: HistoricalParseWorkerRequestType.ParseSource,
      requestId: "historical-parse-1",
      collectorKey: "unknown",
      source: "/tmp/session.jsonl",
    }).success,
    false
  );
});

test("historical parse worker response rejects oversized unknown payloads", () => {
  const oversizedToolInput = Array.from({ length: 1001 }, (_, index) => index);
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("oversized-tool-input"),
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:00:00.000Z",
            input: oversizedToolInput,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response accepts large valid tool inputs within aggregate budget", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("large-tool-input"),
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:00:00.000Z",
            input: { command: "x".repeat(300_000) },
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
});

test("historical parse worker response rejects oversized failure messages", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: "historical-parse-1",
    message: "x".repeat(HistoricalParseWorkerLimits.maxLongTextLength + 1),
  });

  assert.equal(result.success, false);
});

test("historical parse worker response rejects oversized aggregate arrays", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeAggregateHeavySession("aggregate-heavy")],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response rejects oversized aggregate text", () => {
  const text = "x".repeat(HistoricalParseWorkerLimits.maxLongTextLength);
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("aggregate-text"),
        messages: Array.from({ length: 33 }, () => ({
          role: "assistant",
          timestamp: "2026-06-07T12:00:00.000Z",
          text,
        })),
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker converts malformed parsed output into a small nonfatal failure", () => {
  const response = createHistoricalParseWorkerParsedResponse(
    "historical-parse-1",
    [{ sessionId: "missing-required-fields" } as NormalizedSession]
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Failed);
  if (response.type !== HistoricalParseWorkerResponseType.Failed) {
    assert.fail("expected malformed parsed output to become a failed response");
  }
  assert.equal(response.fatal, undefined);
  assert.match(response.message, INVALID_WORKER_RESPONSE_REQUEST_PATTERN);
  assert.ok(response.diagnostic);
  assert.equal(response.diagnostic.includes("sessions.0.sessionId"), false);
});

test("historical parse worker names the offending field in the nonfatal diagnostic", () => {
  // A well-formed session that clamps cleanly but violates a per-field bound
  // (name over maxLongTextLength) — the case that produced a bare
  // `<root>:invalid_union` before the diagnostic was sharpened.
  const response = createHistoricalParseWorkerParsedResponse(
    "historical-parse-1",
    [
      {
        ...makeSession("oversized-name"),
        name: "x".repeat(HistoricalParseWorkerLimits.maxLongTextLength + 1),
      },
    ]
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Failed);
  if (response.type !== HistoricalParseWorkerResponseType.Failed) {
    assert.fail(
      "expected an out-of-bounds session to become a failed response"
    );
  }
  assert.ok(response.diagnostic);
  assert.match(response.diagnostic, OFFENDING_FIELD_DIAGNOSTIC_PATTERN);
  assert.doesNotMatch(response.diagnostic, ROOT_INVALID_UNION_PATTERN);
});

test("historical parse worker caps nested invalid union diagnostic flattening", () => {
  const error = new z.ZodError([makeNestedInvalidUnionIssue(12)]);
  const diagnostic = summarizeHistoricalWorkerResponseIssues(error);

  assert.match(diagnostic, CAPPED_UNION_DIAGNOSTIC_PATTERN);
  assert.doesNotMatch(diagnostic, UNCAPPED_UNION_LEAF_PATTERN);
  assert.equal(diagnostic.split("; ").length, 6);
});

test("historical parse worker failed response factory bounds and sanitizes diagnostics", () => {
  const response = createHistoricalParseWorkerFailedResponse(
    "historical-parse-1",
    `failed at /Users/alice/private/transcript.jsonl OPENAI_API_KEY=secret-value ${"x".repeat(HistoricalParseWorkerLimits.maxLongTextLength)}`,
    {
      diagnostic:
        "Bearer ghp_123456789012345678901234567890 at file:///Users/alice/transcript.jsonl",
    }
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Failed);
  assert.equal(response.fatal, undefined);
  assert.equal(
    response.message.length <= HistoricalParseWorkerLimits.maxLongTextLength,
    true
  );
  assert.equal(response.message.includes("/Users/alice"), false);
  assert.equal(response.message.includes("secret-value"), false);
  assert.ok(response.diagnostic);
  assert.equal(response.diagnostic.includes("ghp_"), false);
  assert.equal(response.diagnostic.includes("file:///Users/alice"), false);
});

test("utility parse runner rejects all pending parses after malformed response", async () => {
  const children: FakeUtilityProcess[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  const child = children[0];

  assert.ok(child);
  assert.equal(child.messages.length, 2);
  const firstMessage = child.messages[0];
  assert.ok(firstMessage);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: firstMessage.requestId,
    sessions: [{ sessionId: "missing-required-fields" }],
  });

  await assert.rejects(first, INVALID_WORKER_RESPONSE_PATTERN);
  await assert.rejects(second, INVALID_WORKER_RESPONSE_PATTERN);
  assert.equal(child.killed, true);
  assert.equal(
    logs.some((message) =>
      INVALID_WORKER_RESPONSE_REQUEST_PATTERN.test(message)
    ),
    true
  );
  assert.equal(
    logs.some((message) => message.includes(":")),
    true
  );
  assert.equal(
    logs.some((message) => message.includes("missing-required-fields")),
    false
  );
  runner.stop();
});

test("utility parse runner treats worker-side schema failures as nonfatal per-request failures", async () => {
  const children: FakeUtilityProcess[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  const child = children[0];

  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: child.messages[0]?.requestId,
    message:
      "historical parse worker sent an invalid response for historical-parse-1",
    diagnostic: "sessions.0.messages:too_big:too many rows",
  });

  await assert.rejects(first, INVALID_WORKER_RESPONSE_REQUEST_PATTERN);
  assert.equal(child.killed, false);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[1]?.requestId,
    sessions: [makeSession("second-session")],
  });
  assert.deepEqual(await second, [makeSession("second-session")]);
  assert.equal(
    logs.some((message) => message.includes("sessions.0.messages:too_big")),
    true
  );
  runner.stop();
});

test("utility parse runner treats explicit fatal failures as worker-terminal", async () => {
  const children: FakeUtilityProcess[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  const child = children[0];

  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: child.messages[0]?.requestId,
    message: "historical parse worker terminal failure",
    fatal: true,
    diagnostic: "utility process corrupted",
  });

  await assert.rejects(first, WORKER_TERMINAL_FAILURE_PATTERN);
  await assert.rejects(second, WORKER_TERMINAL_FAILURE_PATTERN);
  assert.equal(child.killed, true);
  assert.equal(
    logs.some((message) => message.includes("utility process corrupted")),
    true
  );
  runner.stop();
});

test("utility parse runner drains posted responses before rejecting clean worker exit", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  const child = children[0];

  assert.ok(child);
  child.emit("exit", 0);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[0]?.requestId,
    sessions: [makeSession("exit-race-session")],
  });
  await nextImmediate();

  assert.deepEqual(await pending, [makeSession("exit-race-session")]);
  runner.stop();
});

test("utility parse runner forks worker with stderr piped", async () => {
  let forkOptions: { stdio: string[] } | null = null;
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: (_modulePath, _args, options) => {
      forkOptions = options;
      return new FakeUtilityProcess();
    },
  });

  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  runner.stop();
  await assert.rejects(pending, WORKER_STOPPED_PATTERN);

  assert.deepEqual(forkOptions?.stdio, ["ignore", "ignore", "pipe"]);
});

test("utility parse runner rejects pending parses on worker error", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  const child = children[0];

  assert.ok(child);
  child.emit("error", "FatalError", "utility-worker");

  await assert.rejects(pending, WORKER_ERROR_PATTERN);
  assert.equal(child.killed, true);
  runner.stop();
});

test("utility parse runner rejects silent workers after the parse timeout", async () => {
  const keepAlive = setInterval(() => {}, 10);
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    parseTimeoutMs: 1,
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");

  try {
    await assert.rejects(pending, WORKER_TIMEOUT_PATTERN);
    assert.equal(children[0]?.killed, true);
  } finally {
    clearInterval(keepAlive);
    runner.stop();
  }
});

test("utility parse runner ignores stale child messages after restart", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  const firstChild = children[0];
  assert.ok(firstChild);
  firstChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: firstChild.messages[0]?.requestId,
    sessions: [{ sessionId: "missing-required-fields" }],
  });
  await assert.rejects(first, INVALID_WORKER_RESPONSE_PATTERN);

  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  const secondChild = children[1];
  assert.ok(secondChild);
  firstChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "stale-message",
    sessions: [{ sessionId: "missing-required-fields" }],
  });
  assert.equal(secondChild.killed, false);
  secondChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: secondChild.messages[0]?.requestId,
    sessions: [makeSession("second-session")],
  });

  assert.deepEqual(await second, [makeSession("second-session")]);
  runner.stop();
});

test("historical parse worker stderr summary includes a sanitized preview", () => {
  const summary = summarizeHistoricalWorkerStderr(
    Buffer.from(
      [
        "Warning: parse failed at /Users/alice/private/transcript.jsonl:42",
        "OPENAI_API_KEY=secret-value",
        "relative-parser.ts: retrying",
      ].join("\n")
    )
  );

  assert.ok(summary);
  assert.match(summary, WORKER_STDERR_SUMMARY_PATTERN);
  assert.match(summary, WORKER_STDERR_WARNING_PATTERN);
  assert.match(summary, WORKER_STDERR_REDACTED_PATH_PATTERN);
  assert.match(summary, WORKER_STDERR_REDACTED_SECRET_PATTERN);
  assert.match(summary, WORKER_STDERR_RELATIVE_CONTEXT_PATTERN);
  assert.equal(summary.includes("secret-value"), false);
  assert.equal(summary.includes("/Users/alice"), false);
  assert.equal(summary.includes("private/transcript"), false);
});

test("historical parse worker stderr preview is byte bounded", () => {
  const summary = summarizeHistoricalWorkerStderr(
    Buffer.from(`Warning: ${"x".repeat(2000)}`)
  );
  assert.ok(summary);
  const preview = summary.replace(WORKER_STDERR_SUMMARY_PREFIX_PATTERN, "");

  assert.match(summary, WORKER_STDERR_SUMMARY_PATTERN);
  assert.match(preview, WORKER_STDERR_TRUNCATION_PATTERN);
  assert.equal(
    Buffer.byteLength(preview, "utf8") <=
      HistoricalParseWorkerLimits.maxWorkerStderrPreviewBytes,
    true
  );
});

test("historical parse worker stderr summary suppresses standalone SQLite experimental warning", () => {
  const summary = summarizeHistoricalWorkerStderr(
    Buffer.from(
      [
        "(node:41402) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
        "(Use `Electron Helper --trace-warnings ...` to show where the warning was created)",
      ].join("\n")
    )
  );

  assert.equal(summary, null);
});

test("historical parse worker stderr summary keeps mixed warning output", () => {
  const summary = summarizeHistoricalWorkerStderr(
    Buffer.from(
      [
        "(node:41402) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
        "Warning: parse failed at /Users/alice/private/transcript.jsonl:42",
      ].join("\n")
    )
  );

  assert.ok(summary);
  assert.match(summary, WORKER_STDERR_SUMMARY_PATTERN);
  assert.match(summary, WORKER_STDERR_WARNING_PATTERN);
  assert.equal(summary.includes("/Users/alice"), false);
});

function makeSession(sessionId: string): NormalizedSession {
  return {
    sessionId,
    name: sessionId,
    cwd: "/workspace/project",
    model: "gpt-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: Harness.Claude,
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    artifacts: {
      prs: [],
      issues: [],
      repo: null,
    },
  };
}

function parseWorkerToolUse(toolUse: Record<string, unknown>) {
  return historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-tool-use-parity"),
        toolUses: [toolUse],
      },
    ],
  });
}

function makeNestedInvalidUnionIssue(depth: number): z.ZodIssue {
  if (depth === 0) {
    return {
      code: "invalid_type",
      expected: "string",
      path: ["leaf"],
      message: "Invalid input: expected string, received number",
    } as z.ZodIssue;
  }

  return {
    code: "invalid_union",
    path: [`union-${depth}`],
    message: "Invalid input",
    errors: [
      [makeNestedInvalidUnionIssue(depth - 1)],
      [makeNestedInvalidUnionIssue(depth - 1)],
    ],
  } as z.ZodIssue;
}

test("clampSessionsForWorkerResponse leaves a normal session untouched", () => {
  const session = makeSession("normal");
  const [clamped] = clampSessionsForWorkerResponse([session]);

  assert.deepEqual(clamped, session);
});

test("clampSessionsForWorkerResponse trims an oversized session to a valid response", () => {
  // Raw, the over-budget session is rejected by the response schema.
  assert.equal(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "historical-parse-1",
      sessions: [makeAggregateHeavySession("aggregate-heavy")],
    }).success,
    false
  );

  // Clamped, the same session yields a response that validates.
  const clamped = clampSessionsForWorkerResponse([
    makeAggregateHeavySession("aggregate-heavy"),
  ]);
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: clamped,
  });

  assert.equal(result.success, true);
  // The session is preserved (only its detail arrays are truncated).
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0]?.sessionId, "aggregate-heavy");
  assert.ok(clamped[0] !== undefined && clamped[0].messages.length < 5000);
});

function makeAggregateHeavySession(sessionId: string): NormalizedSession {
  const session = makeSession(sessionId);
  session.messages = Array.from({ length: 5000 }, () => ({
    role: "assistant",
    timestamp: "2026-06-07T12:00:00.000Z",
    text: "ok",
  }));
  session.tokenSeries = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
    model: "gpt-5",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  }));
  session.toolUses = Array.from({ length: 5000 }, () => ({
    name: "Read",
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.messageTimestamps = Array.from(
    { length: 5000 },
    () => "2026-06-07T12:00:00.000Z"
  );
  session.turnDurations = Array.from({ length: 5000 }, () => ({
    durationMs: 1,
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.slashCommands = Array.from({ length: 5000 }, () => ({
    name: "test",
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.teams = Array.from({ length: 5000 }, () => "team");
  session.compactions = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.apiErrors = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.toolResultErrors = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.usageExtras = {
    service_tiers: Array.from({ length: 5000 }, () => "default"),
    speeds: Array.from({ length: 5000 }, () => "normal"),
    inference_geos: Array.from({ length: 5000 }, () => "us"),
  };
  return session;
}

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly messages: Array<{ requestId: string }> = [];
  killed = false;

  postMessage(message: { requestId: string }): void {
    this.messages.push(message);
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
