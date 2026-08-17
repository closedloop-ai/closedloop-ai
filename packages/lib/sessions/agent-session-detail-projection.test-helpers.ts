import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";

/**
 * Shared builders for the Agent Session detail-projection test suites. The
 * suite is split across sibling `*.test.ts` files by responsibility (timeline
 * events vs. turn items / fallback state), so these fixture factories live in
 * one place instead of being duplicated per file.
 */

export function event(
  overrides: Partial<SyncedAgentSessionEvent> &
    Pick<SyncedAgentSessionEvent, "externalEventId" | "eventType" | "createdAt">
): SyncedAgentSessionEvent {
  return { ...overrides };
}

export function agent(
  overrides: Partial<SyncedAgentSessionAgent> &
    Pick<
      SyncedAgentSessionAgent,
      "externalAgentId" | "name" | "type" | "status"
    >
): SyncedAgentSessionAgent {
  return { ...overrides };
}
