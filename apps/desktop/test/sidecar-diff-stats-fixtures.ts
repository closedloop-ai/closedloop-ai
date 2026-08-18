/**
 * @file sidecar-diff-stats-fixtures.ts
 * @description Shared transcript-line builders for the Claude sidecar
 * `diffStats` suites (ISS-5402 roll-up, ISS-5426 dedup).
 *
 * Extracted rather than copied: the two suites assert opposite halves of the
 * same fold, so a fixture that drifted between them — a different line delta, a
 * different usage block — would silently make one suite's arithmetic stop
 * describing the other's. Not a `.test.ts`, so the node:test runner does not
 * collect it as a suite of its own.
 */

/** The one model every fixture line bills to. */
export const MODEL = "claude-opus-4-5";

/** A usage block; every assistant line needs one to be folded at all. */
export function usage() {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

/** An assistant line whose content blocks are supplied by the caller. */
export function assistantLine(
  uuid: string,
  requestId: string,
  messageId: string,
  content: unknown[],
  extra: Record<string, unknown> = {}
) {
  return {
    type: "assistant",
    timestamp: "2026-08-06T10:00:05.000Z",
    uuid,
    requestId,
    message: { id: messageId, model: MODEL, usage: usage(), content },
    ...extra,
  };
}

/** An `Edit` tool_use block with a known 2-added / 1-removed delta. */
export function editBlock(id: string, filePath: string) {
  return {
    type: "tool_use",
    id,
    name: "Edit",
    input: {
      file_path: filePath,
      old_string: "alpha",
      new_string: "beta\ngamma",
    },
  };
}

/**
 * A `Write` tool_use block. `id` is optional because `tool_use.id` is raw
 * transcript JSON and its absence is exactly the shape the idless cases probe.
 */
export function writeBlock(
  id: string | undefined,
  filePath: string,
  content: unknown
) {
  return {
    type: "tool_use",
    ...(id === undefined ? {} : { id }),
    name: "Write",
    input: { file_path: filePath, content },
  };
}

/**
 * An `Edit` block whose payload carries NEITHER edited side — the shape the
 * shared schema gate rejects, and which the parent's total handlers coerce into
 * a `{0, 0}` delta over a file it cannot show was changed.
 */
export function malformedEditBlock(id: string, filePath: string) {
  return {
    type: "tool_use",
    id,
    name: "Edit",
    input: { file_path: filePath },
  };
}

/** A `Skill` tool_use block, whose merged record drives `session.skills`. */
export function skillBlock(id: string | undefined, skill: string) {
  return {
    type: "tool_use",
    ...(id === undefined ? {} : { id }),
    name: "Skill",
    input: { skill },
  };
}

/** Every folded assistant turn in these fixtures bills this much. */
export const OUTPUT_TOKENS_PER_TURN = 50;
export const INPUT_TOKENS_PER_TURN = 100;

export const OPENING_USER_LINE = {
  type: "user",
  timestamp: "2026-08-06T10:00:00.000Z",
  cwd: "/test",
};

/** The parent's own turn, carrying whatever blocks the fixture needs. */
export function parentTurn(content: unknown[]) {
  return assistantLine("u1", "req_main", "msg_main", content);
}

/** A parent that only delegates — it authors no lines of its own. */
export const DELEGATING_ONLY_PARENT = [
  OPENING_USER_LINE,
  parentTurn([{ type: "text", text: "delegating" }]),
];
