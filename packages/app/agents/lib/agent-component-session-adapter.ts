/**
 * Thin row adapter: AgentSessionListItem[] → SessionTableRow[] (T-3.6).
 *
 * Maps the pre-fetched `AgentComponentDetail.sessionsTab` items to the
 * `SessionTableRow[]` shape consumed by the shared `SessionsTable` component.
 *
 * This is a thin re-export of the existing `sessionsFor` reshape helper from
 * `detail-data.ts`; the adapter file establishes the naming convention for
 * T-3.6's workspace detail tab components and keeps them decoupled from the
 * broader detail-data helpers.
 */

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import { sessionsFor } from "./detail-data";

export type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";

/**
 * Map `AgentComponentDetail.sessionsTab` items to `SessionTableRow[]`.
 *
 * `component` is accepted for API symmetry with `sessionsFor` and may be used
 * for future filtering/sorting extensions; it is not used for the mapping itself.
 *
 * Returns `SessionTableRow[]` ready for the shared `SessionsTable` component.
 */
export function adaptAgentComponentSessions(
  component: AgentComponent,
  sessions: readonly AgentSessionListItem[]
): SessionTableRow[] {
  return sessionsFor(component, sessions);
}
