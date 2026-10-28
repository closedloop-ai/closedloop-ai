/**
 * @file component-invocation-stored-event-fields.ts
 * @description The three properties the stored-row rebuild derives from an
 * `events.data` payload: the invocation KIND and key, the harness tool-use id,
 * and (ISS-10730) the per-edit line delta.
 *
 * Extracted from `component-invocations.ts`, which is over the file-size
 * ceiling and shrink-only (root AGENTS.md). One responsibility: reading an
 * untrusted persisted JSON payload and answering what it says about the
 * invocation, with no knowledge of how a candidate is assembled.
 */

import {
  AgentComponentInvocationKind,
  type AgentComponentInvocationKind as InvocationKindValue,
} from "@repo/api/src/types/agent-component-invocation";
import { asRecord, stringValue } from "@repo/lib/harness/parser-utils";

type InvocationKind = InvocationKindValue;

export function classifyStoredTool(
  toolName: string,
  data: Record<string, unknown> | null
): { kind: InvocationKind; key: string } {
  const toolInput = asRecord(data?.tool_input);
  const skillName =
    stringValue(data?.skillName) ??
    stringValue(toolInput?.skill) ??
    stringValue(data?.skill);
  if (toolName === "Skill" && skillName) {
    return { kind: AgentComponentInvocationKind.Skill, key: skillName };
  }
  if (toolName.startsWith("mcp__")) {
    return {
      kind: AgentComponentInvocationKind.Mcp,
      key: stringValue(data?.mcpServer) ?? toolName,
    };
  }
  if (data?.kind === "harness") {
    return {
      kind: AgentComponentInvocationKind.Orchestration,
      key: toolName,
    };
  }
  return { kind: AgentComponentInvocationKind.Tool, key: toolName };
}

export function storedProviderToolUseId(
  data: Record<string, unknown> | null
): string | null {
  return (
    stringValue(data?.providerToolUseId) ??
    stringValue(data?.provider_tool_use_id) ??
    stringValue(data?.toolUseId) ??
    stringValue(data?.tool_use_id)
  );
}
