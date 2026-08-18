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
import type { SessionRowResolutionOptions } from "@repo/app/agents/lib/session-table-row";
import { sessionsFor } from "./detail-data";

export type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";

/**
 * Map `AgentComponentDetail.sessionsTab` items to `SessionTableRow[]`.
 *
 * `component` is accepted for API symmetry with `sessionsFor` and may be used
 * for future filtering/sorting extensions; it is not used for the mapping itself.
 *
 * ISS-4979: `durationOptions` is forwarded to the row mapper so this tab's
 * Duration cells resolve a zero calendar span under the same rule as every other
 * Duration surface. See `sessionsFor`.
 *
 * Returns `SessionTableRow[]` ready for the shared `SessionsTable` component.
 */
export function adaptAgentComponentSessions(
  component: AgentComponent,
  sessions: readonly AgentSessionListItem[],
  rowOptions: SessionRowResolutionOptions = {}
): SessionTableRow[] {
  return sessionsFor(component, sessions, rowOptions);
}

/**
 * ISS-5464: the minimum a surface needs to build a session-detail href.
 *
 * Both surfaces' builders read only the canonical session id — web composes
 * `/{orgSlug}/sessions/{id}`, desktop `desktopSessionDetailHref`. Typing the
 * callback's parameter as a whole `SessionTableRow` meant a caller had to hold
 * a fully-enriched row just to make a link, which is what coupled the Evidence
 * tab's links to the bounded `sessionsTab` array. A `SessionTableRow` still
 * satisfies this shape, so every existing call site is unaffected.
 */
export type SessionHrefTarget = {
  id: string;
};
