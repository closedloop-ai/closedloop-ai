"use client";

/**
 * Detail page — Sessions tab (T-3.6).
 *
 * Thin wrapper around the shared `SessionsTable` component. Maps
 * `AgentComponentDetail.sessionsTab` items to `SessionTableRow[]` via the
 * `agent-component-session-adapter` and renders the shared sessions table.
 *
 * Does NOT port `apps/prototypes/app/p/agents/components/detail-sessions-tab.tsx`
 * or its custom `SessionsTable` replica — it reuses the production shared table.
 *
 * Surface-agnostic: callers supply `getSessionHref` for navigation links when
 * available. When omitted, session names render as non-navigable text (safe
 * for contexts where no session route exists yet, e.g. stub Phase 1 data).
 */

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { SessionTableRow } from "../../lib/agent-component-session-adapter";
import { adaptAgentComponentSessions } from "../../lib/agent-component-session-adapter";
import { SessionsTable } from "../sessions/sessions-table";

export type { SessionTableRow } from "../../lib/agent-component-session-adapter";

export function DetailSessionsTab({
  component,
  sessions,
  getSessionHref,
}: {
  /**
   * The parent agent component — passed through to the adapter for future
   * filtering/sorting extensions.
   */
  component: AgentComponent;
  /** Pre-fetched sessions that invoked this component (from `detail.sessionsTab`). */
  sessions: readonly AgentSessionListItem[];
  /**
   * Optional: wrap the session name in a platform-owned navigation link.
   * When omitted the name renders as a plain `<span>` (non-navigable).
   */
  getSessionHref?: (row: SessionTableRow) => string;
}) {
  const rows = adaptAgentComponentSessions(component, sessions);

  return (
    <SessionsTable
      items={rows}
      renderName={(row, className) =>
        getSessionHref ? (
          <a className={`${className} min-w-0`} href={getSessionHref(row)}>
            {row.name}
          </a>
        ) : (
          <span className={className}>{row.name}</span>
        )
      }
    />
  );
}
