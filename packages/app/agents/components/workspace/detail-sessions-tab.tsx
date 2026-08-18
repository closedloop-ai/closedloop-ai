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

import type {
  AgentComponent,
  AgentComponentDetail,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link } from "@repo/navigation/link";
import { Clock3Icon } from "lucide-react";
import type { SessionHrefTarget } from "../../lib/agent-component-session-adapter";
import { adaptAgentComponentSessions } from "../../lib/agent-component-session-adapter";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import {
  DetailTabUnit,
  detailTabTruncationReadout,
} from "../../lib/detail-tab-truncation-readout";
import { resolveUsageSignal, UsageSignal } from "../../lib/usage-signal";
import { versionLabelBySession } from "../../lib/version-label";
import { SessionsTable } from "../sessions/sessions-table";

export function DetailSessionsTab({
  component,
  sessions,
  sessionsTabTruncated = false,
  usageSessions,
  versions,
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
   * ISS-5464: the PRODUCER's statement that `sessions` is a bounded sample
   * rather than the whole set (`detail.sessionsTabTruncated`). Defaults to
   * `false` so the tab never invents a truncation for a caller that renders a
   * list it assembled itself; the `delivered > rendered` arm still covers a
   * payload this tab visibly cut.
   */
  sessionsTabTruncated?: boolean;
  /**
   * Per-session version attribution (FEA-2923). When present (and a version
   * history exists), a "Version" column shows the revision each session ran.
   */
  usageSessions?: AgentComponentDetail["usageSessions"];
  versions?: readonly ComponentVersion[];
  /**
   * Optional: wrap the session name in a platform-owned navigation link.
   * When omitted the name renders as a plain `<span>` (non-navigable).
   */
  getSessionHref?: (session: SessionHrefTarget) => string;
}) {
  // Bound the rendered row count (FEA-3579). The detail page has no
  // pagination or virtualization, so a component with a large usage history
  // would render every session row at once — blowing up the DOM/memory and
  // freezing the browser tab. Cap at AGENTS_PAGE_SIZE (the same page size the
  // list view uses) so the DOM stays bounded regardless of dataset size.
  // ISS-4996 / ISS-4997 / ISS-4998 (wongk, #4324): the staleness fold and the
  // Duration cell both read the clock, so this tab needs the same coarse time
  // signal the list adapters use — otherwise a row that crosses the cutoff keeps
  // reading "Active" and a running session's Duration sits frozen at mount. This
  // tab is a shipped product surface, not test scaffolding: it mounts the shared
  // `SessionsTable` over the same `AgentSessionListItem` records the main
  // Sessions list does, so leaving it on a different clock would give the product
  // two Sessions grids disagreeing about one session. Ungated for the ISS-5131
  // reason spelled out in `synced-sessions-table.tsx`: Duration is not behind a
  // flag, so its clock must not be either.
  const now = useCoarseNow(SESSION_DURATION_TICK_MS);
  const rows = adaptAgentComponentSessions(component, sessions, {
    now,
  }).slice(0, AGENTS_PAGE_SIZE);
  // ISS-5464: the truncation notice must count the sessions that EXIST, not the
  // ones that happened to travel in this payload. See `sessionsTruncationNotice`.
  const truncationNotice = sessionsTruncationNotice(
    component.sessions,
    sessions.length,
    rows.length,
    sessionsTabTruncated
  );
  const labelBySession = versionLabelBySession(
    usageSessions ?? [],
    versions ?? []
  );
  const showVersion = labelBySession.size > 0;

  // Zero-row state: mirror the shared Sessions list surface
  // (`AgentSessionsListContent`), which renders the DS `EmptyState` rather than
  // a bare, body-less `GridTable` header. `compact` is the in-panel scale (this
  // tab sits inside the detail page alongside other sections).
  //
  // An empty `sessionsTab` projection is NOT proof of "no sessions" (wongk,
  // #3688). Desktop's local detail reader keeps a nonzero `component.sessions`
  // metric (and `usageSessions` attribution rows) even when it cannot hydrate
  // the individual session records into `sessionsTab`. Telling the user "no
  // sessions have invoked this component" while the metrics above say otherwise
  // is a lying empty state. So split true-zero (no usage anywhere) from
  // details-unavailable (usage exists but this source can't project the rows).
  // ISS-5363 (wongk): `?? 0` here turned an UNMEASURED session count into a
  // confident "No sessions yet" while the Sessions card directly above showed a
  // dash for the same payload. The shared `resolveUsageSignal` keeps the three
  // states apart, so the denial is only ever printed when the count was actually
  // measured as zero.
  if (rows.length === 0) {
    return (
      <SessionsEmptyState
        signal={resolveUsageSignal(
          component.sessions,
          usageSessions?.length ?? 0
        )}
      />
    );
  }

  return (
    <>
      <SessionsTable
        extraColumnLabel={showVersion ? "Version" : undefined}
        items={rows}
        renderExtraColumn={
          showVersion
            ? (row) =>
                labelBySession.has(row.id) ? (
                  <span className="text-sm">{labelBySession.get(row.id)}</span>
                ) : (
                  <span className="text-muted-foreground text-sm">—</span>
                )
            : undefined
        }
        renderName={(row, className) =>
          getSessionHref ? (
            // FEA-4051: surface-agnostic `@repo/navigation` `Link` (renders a
            // real anchor) drives the active adapter on both web (Next router)
            // and the desktop renderer (hash-store adapter). A raw `<a href>`
            // was a dead click on desktop. Mirrors FEA-4018's agents-table fix.
            <Link
              className={`${className} min-w-0 hover:underline`}
              href={getSessionHref(row)}
            >
              {row.name}
            </Link>
          ) : (
            <span className={className}>{row.name}</span>
          )
        }
        /* ISS-5770: this tab keeps the provenance chip beside the session name.
           It used to get it implicitly, by wiring no `renderQualifiers` seam
           while the Sessions list wired one; removing the `Signals` column
           removed that inference, so the opt-in is now stated. The chip is the
           only place this surface has ever carried the "not started by a human"
           signal, and dropping it would be a silent verdict drop rather than the
           de-crowding ISS-5666 asked for. */
        showProvenanceChip
      />
      {truncationNotice ? (
        <p className="mt-2 text-muted-foreground text-sm">{truncationNotice}</p>
      ) : null}
    </>
  );
}

/**
 * The zero-row state, split by what the payload can actually prove.
 *
 * `Present` is the wongk/#3688 case: desktop's local detail keeps a nonzero
 * session metric (and `usageSessions` attribution rows) while returning an empty
 * `sessionsTab`, so "no sessions have invoked this" would contradict the card
 * above. `Unknown` is the ISS-5363 case: the producer could not compute the
 * count at all, so neither the denial NOR the "recorded usage" claim is true.
 */
function SessionsEmptyState({ signal }: { signal: UsageSignal }) {
  if (signal === UsageSignal.Present) {
    return (
      <EmptyState
        description="This data source recorded usage but can't list the individual sessions."
        icon={Clock3Icon}
        size="compact"
        title="Session details unavailable"
      />
    );
  }
  if (signal === UsageSignal.Unknown) {
    return (
      <EmptyState
        description="This data source couldn't report the sessions for this component."
        icon={Clock3Icon}
        size="compact"
        title="Sessions unavailable"
      />
    );
  }
  return (
    <EmptyState
      description="No sessions have invoked this component yet."
      icon={Clock3Icon}
      size="compact"
      title="No sessions yet"
    />
  );
}

/**
 * ISS-5464: the Sessions tab's truncation notice, or `null` for "nothing to say".
 *
 * `delivered` (the `sessionsTab` array length) can never be the total — it is
 * bounded on the way here by `MAX_DETAIL_SESSION_IN_IDS` and, since ISS-5464, by
 * the payload row cap. Printing it as "of N" is what
 * made a component with 1218 sessions read "Showing 50 of 1000" beside a
 * Sessions card reading 1218. The detail's own `sessions` field is the uncapped
 * count, so it is the only honest total.
 *
 * That total is only usable when it is CREDIBLE. It is `number | null`
 * (ISS-5363 — null means the producer could not compute it), and the desktop
 * adapter can resolve it to a placeholder `0` while still delivering rows
 * (`shared-agent-components-api.ts`, `resolved?.sessions ?? 0`). A total below
 * the row count we actually received is not a total, so it is treated exactly
 * like `null` rather than printed or silently believed.
 *
 * The notice deliberately does NOT claim these are the most recent sessions,
 * though the read is recency-ordered. Two upstream steps break that claim and
 * neither is visible from here: `resolveDetailSessionTabs` slices the session-id
 * set to `MAX_DETAIL_SESSION_IN_IDS` from an UNORDERED group-by, so above 1000
 * sessions the delivered rows are the recency-head of an arbitrary subset; and
 * desktop's local reader silently drops ids it cannot hydrate. "Showing 50 of
 * 1218 sessions." is true either way; "(most recent)" would not be.
 *
 * With no credible total we cannot state one — but silence would imply
 * completeness, which is the same lie one field over. So the delivered count is
 * printed as a FLOOR instead, using the repo's `+` marker
 * (`resolveMyTasksTruncation`): "Showing 50 of 50+ sessions". The previous
 * wording ("Showing 50 sessions; total unavailable.") reported on our own data
 * pipeline rather than telling the reader what they are looking at, and the
 * shared {@link detailTabTruncationReadout} now holds the phrasing so this tab,
 * the Branches tab and the Evidence table cannot drift into three shapes on one
 * page again.
 */
function sessionsTruncationNotice(
  trueTotal: number | null | undefined,
  delivered: number,
  rendered: number,
  sessionsTabTruncated: boolean
): string | null {
  // `== null` covers BOTH null (ISS-5363's "producer could not compute it") and
  // undefined, which a version-skewed payload that predates the field can still
  // deliver at runtime whatever the type says.
  if (trueTotal != null && trueTotal >= delivered) {
    return detailTabTruncationReadout({
      isTotalPartial: false,
      rendered,
      total: trueTotal,
      unit: DetailTabUnit.Sessions,
    });
  }
  // `delivered > rendered` catches a payload this tab visibly cut. The
  // producer's own flag catches the case it cannot see — a payload the SERVER
  // cut, which on web arrives at exactly `rendered` and would otherwise pass for
  // complete. Reading the flag instead of comparing `delivered` against
  // `AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS` is what stops the desktop
  // false positive: that constant is honoured by the cloud read alone, so on
  // desktop a component with exactly 50 hydrated sessions and nothing dropped
  // used to announce a truncation.
  const mayHaveMore = delivered > rendered || sessionsTabTruncated;
  return mayHaveMore
    ? detailTabTruncationReadout({
        isTotalPartial: true,
        rendered,
        total: delivered,
        unit: DetailTabUnit.Sessions,
      })
    : null;
}
