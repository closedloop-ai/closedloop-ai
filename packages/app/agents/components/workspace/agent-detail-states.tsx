"use client";

import {
  DetailEmptyState,
  DetailLoadingSkeleton,
  DetailStateShell,
} from "@repo/app/shared/components/detail-state-shell";

/**
 * Presentational loading / not-found / provider-error states for the shared
 * {@link AgentDetail} (FEA-3987). Extracted so they are testable in isolation
 * and so the detail body matches its sibling detail views (BranchDetailPage /
 * AgentSessionDetailView): a `<Skeleton>` while loading, the shared `EmptyState`
 * on 404/empty, and a distinct transient state so a gateway blip never claims
 * the component doesn't exist. The agent/component detail previously used bare
 * centered text for loading and collapsed every read failure into "Component
 * not found".
 *
 * The states share the loaded body's wrapper (`flex-1 overflow-auto` outer +
 * centered `max-w-5xl` column) so the skeleton stands where the real content
 * lands instead of flashing a full-width block that snaps inward. The web
 * agent-detail route's own scroll wrapper already carries the outer inset
 * (`p-6`), so — unlike the sessions surface, whose scroll wrapper has none —
 * these states must not re-pad with `p-4 sm:p-6`.
 */

const STATE_SHELL_CLASS =
  "mx-auto flex w-full max-w-5xl flex-col px-6 pt-10 pb-6";

/**
 * The route's page heading for every state that is not a loaded component. The
 * route sets `suppressPageHeading` because the loaded `DetailHeader` owns a
 * visible `<h1>`; these three branches sit above it and owned none.
 */
const AGENT_PAGE_HEADING = "Agent";

export function AgentDetailLoading() {
  return (
    <div className="flex-1 overflow-auto">
      <DetailStateShell
        className={STATE_SHELL_CLASS}
        heading={AGENT_PAGE_HEADING}
      >
        <DetailLoadingSkeleton
          className="h-[70vh] min-h-80"
          label="Loading component details…"
        />
      </DetailStateShell>
    </div>
  );
}

export function AgentDetailNotFound({ backHref }: { backHref: string }) {
  return (
    <div className="flex-1 overflow-auto">
      <DetailStateShell
        className={STATE_SHELL_CLASS}
        heading={AGENT_PAGE_HEADING}
      >
        <DetailEmptyState
          backHref={backHref}
          backLabel="Back to Agents"
          description="This component doesn't exist. It may have been removed, or it hasn't synced yet."
          title="Component not found"
        />
      </DetailStateShell>
    </div>
  );
}

export function AgentDetailUnavailable({ backHref }: { backHref: string }) {
  return (
    <div className="flex-1 overflow-auto">
      <DetailStateShell
        className={STATE_SHELL_CLASS}
        heading={AGENT_PAGE_HEADING}
      >
        <DetailEmptyState
          backHref={backHref}
          backLabel="Back to Agents"
          description="This component couldn't be loaded right now. It still exists — refresh to try again."
          title="Component unavailable"
        />
      </DetailStateShell>
    </div>
  );
}
