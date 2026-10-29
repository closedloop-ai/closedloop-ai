/** Which assignment a Session bulk call applies. One field per call. */
export const AgentSessionBulkAssignField = {
  Project: "project",
  Owner: "owner",
} as const;

export type AgentSessionBulkAssignField =
  (typeof AgentSessionBulkAssignField)[keyof typeof AgentSessionBulkAssignField];
