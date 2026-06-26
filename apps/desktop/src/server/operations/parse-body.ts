import type { OperationRequestContext } from "../operation-dispatcher.js";

export function parseBody(
  context: OperationRequestContext
): Record<string, unknown> | null {
  if (!context.body.trim()) {
    return {};
  }

  try {
    return JSON.parse(context.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}
