/**
 * @file tool-result-outcome.ts
 * @description Whether a tool call completed, and whether its result was an
 * error, read once for the event import and both invocation derivations.
 *
 * Completion is explicit only once a result exists. An omitted and a `false`
 * `isError` both mean the call completed without error; a call with no result
 * is incomplete and carries no verdict either way.
 *
 * Codex is the exception: its parser cannot see an error flag in a plain-text
 * output, so its `isError` is `false` whether or not the call failed (PR #9097
 * review, thread PRRT_kwDOQ4gDpM6u_bTv). A Codex verdict is read from the exit
 * code the output carries, and is unknown (`null`) when it carries none.
 */

import {
  type AgentComponentInvocationKind,
  isAgentComponentInvocationKindIn,
  TOOL_RESULT_SUCCESS_BEARING_INVOCATION_KINDS,
} from "@repo/api/src/types/agent-component-invocation";
import { z } from "zod";
import { Harness, type NormalizedToolUse } from "../collectors/types.js";

type ToolResultFields = Pick<
  NormalizedToolUse,
  "output" | "resultTimestamp" | "isError"
>;

export function toolUseHasResult(toolUse: ToolResultFields): boolean {
  return (
    toolUse.output !== undefined ||
    toolUse.resultTimestamp != null ||
    toolUse.isError !== undefined
  );
}

/** The invocation's three-valued `succeeded`: NULL until a result exists. */
export function toolUseSucceeded(
  toolUse: ToolResultFields,
  harness: string | null
): boolean | null {
  if (!toolUseHasResult(toolUse)) {
    return null;
  }
  if (harness === Harness.Codex) {
    return codexOutputSucceeded(toolUse.output);
  }
  return toolUse.isError !== true;
}

/**
 * The same verdict read back from a stored `events.data` payload, which
 * `importToolEventData` writes `isError` into only once a result exists. Only a
 * tool-result kind carries one: a stored `Skill` event rebuilds as a `skill`
 * row, which the transcript derivation never gives a verdict.
 */
export function storedToolResultSucceeded(
  kind: AgentComponentInvocationKind,
  data: Record<string, unknown> | null,
  harness: string | null
): boolean | null {
  if (
    !isAgentComponentInvocationKindIn(
      TOOL_RESULT_SUCCESS_BEARING_INVOCATION_KINDS,
      kind
    )
  ) {
    return null;
  }
  if (typeof data?.isError !== "boolean") {
    return null;
  }
  if (harness === Harness.Codex) {
    return codexOutputSucceeded(data.tool_response);
  }
  return !data.isError;
}

/**
 * A Codex output's exit code, from the `Process exited with code N` header of
 * an exec output or the `metadata.exit_code` of a JSON-encoded one (the
 * `apply_patch` shape). Any other output, including a still-running process, an
 * MCP result, or a JSON body cut off by the 4 KiB output cap, is unknown.
 */
function codexOutputSucceeded(output: unknown): boolean | null {
  if (typeof output !== "string") {
    return null;
  }
  const header = output.split(CODEX_EXEC_OUTPUT_BODY_MARKER, 1)[0];
  const exited = CODEX_EXEC_EXIT_CODE_RE.exec(header);
  if (exited) {
    return Number(exited[1]) === 0;
  }
  const exitCode = codexJsonExitCode(output);
  return exitCode === null ? null : exitCode === 0;
}

function codexJsonExitCode(output: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const result = CodexJsonOutputSchema.safeParse(parsed);
  return result.success ? result.data.metadata.exit_code : null;
}

const CODEX_EXEC_OUTPUT_BODY_MARKER = "\nOutput:\n";
const CODEX_EXEC_EXIT_CODE_RE = /^Process exited with code (-?\d+)$/m;
const CodexJsonOutputSchema = z.object({
  metadata: z.object({ exit_code: z.number().int() }),
});
