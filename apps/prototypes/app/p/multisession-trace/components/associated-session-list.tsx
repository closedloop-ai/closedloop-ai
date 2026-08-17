"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronRightIcon, WaypointsIcon } from "lucide-react";
import { useState } from "react";
import {
  type AssociatedSession,
  SESSION_KIND_CONFIG,
  SessionStatus,
} from "../mock";
import { SessionTranscript } from "./session-transcript";

type StatusVariant = "success" | "warning" | "destructive" | "info" | "muted";

// Session status carried by one tokenized chip (color + word in a single
// element) rather than a muted-gray word next to a redundant colored dot.
// Covers the running states (working / waiting / queued) as well as the
// terminal outcomes so the trace can render a live mid-run branch.
const STATUS_CONFIG: Record<
  SessionStatus,
  { label: string; variant: StatusVariant }
> = {
  [SessionStatus.Working]: { label: "Working", variant: "info" },
  [SessionStatus.Waiting]: { label: "Waiting on input", variant: "warning" },
  [SessionStatus.Queued]: { label: "Queued", variant: "muted" },
  [SessionStatus.Ok]: { label: "Completed", variant: "success" },
  [SessionStatus.Changes]: { label: "Changes requested", variant: "warning" },
  [SessionStatus.Failed]: { label: "Failed", variant: "destructive" },
};

/**
 * One associated session rendered as a single scannable box — the Claude Code /
 * Codex collapse discipline. Collapsed: title, a muted kind label, a compact
 * actor · duration · cost meta line, and a one-line outcome, with the status
 * chip pinned right. Expands on demand to that session's own transcript, whose
 * sub-agent work stays collapsed.
 */
function SessionCardHeader({
  session,
  hasTranscript,
  open,
}: {
  session: AssociatedSession;
  hasTranscript: boolean;
  open: boolean;
}) {
  const kind = SESSION_KIND_CONFIG[session.kind];
  const status = STATUS_CONFIG[session.status];

  return (
    <>
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
          // A queued session has nothing to expand; hide the affordance so the
          // row doesn't promise a disclosure it can't deliver.
          !hasTranscript && "invisible",
          open && "rotate-90"
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate font-medium text-sm">{session.title}</span>
          {/* A session's role is its identity, not its state — so it reads as
              plain muted text, leaving the status chip as the row's only color
              and the thing the eye lands on. */}
          <span className="text-muted-foreground text-xs">{kind.label}</span>
        </span>
        <span className="mt-0.5 block truncate text-muted-foreground text-xs">
          {session.outcome}
        </span>
        {/* Collapsed scan carries only actor + duration + cost; turn/tool
            counts are detail, surfaced in the expanded panel instead. */}
        <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground text-xs tabular-nums">
          <span className="text-foreground">{session.actor}</span>
          <span aria-hidden>·</span>
          <span>{session.durationLabel}</span>
          <span aria-hidden>·</span>
          <span className="text-foreground">{session.costLabel}</span>
        </span>
      </span>
      {/* Status lives in a fixed right column, a sibling of the flex-1 content
          rather than the wrapping title row, so a long title can't fling it far
          right or detach it from the row it describes. */}
      <Chip className="mt-0.5 shrink-0" size="sm" variant={status.variant}>
        {status.label}
      </Chip>
    </>
  );
}

function AssociatedSessionCard({
  session,
  defaultOpen,
}: {
  session: AssociatedSession;
  defaultOpen: boolean;
}) {
  const hasTranscript = session.transcript.length > 0;
  const [open, setOpen] = useState(defaultOpen && hasTranscript);
  const panelId = `session-panel-${session.id}`;
  const rowClasses = "flex w-full items-start gap-3 px-3 py-2.5 text-left";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {hasTranscript ? (
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className={cn(rowClasses, "transition-colors hover:bg-muted/40")}
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <SessionCardHeader
            hasTranscript={hasTranscript}
            open={open}
            session={session}
          />
        </button>
      ) : (
        // Queued session: no transcript, so this is a static row, not a
        // disclosure — nothing enters the tab order that can't be acted on.
        <div className={rowClasses}>
          <SessionCardHeader
            hasTranscript={hasTranscript}
            open={false}
            session={session}
          />
        </div>
      )}
      {/* Panel is unmounted while collapsed (not just visually clipped) so the
          nested tool / sub-agent controls leave the tab order and the a11y
          tree, matching CollapsibleBlock's shipped disclosure discipline. */}
      {open && hasTranscript ? (
        <div id={panelId}>
          <div className="border-border border-t bg-muted/20 px-3 py-2.5">
            <p className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground text-xs tabular-nums">
              <span>{session.tokensLabel}</span>
              <span aria-hidden>·</span>
              <span>{session.turnCount} turns</span>
              <span aria-hidden>·</span>
              <span>{session.toolCount} tools</span>
            </p>
            <SessionTranscript turns={session.transcript} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AssociatedSessionList({
  sessions,
}: {
  sessions: AssociatedSession[];
}) {
  // A branch with zero associated sessions is a normal state (nothing has run
  // against it yet), not an error — so it gets a real zero-state inside the
  // trace section's card frame rather than an empty gap. Compact size keeps it
  // proportional to the panel.
  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <EmptyState
          description="Sessions that run against this branch — implementation, code review, follow-up — will collapse into this trace as they start."
          icon={WaypointsIcon}
          size="compact"
          title="No sessions yet"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((session) => (
        // Open the session that flagged itself as needing a human, not the one
        // that happens to sort first — reordering the list must not silently
        // open a happy-path (or the wrong) session.
        <AssociatedSessionCard
          defaultOpen={session.defaultOpen === true}
          key={session.id}
          session={session}
        />
      ))}
    </div>
  );
}
