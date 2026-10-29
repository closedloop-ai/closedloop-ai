import type { SessionMeshHookEvent } from "./session-mesh-hook-contract.js";

/**
 * Reading a native hook event's fields: which session and agent it names, which
 * files it touches, and which Mesh message kind (if any) it becomes.
 *
 * Split out of `session-mesh-runtime.ts` (ISS-11425). Every function here is
 * pure over one event, so the runtime keeps only the decisions.
 */
const EDIT_TOOL_PATTERN = /Edit|Write|apply_patch/;
const PATCH_FILE_PATTERN =
  /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm;
export function sessionIdFrom(event: SessionMeshHookEvent): string {
  return typeof event.data.session_id === "string" ? event.data.session_id : "";
}
export function nativeAgentId(event: SessionMeshHookEvent): string {
  const identity =
    typeof event.data.agent_id === "string"
      ? event.data.agent_id
      : event.data.session_id;
  return `${event.harness}:${String(identity ?? "")}`;
}
export function nativeFiles(event: SessionMeshHookEvent): string[] {
  const tool = event.data.tool_input;
  if (
    tool &&
    typeof tool === "object" &&
    "file_path" in tool &&
    typeof tool.file_path === "string"
  ) {
    return [tool.file_path];
  }
  let patch: unknown = tool;
  if (tool && typeof tool === "object" && "input" in tool) {
    patch = tool.input;
  }
  if (tool && typeof tool === "object" && "command" in tool) {
    patch = tool.command;
  }
  return typeof patch === "string"
    ? [...patch.matchAll(PATCH_FILE_PATTERN)]
        .map((match) => match[1])
        .filter((file): file is string => Boolean(file))
        .slice(0, 200)
    : [];
}

export function messageKind(event: SessionMeshHookEvent, file?: string) {
  if (event.hookType === "SessionStart" || event.hookType === "SubagentStart") {
    return "work_started";
  }
  if (event.hookType === "SessionEnd" || event.hookType === "SubagentStop") {
    return "session_ended";
  }
  if (
    file &&
    event.hookType === "PreToolUse" &&
    EDIT_TOOL_PATTERN.test(String(event.data.tool_name))
  ) {
    return "claim";
  }
  return null;
}
