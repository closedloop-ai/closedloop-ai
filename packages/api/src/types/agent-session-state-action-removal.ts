/**
 * Compatibility tombstone emitted by the removed Session Trace state-action
 * endpoint for stale browser bundles that still call the old route.
 */
export const AgentSessionStateActionRemoval = {
  Message: "Agent session state actions are no longer supported",
  Code: "agent_session_state_actions_removed",
} as const;
export type AgentSessionStateActionRemoval =
  (typeof AgentSessionStateActionRemoval)[keyof typeof AgentSessionStateActionRemoval];
