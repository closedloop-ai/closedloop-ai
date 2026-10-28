import assert from "node:assert/strict";
import { test } from "vitest";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  NormalizedDefinitionKind,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import {
  makeSession,
  parsedSessions,
  REVIEWED_NORMALIZED_TOOL_USE_FIELDS,
} from "./historical-parse-worker-response-support.js";

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

/**
 * ISS-7696 (whitlockk review): `resumeAfter` documents itself as present EXACTLY
 * when the response left sessions behind, and the schema used to accept it
 * alone. That shape reaches `applyParseSideReport` with `truncatedByBudget`
 * false, parks a cursor, and seals in the same pass — a sealed source holding a
 * live continuation into a window it never admitted dropping.
 *
 * All three payloads are WIRE LITERALS rather than a builder, so the expected
 * shape cannot be derived from the schema it is asserting about.
 */
test("historical parse worker response rejects a continuation with no dropped sessions", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeSession("worker-session")],
    resumeAfter: { sessionIndex: 2, sessionId: "worker-session" },
  });

  assert.equal(result.success, false);
});

test("historical parse worker response accepts a continuation beside dropped sessions", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeSession("worker-session")],
    droppedSessions: 3,
    resumeAfter: { sessionIndex: 2, sessionId: "worker-session" },
  });

  assert.equal(result.success, true);
});

// The guard is ONE-DIRECTIONAL on purpose: a worker too old to continue reports
// the loss without a resume point, and the runner reads that as the permanent
// under-import ISS-5854 surfaces. Rejecting it here would drop the whole
// response and lose the report as well.
test("historical parse worker response accepts dropped sessions with no continuation", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeSession("worker-session")],
    droppedSessions: 3,
  });

  assert.equal(result.success, true);
});

test("historical parse worker response preserves the FEA-4376 modelIsFallback flag", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-model-fallback-session"),
        modelIsFallback: true,
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    // The flag must survive the .strict() boundary so the importer can keep the
    // model column upgradeable (a fresh real id overwrites a stored label).
    assert.equal(parsedSessions(result)[0]?.modelIsFallback, true);
  }
});

test("historical parse worker response round-trips a pre-FEA-4376 payload that omits modelIsFallback", () => {
  // A pre-FEA-4376 cached worker payload never carries `modelIsFallback`; it must
  // round-trip through the .strict() boundary unchanged (the importer treats an
  // absent flag as false — a non-fallback model that stays sticky).
  const { modelIsFallback: _omitted, ...withoutFlag } = makeSession(
    "worker-legacy-model-session"
  );
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [withoutFlag],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(parsedSessions(result)[0]?.modelIsFallback, undefined);
  }
});

test("historical parse worker response rejects a session whose model exceeds the short-text cap", () => {
  // PR #3903 review (whitlockk): a /model echo is unbounded transcript text, but the
  // .strict() boundary caps `model` at 8,192 chars — an over-cap value rejects the
  // WHOLE source payload (silent whole-source drop, FEA-3701 class). This pins the
  // cap, which is why the parser must pre-reject an over-length label
  // (`MAX_MODEL_LABEL_LENGTH`) before assigning `modelSwitchLabel`.
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      { ...makeSession("worker-over-cap-model"), model: "x".repeat(8193) },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response preserves the FEA-3419 cacheWriteTtl fields", () => {
  const base = makeSession("worker-cache-ttl-session");
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        tokensByModel: {
          "claude-opus-4-5": {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 46,
            cacheWriteTtl: { fiveM: 12, oneH: 34 },
          },
        },
        tokenSeries: [
          {
            timestamp: "2026-06-07T10:00:05.000Z",
            model: "claude-opus-4-5",
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 46,
            cacheWriteTtl: { fiveM: 12, oneH: 34 },
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(
      parsedSessions(result)[0]?.tokensByModel["claude-opus-4-5"]
        ?.cacheWriteTtl,
      { fiveM: 12, oneH: 34 }
    );
    assert.deepEqual(parsedSessions(result)[0]?.tokenSeries[0]?.cacheWriteTtl, {
      fiveM: 12,
      oneH: 34,
    });
  }
});

test("historical parse worker response strips the retired FEA-3496 cache_creation blob from stale payloads", () => {
  // FEA-3419: an old-shape payload (pre-blob-removal) still carrying the
  // session-level `cache_creation` blob must validate cleanly — the unknown key
  // is stripped, never an error, and never resurfaces downstream.
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-stale-blob-session"),
        usageExtras: {
          service_tiers: ["standard"],
          speeds: [],
          inference_geos: [],
          cache_creation: {
            ephemeral_5m_input_tokens: 12,
            ephemeral_1h_input_tokens: 34,
          },
        },
      },
    ],
  });

  assert.equal(result.success, true);
  assert.ok(result.success);
  const [parsed] = parsedSessions(result);
  assert.ok(parsed);
  assert.equal(
    (parsed.usageExtras as Record<string, unknown>).cache_creation,
    undefined
  );
});

test("historical parse worker response accepts absent cacheWriteTtl (legacy/non-Claude)", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-legacy-usage-extras-session"),
        usageExtras: {
          service_tiers: [],
          speeds: [],
          inference_geos: [],
        },
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(
    result.success
      ? parsedSessions(result)[0]?.tokensByModel["claude-opus-4"]?.cacheWriteTtl
      : "unreachable",
    undefined
  );
});

test("historical parse worker response accepts normalized subagents", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-subagent-session"),
        subagents: [
          {
            id: "agent-1",
            parentId: null,
            name: "Researcher",
            type: "research",
            task: "collect context",
            startedAt: "2026-06-07T12:00:00.000Z",
            endedAt: "2026-06-07T12:01:00.000Z",
            status: "completed",
            nativeSubagentId: "agent-native",
            toolUses: [
              {
                name: "Read",
                timestamp: "2026-06-07T12:00:30.000Z",
                input: { file_path: "src/index.ts" },
              },
            ],
            tokensByModel: {
              "claude-sonnet-4-5": {
                input: 10,
                output: 5,
                cacheRead: 1,
                cacheWrite: 0,
              },
            },
            metadata: { parentUuid: "parent-uuid" },
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
});

test("historical parse worker response accepts and preserves FEA-4093 hook firings", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-hooks-session"),
        hooks: [
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: 'node "hook-handler.js"',
            succeeded: true,
            timestamp: "2026-06-07T12:00:30.000Z",
          },
          {
            name: "Stop:cleanup",
            event: "Stop",
            command: null,
            succeeded: false,
            timestamp: null,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    result.success
      ? parsedSessions(result)[0]?.hooks.map((hook) => hook.name)
      : "unexpected",
    ["PreToolUse:Bash", "Stop:cleanup"]
  );
});

test("historical parse worker response round-trips a pre-FEA-4093 payload that omits hooks", () => {
  // `hooks` defaults to [] so a payload from a build predating FEA-4093 (or a
  // non-Claude parser) that omits it still validates under the .strict()
  // boundary and fills an empty list rather than dropping the whole session.
  const { hooks: _omitted, ...withoutHooks } = makeSession(
    "worker-legacy-no-hooks"
  );
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [withoutHooks],
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    result.success ? parsedSessions(result)[0]?.hooks : "unexpected",
    []
  );
});

test("historical parse worker response rejects a malformed hook firing", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-bad-hook"),
        hooks: [
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: null,
            // Missing `succeeded`; extra unexpected key.
            unexpected: true,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response preserves the FEA-3526 codexLastTokenUsage snapshots", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-codex-last-token-usage-session"),
        codexLastTokenUsage: [
          {
            timestamp: "2026-06-07T12:00:03.000Z",
            model: "gpt-5-codex",
            lastTokenUsage: {
              input: 80,
              output: 30,
              cacheRead: 20,
              cacheWrite: 0,
            },
            derivedDelta: {
              input: 80,
              output: 30,
              cacheRead: 20,
              cacheWrite: 0,
            },
            drifted: false,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    result.success ? parsedSessions(result)[0]?.codexLastTokenUsage : undefined,
    [
      {
        timestamp: "2026-06-07T12:00:03.000Z",
        model: "gpt-5-codex",
        lastTokenUsage: { input: 80, output: 30, cacheRead: 20, cacheWrite: 0 },
        derivedDelta: { input: 80, output: 30, cacheRead: 20, cacheWrite: 0 },
        drifted: false,
      },
    ]
  );
});

test("historical parse worker response round-trips a pre-FEA-3526 payload that omits codexLastTokenUsage", () => {
  // The field is optional; a payload from a build predating FEA-3526 (or any
  // non-Codex parser) simply omits it and must still validate unchanged.
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeSession("worker-legacy-no-codex-last-token-usage")],
  });

  assert.equal(result.success, true);
  assert.equal(
    result.success
      ? parsedSessions(result)[0]?.codexLastTokenUsage
      : "unexpected",
    undefined
  );
});

test("historical parse worker response rejects a malformed codexLastTokenUsage snapshot", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-bad-codex-last-token-usage"),
        codexLastTokenUsage: [
          {
            timestamp: "2026-06-07T12:00:03.000Z",
            model: "gpt-5-codex",
            // Missing derivedDelta + drifted; extra unexpected key.
            lastTokenUsage: {
              input: 80,
              output: 30,
              cacheRead: 20,
              cacheWrite: 0,
            },
            unexpected: true,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response rejects malformed subagents", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-bad-subagent-session"),
        subagents: [
          {
            id: "agent-1",
            parentId: null,
            name: "Researcher",
            unexpected: true,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response accepts a parse-quality signal (FEA-2771)", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-parse-quality-session"),
        parseQuality: {
          totalLines: 12,
          malformedLines: 1,
          truncatedFinalLine: true,
        },
      },
    ],
  });

  assert.equal(result.success, true);
});

test("historical parse worker response accepts every optional parse-quality counter (FEA-3702/FEA-3713/FEA-3701)", () => {
  // Regression: FEA-3701's orphaned/ambiguous tool-output counters were added
  // to NormalizedParseQuality but not to the worker boundary's .strict()
  // schema, so any source whose session carried a non-zero counter had its
  // whole worker response rejected and the source silently dropped.
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-parse-quality-counters-session"),
        parseQuality: {
          totalLines: 12,
          malformedLines: 1,
          truncatedFinalLine: true,
          malformedRateLimits: 2,
          unknownRecords: 3,
          orphanedToolOutputs: 1,
          ambiguousToolOutputs: 2,
        },
      },
    ],
  });

  assert.equal(result.success, true);
});

test("historical parse worker response rejects a malformed parse-quality signal (FEA-2771)", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-bad-parse-quality-session"),
        parseQuality: {
          totalLines: 12,
          malformedLines: 1,
          truncatedFinalLine: true,
          unexpected: true,
        },
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response accepts a model_context_window (FEA-3525)", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-context-window-session"),
        modelContextWindow: 258_400,
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(parsedSessions(result)[0].modelContextWindow, 258_400);
  }
});

test("historical parse worker response round-trips a payload that omits model_context_window (FEA-3525)", () => {
  // A pre-FEA-3525 worker payload never carries the field; the optional schema
  // must validate it (the base makeSession omits it) so older captures parse.
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeSession("worker-no-context-window-session")],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(parsedSessions(result)[0].modelContextWindow, undefined);
  }
});

test("historical parse worker response rejects a negative model_context_window (FEA-3525)", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-bad-context-window-session"),
        modelContextWindow: -1,
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response round-trips a codexProtocolSupport pin (FEA-3715)", () => {
  const codexProtocolSupport = {
    referenceRepo: "steipete/CodexBar",
    pinnedCommit: "963cda85aa2a4cfb85e52d771d22d9f3069951fa",
    reviewedOn: "2026-07-22",
    supportedRange: "codex rollout schema at pinnedCommit forward (open-ended)",
  };
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-codex-protocol-support-session"),
        codexProtocolSupport,
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(
      parsedSessions(result)[0].codexProtocolSupport,
      codexProtocolSupport
    );
  }
});

test("historical parse worker response rejects a codexProtocolSupport pin with an extra field (FEA-3715)", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("worker-bad-codex-protocol-support-session"),
        codexProtocolSupport: {
          referenceRepo: "steipete/CodexBar",
          pinnedCommit: "963cda85aa2a4cfb85e52d771d22d9f3069951fa",
          reviewedOn: "2026-07-22",
          supportedRange: "open-ended",
          // Un-modeled extra — the .strict() inner object must reject it.
          unexpected: "nope",
        },
      },
    ],
  });

  assert.equal(result.success, false);
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

test("historical parse worker preserves FEA-3294 invocation identity and definition evidence", () => {
  const definitionSnapshot = {
    kind: NormalizedDefinitionKind.Skill,
    rawName: "review",
    normalizedName: "review",
    content: "# Review\n",
    capturedAt: "2026-06-07T12:00:00.000Z",
  };
  const session = {
    ...makeSession("worker-invocation-evidence"),
    toolUses: [
      {
        name: "Skill",
        rawName: "Skill",
        normalizedName: "Skill",
        kind: "harness" as const,
        timestamp: "2026-06-07T12:00:00.000Z",
        id: "normalized-tool-id",
        providerToolUseId: "toolu_provider_id",
        skillName: "review",
        definitionSnapshot,
      },
    ],
    slashCommands: [
      {
        name: "/review",
        timestamp: "2026-06-07T12:00:00.000Z",
        userTurnId: "prompt-review",
        rawName: "/review",
        normalizedName: "review",
        definitionSnapshot: {
          ...definitionSnapshot,
          kind: NormalizedDefinitionKind.Command,
        },
      },
    ],
    skills: [
      {
        name: "review",
        rawName: "review",
        normalizedName: "review",
        timestamp: "2026-06-07T12:00:00.000Z",
        subagentId: "reviewer",
        providerToolUseId: "toolu_provider_id",
        definitionSnapshot,
      },
    ],
    subagents: [
      {
        id: "reviewer",
        parentId: "root",
        childSessionId: "child-session",
        name: "Reviewer",
        rawName: "general-purpose",
        normalizedName: "reviewer",
        definitionSnapshot: {
          ...definitionSnapshot,
          kind: NormalizedDefinitionKind.Subagent,
        },
      },
    ],
  } satisfies NormalizedSession;
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [session],
  });

  assert.equal(result.success, true);
  const parsed = parsedSessions(result)[0];
  assert.deepEqual(parsed?.toolUses, session.toolUses);
  assert.deepEqual(parsed?.slashCommands, session.slashCommands);
  assert.deepEqual(parsed?.skills, session.skills);
  assert.deepEqual(parsed?.subagents, session.subagents);
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
