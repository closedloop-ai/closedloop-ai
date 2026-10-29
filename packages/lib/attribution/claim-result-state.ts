/**
 * ISS-12552: how much of a tool's result the transcript holds, read the same
 * way for every claim a call produces.
 */
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import type { NormalizedToolUse } from "../harness/types";

/**
 * The parser's state when it recorded one; otherwise, for a session parsed
 * before result facts existed, whether any result was recorded at all.
 */
export function resultStateOf(tu: NormalizedToolUse): ToolResultState {
  if (tu.resultState) {
    return tu.resultState;
  }
  if (tu.output === undefined) {
    return ToolResultState.Missing;
  }
  return tu.isError ? ToolResultState.Error : ToolResultState.Present;
}
