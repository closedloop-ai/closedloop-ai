import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";

/**
 * The name a Session is shown under: its own name, else its harness session id.
 * The Session Details page heading and every control that names the session
 * read this, so they always name the same session.
 */
export function sessionTitle(
  session: Pick<AgentSessionDetail, "externalSessionId" | "name">
): string {
  return session.name ?? session.externalSessionId;
}
