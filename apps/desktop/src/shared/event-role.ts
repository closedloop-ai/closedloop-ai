const HUMAN_EVENTS = new Set(["UserPromptSubmit", "UserMessage"]);
const AGENT_EVENTS = new Set([
  "PostToolUse",
  "PreToolUse",
  "AssistantMessage",
  "SubagentStop",
  "Stop",
]);

export function eventRole(eventType: string): "human" | "agent" | "system" {
  if (HUMAN_EVENTS.has(eventType)) {
    return "human";
  }
  if (AGENT_EVENTS.has(eventType)) {
    return "agent";
  }
  return "system";
}
