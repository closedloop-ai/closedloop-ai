import type {
  DesktopAgentSessionsPayload,
  SyncedAgentSession,
} from "@repo/api/src/types/agent-session";

/**
 * ISS-12552 (PRD-800 "Rollout"): a sync payload without the operation
 * evidence PRD-800 added to the wire, for an organization the attribution flag
 * is off for. Token-event owners stay: new events store them as before
 * PRD-800, and a changed owner on a stored event is left alone by the token
 * persistence while the flag is off.
 */
export function withoutAttributionEvidence(
  payload: DesktopAgentSessionsPayload
): DesktopAgentSessionsPayload {
  return { ...payload, sessions: payload.sessions.map(sessionWithout) };
}

function sessionWithout(session: SyncedAgentSession): SyncedAgentSession {
  const { operationEvidence: _operationEvidence, ...rest } = session;
  return rest;
}
