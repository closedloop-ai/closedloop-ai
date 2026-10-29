import type { TurnItem } from "@repo/api/src/types/agent-session";

/** Every tool call row across the detail's `tools` turn items, in order. */
export function toolRows(turnItems: readonly TurnItem[] | undefined) {
  return (turnItems ?? []).flatMap((item) =>
    item.type === "tools" ? item.items : []
  );
}

/**
 * A turn row's attribution: the human actor on a prompt, the message model on
 * an assistant row, and the first call's label and detail on a tools row.
 */
export function turnRowAttribution(
  item: TurnItem
): (string | null | undefined)[] {
  if (item.type === "prompt") {
    return [item.type, item.actor.human];
  }
  if (item.type === "say") {
    return [item.type, item.model];
  }
  if (item.type === "tools") {
    return [item.type, item.items[0]?.label, item.items[0]?.detail];
  }
  return [item.type];
}

/** Event rows behind the turn items: one per tool call, one per other turn. */
export function projectedEventRowCount(
  turnItems: readonly TurnItem[] | undefined
): number {
  return (turnItems ?? []).reduce(
    (total, item) => total + (item.type === "tools" ? item.items.length : 1),
    0
  );
}
