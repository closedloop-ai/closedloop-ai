import type { LoopHarness } from "../../src/desktop-request";
import type { ObservabilityAdapterContext } from "../../src/observability";

/**
 * Centralized harness-stream mock suite + helpers for the observability adapter
 * tests (repo test convention: one shared fixture module, table-driven harness).
 */

/**
 * Deterministic ISO clock advancing `stepMs` per call. Lets adapter tests assert
 * exact symphony-stamped timestamps/durations without wall-clock flakiness.
 */
export function makeClock(
  startIso = "2026-06-10T00:00:00.000Z",
  stepMs = 1000
): () => string {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}

/** Build an adapter context with a deterministic clock. */
export function makeContext(
  harness: LoopHarness,
  now: () => string,
  overrides: Partial<ObservabilityAdapterContext> = {}
): ObservabilityAdapterContext {
  return {
    runId: "loop_123",
    iteration: 1,
    command: "EXECUTE",
    harness,
    now,
    ...overrides,
  };
}

/**
 * Claude stream-json fixture: one regular tool (Bash) and one subagent (Task)
 * spawn/stop, with a session id. Mirrors `claude -p --output-format stream-json`.
 */
export const CLAUDE_STREAM_FIXTURE: unknown[] = [
  { type: "system", subtype: "init", session_id: "sess_1" },
  {
    type: "assistant",
    session_id: "sess_1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "text", text: "running a command" },
        {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "ls -la" },
        },
      ],
    },
  },
  {
    type: "user",
    session_id: "sess_1",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          is_error: false,
          content: "total 0",
        },
      ],
    },
  },
  {
    type: "assistant",
    session_id: "sess_1",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_task",
          name: "Task",
          input: {
            subagent_type: "code-reviewer",
            description: "Review the diff",
          },
        },
      ],
    },
  },
  {
    type: "user",
    session_id: "sess_1",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_task",
          is_error: false,
          content: "looks good",
        },
      ],
    },
  },
];

/**
 * Codex `exec --json` fixture including `command_execution`, `file_change`, and
 * `turn.completed.usage` (AC-009). `file_change` has no `item.started`, exercising
 * the stamp-at-completion path (AC-011).
 */
export const CODEX_STREAM_FIXTURE: unknown[] = [
  { type: "thread.started", thread_id: "th_1" },
  { type: "turn.started" },
  {
    type: "item.started",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "pnpm test",
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "pnpm test",
      exit_code: 0,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "item_1",
      type: "file_change",
      changes: [{ path: "src/a.ts", kind: "update" }],
      status: "completed",
    },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    },
  },
];
