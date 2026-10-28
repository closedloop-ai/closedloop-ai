"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  CircleAlertIcon,
  ListTreeIcon,
  LockIcon,
  RefreshCwIcon,
} from "lucide-react";

/**
 * ISS-10793: the Branch Sessions panel's own states. `loading` keeps today's
 * skeleton and `ready` is the timeline; `partial` is not a separate state --
 * it is the ready timeline with its inline coverage notes and the trace's
 * hydration warning, so the rendered sessions stay visible.
 */
export type BranchSessionsPanelState =
  | "ready"
  | "loading"
  | "empty"
  | "error"
  | "permission";

/**
 * Empty-state wording reused verbatim from production's Branch page
 * (`branch-detail-page.tsx`, "No sessions on this branch yet"), so the panel
 * introduces no new copy. Exported so tests locate the rendered text.
 */
export const BRANCH_SESSIONS_EMPTY_TITLE = "No sessions on this branch yet";
export const BRANCH_SESSIONS_EMPTY_DESCRIPTION =
  "Sessions appear here once an agent works this branch. There's nothing to show yet.";

/**
 * Wording for the host-set error and permission views. The panel ships none
 * (root AGENTS.md, Human Provenance): production has no such copy today, so
 * the adopting host (ISS-10797) supplies it with the state.
 */
export type BranchSessionsStateContent = {
  description: string;
  title: string;
};

/**
 * Per-state wording, keyed by state like ISS-10791's ArtifactTab
 * `stateContent`, so a host passes one map and the panel looks up
 * `stateContent?.[state]`. An entry, when passed, must carry both a title and
 * a description. A host that shows `error` or `permission` without its entry
 * gets the icon alone (plus Retry for `error`), never an empty heading:
 * ArtifactTab's rule. `empty` uses production's shipped copy and `loading` is
 * the skeleton, so neither takes wording.
 */
export type BranchSessionsStateContentMap = Readonly<{
  error?: BranchSessionsStateContent;
  permission?: BranchSessionsStateContent;
}>;

/**
 * The host-set state. Omitted, the panel shows `loading` while
 * `trace.isLoading` and the timeline otherwise. Supplied, it WINS over
 * `trace.isLoading`, so the host carries loading itself (pass `"loading"`
 * while its own query loads) -- except `"ready"`, which still shows the
 * skeleton until a trace has arrived. A `loading` that follows a rendered
 * timeline (a refetch) keeps the timeline mounted with `aria-busy`, so its
 * playhead, scroll and comment drafts survive (the ArtifactTab refetch rule).
 */
export type BranchSessionsPanelStateProps = {
  state?: BranchSessionsPanelState;
  stateContent?: BranchSessionsStateContentMap;
};

export function BranchSessionsPanelStateView({
  content,
  onRetry,
  state,
}: {
  content?: BranchSessionsStateContent;
  onRetry?: () => void;
  state: Exclude<BranchSessionsPanelState, "ready" | "loading">;
}) {
  // Runtime guard for callers the types cannot see (an untyped host, a cast):
  // wording that is missing or blank renders the icon alone, never an empty
  // heading or an alert that announces nothing.
  const title = content?.title?.trim() ? content.title : undefined;
  const description = content?.description?.trim()
    ? content.description
    : undefined;
  const retry = onRetry ? (
    <Button className="mt-2" onClick={onRetry} size="sm" variant="outline">
      <RefreshCwIcon aria-hidden="true" />
      Retry
    </Button>
  ) : null;

  if (state === "error") {
    return (
      <div
        className="flex flex-1 items-center justify-center p-8"
        data-branch-sessions-state={state}
      >
        {title ? (
          <Alert className="max-w-md" variant="error">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
              {description ? <p>{description}</p> : null}
              {retry}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col items-center">
            <CircleAlertIcon
              aria-hidden="true"
              className="size-6 text-muted-foreground"
            />
            {retry}
          </div>
        )}
      </div>
    );
  }

  const permission = state === "permission";
  if (permission && !title) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-8"
        data-branch-sessions-state={state}
      >
        <LockIcon aria-hidden="true" className="size-6 text-muted-foreground" />
      </div>
    );
  }
  // `EmptyState` (size="compact") rather than a local div + icon + h2 + p: the
  // design system already draws this concept, and `branch-detail-page.tsx`
  // renders the same two strings through it. Its title is a styled div, not a
  // heading -- this panel mounts inside the Branch detail page, which owns the
  // document outline, so a real h2 here would land in the middle of it.
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-branch-sessions-state={state}
    >
      <EmptyState
        description={
          permission ? description : BRANCH_SESSIONS_EMPTY_DESCRIPTION
        }
        icon={permission ? LockIcon : ListTreeIcon}
        size="compact"
        title={permission && title ? title : BRANCH_SESSIONS_EMPTY_TITLE}
      />
    </div>
  );
}
