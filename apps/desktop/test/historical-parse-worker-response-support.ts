/**
 * @file historical-parse-worker-response-support.ts
 * @description Shared support for the historical-parse worker suites — the
 * response-envelope narrowing below, plus the session fixture and diagnostic
 * pattern that both `historical-parse-worker-protocol.test.ts` (schema) and
 * `utility-process-historical-parse-runner.test.ts` (runner lifecycle) assert
 * against, so the split suites cannot drift apart.
 *
 * Two narrowings are folded into one call. The parse result is a
 * `success | failure` union, and the response it carries is itself a
 * `parsed | failed` union whose `sessions` exist on ONE arm — so reaching
 * through either union (or asserting a discriminant with `assert.equal`, which
 * does not narrow) hides the wrong arm behind a downstream `undefined`. Going
 * through this guard makes the suite fail on the response it actually got.
 */

import {
  type HistoricalParseWorkerResponse,
  HistoricalParseWorkerResponseType,
  type historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  Harness,
  NormalizedDefinitionKind,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

/** Nonfatal per-request diagnostic, asserted by both worker suites. */
export const INVALID_WORKER_RESPONSE_REQUEST_PATTERN =
  /invalid response for historical-parse-1/;

/** The exact result shape `historicalParseWorkerResponseSchema.safeParse` returns. */
type WorkerResponseParseResult = ReturnType<
  typeof historicalParseWorkerResponseSchema.safeParse
>;

/** Sessions of a validated `parsed` worker response; throws on any other outcome. */
export function parsedSessions(
  result: WorkerResponseParseResult
): NormalizedSession[] {
  if (!result.success) {
    throw new Error(
      `expected a valid worker response: ${result.error.message}`
    );
  }
  const response: HistoricalParseWorkerResponse = result.data;
  if (response.type !== HistoricalParseWorkerResponseType.Parsed) {
    throw new Error(
      `expected a parsed worker response, got "${response.type}": ${response.message}`
    );
  }
  return response.sessions;
}

/** The canonical worker-suite session fixture, keyed only by session id. */
export function makeSession(sessionId: string): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/workspace/project",
    model: "gpt-5",
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    entrypoint: Harness.Claude,
  });
}

export const WORKER_STDERR_SUMMARY_PATTERN =
  /^historical parse worker stderr \(\d+ bytes\): .+$/;
export const WORKER_STDERR_SUMMARY_PREFIX_PATTERN =
  /^historical parse worker stderr \(\d+ bytes\): /;
export const WORKER_STDERR_TRUNCATION_PATTERN = /\.\.\.$/;
export const WORKER_STDERR_WARNING_PATTERN = /Warning: parse failed/;
export const WORKER_STDERR_REDACTED_PATH_PATTERN =
  /\[redacted-path\]\/transcript\.jsonl:42/;
export const WORKER_STDERR_REDACTED_SECRET_PATTERN =
  /OPENAI_API_KEY=\[redacted-secret\]/;
export const WORKER_STDERR_RELATIVE_CONTEXT_PATTERN =
  /relative-parser\.ts: retrying/;
export const OFFENDING_FIELD_DIAGNOSTIC_PATTERN = /sessions\.0\.cwd/;
export const ROOT_INVALID_UNION_PATTERN = /<root>:invalid_union/;
export const CAPPED_UNION_DIAGNOSTIC_PATTERN = /union-8:invalid_union/;
export const UNCAPPED_UNION_LEAF_PATTERN = /leaf:invalid_type/;
export const REVIEWED_NORMALIZED_TOOL_USE_FIELDS = {
  name: "Bash",
  rawName: "Bash",
  normalizedName: "Bash",
  kind: "builtin",
  timestamp: "2026-06-07T12:00:00.000Z",
  input: { command: "gh pr create" },
  output: "created pull request",
  isError: false,
  mcpServer: "github",
  mcpMethod: "pull_request.create",
  skillName: "github:yeet",
  diffDelta: { add: 3, del: 1 },
  id: "toolu_123",
  providerToolUseId: "toolu_123",
  definitionSnapshot: {
    kind: NormalizedDefinitionKind.Skill,
    rawName: "review",
    normalizedName: "review",
    content: "# Review\n",
    capturedAt: "2026-06-07T12:00:00.000Z",
  },
  resultTimestamp: "2026-06-07T12:00:01.000Z",
  gitBranch: "feat/parser-fix",
  subagentId: null,
} satisfies Record<keyof NormalizedToolUse, unknown>;
