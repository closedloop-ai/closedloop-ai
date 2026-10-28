import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";

/** True when every row explicitly carries the custom-field projection. */
export function everySessionHasCustomFieldProjection(
  items: readonly AgentSessionListItem[]
): boolean {
  return items.every((item) => item.customFields !== undefined);
}
