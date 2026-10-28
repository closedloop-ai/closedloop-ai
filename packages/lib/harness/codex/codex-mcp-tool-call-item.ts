/**
 * ISS-12552: Codex code-mode MCP calls. Code mode records
 * each MCP call only as an `item_completed` event carrying an `McpToolCall`
 * item; no response item shares its id. The item id is the `_meta.callId`
 * Codex sends the MCP server, so it is the key a server receipt joins on.
 */

import { msToIso, toolResultText, truncateText } from "../parser-utils";
import { recordToolResultFacts } from "../tool-result-facts";
import { asRecord } from "../type-guards";
import type { NormalizedToolUse } from "../types";
import { asStr, type Rec, type RolloutAccumulator } from "./codex-accumulator";
import { bindNestedCall } from "./codex-request-binding";

export const MCP_TOOL_CALL_ITEM_TYPE = "McpToolCall";

/**
 * The code-mode tool whose scripts make those MCP calls. Its output echoes the
 * calls' results and, when a script lists the tool catalog, every tool's
 * description, so its text is not a mention by the session.
 */
export const CODEX_CODE_MODE_TOOL_NAME = "exec";

const FAILED_STATUS = "failed";

/**
 * Record one `McpToolCall` item. A call the tool stream already holds (a
 * namespaced `function_call`, or an `mcp_tool_call_begin` in an event-only
 * log) gains only its call id and, if it has none yet, its result facts. Any
 * other call becomes evidence, outside `toolUses`, once per call id.
 */
export function recordMcpToolCallItem(
  acc: RolloutAccumulator,
  item: Rec,
  event: Rec,
  iso: string | null
): void {
  const callId = asStr(item.id);
  const resultText = readResultText(item);
  const isError = readIsError(item);
  const streamIndex = callId ? acc.toolCallIndex.get(callId) : undefined;
  const streamTool =
    streamIndex === undefined ? undefined : acc.toolUses[streamIndex];
  if (streamTool) {
    if (callId) {
      streamTool.providerToolUseId ??= callId;
    }
    if (streamTool.resultState === undefined) {
      recordToolResultFacts(streamTool, resultText, isError);
    }
    return;
  }
  if (callId) {
    if (acc.mcpCallEvidenceIds.has(callId)) {
      return;
    }
    acc.mcpCallEvidenceIds.add(callId);
  }
  const server = asStr(item.server) ?? undefined;
  const tool = asStr(item.tool) ?? undefined;
  const evidence: NormalizedToolUse = {
    name: server && tool ? `${server}__${tool}` : (tool ?? "mcp_tool"),
    timestamp: readMsIso(event.started_at_ms) ?? iso ?? acc.firstTimestamp,
    input: item.arguments ?? null,
    mcpServer: server,
    mcpMethod: tool,
    ...(callId ? { providerToolUseId: callId } : {}),
    isError,
    resultTimestamp: readMsIso(event.completed_at_ms) ?? iso,
  };
  recordToolResultFacts(evidence, resultText, isError);
  evidence.output = truncateText(resultText);
  bindNestedCall(acc, evidence);
  acc.mcpCallEvidence.push(evidence);
}

function readResultText(item: Rec): string | null {
  const result = asRecord(item.result);
  if (result && Array.isArray(result.content)) {
    return toolResultText(result);
  }
  return asStr(item.error) ?? null;
}

function readIsError(item: Rec): boolean {
  return (
    item.status === FAILED_STATUS ||
    asRecord(item.result)?.isError === true ||
    item.error != null
  );
}

function readMsIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? msToIso(value)
    : null;
}
