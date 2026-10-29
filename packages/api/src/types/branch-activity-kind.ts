/** Activity class retained for monitored Session evidence. */
export const MonitoredSessionActivityEventKind = {
  UserReference: "user_reference",
  AgentRead: "agent_read",
  AgentAction: "agent_action",
} as const;
export type MonitoredSessionActivityEventKind =
  (typeof MonitoredSessionActivityEventKind)[keyof typeof MonitoredSessionActivityEventKind];
