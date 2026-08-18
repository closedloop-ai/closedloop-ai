// Shared line fixtures for the parse-claude test suite, extracted so the suite
// can split across sibling files (parse-claude.test.ts,
// parse-claude.cache.test.ts) without duplicating the two canonical JSONL lines.
//
// The desktop suite exercises the Claude parser exhaustively through file I/O.
// These tests pin the browser entry point itself: it parses an in-memory line
// iterable (no fs), honors the no-timestamp null contract, tolerates junk lines,
// and leaves `fileModifiedAt` for the desktop shell to stamp.

export const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/myproject",
  message: { role: "user", content: "hello" },
});

export const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:01.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "hi there" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  },
});

// Parameterized builders for the branch-coverage siblings
// (parse-claude.coverage.test.ts, parse-claude.tools.test.ts), which need to vary
// entry-level fields and content blocks per case rather than reuse a fixed line.

export const BASE_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function assistantLine(
  overrides: Record<string, unknown> = {},
  contentOverride?: unknown[]
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-09T12:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: contentOverride ?? [{ type: "text", text: "hi" }],
      usage: BASE_USAGE,
    },
    ...overrides,
  });
}

export function userLine(
  overrides: Record<string, unknown> = {},
  contentOverride?: unknown
): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "/workspace/project",
    message: {
      role: "user",
      content: contentOverride ?? "hello",
    },
    ...overrides,
  });
}
