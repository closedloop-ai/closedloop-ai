"use client";

import type {
  LoopSummary,
  LoopSummaryEntry,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import {
  CheckCircleIcon,
  CloudIcon,
  Loader2Icon,
  MonitorIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { useContext } from "react";
import { formatRelativeTime } from "@/lib/date-utils";
import {
  deriveIsLocal,
  getCommandLabels,
  terminalLabel,
} from "@/lib/loop-display";
import { getUserDisplayName } from "@/lib/user-utils";
import type { DocumentRowItem } from "./document-row";
import { RowEditContext } from "./document-row";

// ---- Layout building blocks ----

const LOOP_CELL_BASE_CLASS =
  "flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-l px-3 py-2";
const LOOP_CELL_LINK_CLASS = `${LOOP_CELL_BASE_CLASS} hover:bg-muted/50`;

function LoopCellDash() {
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="font-medium text-muted-foreground text-xs">—</span>
    </div>
  );
}

function LoopLink({
  loopId,
  children,
}: {
  loopId: string;
  children: ReactNode;
}) {
  return (
    <Link
      className={LOOP_CELL_LINK_CLASS}
      href={`/loops/${loopId}`}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}

function LoopCellRunningContent({
  isLocal,
  label,
  labelMuted = true,
}: {
  isLocal: boolean;
  label: string;
  labelMuted?: boolean;
}) {
  const labelClass = labelMuted
    ? "truncate font-medium text-muted-foreground text-xs"
    : "truncate font-medium text-foreground text-xs";
  return (
    <>
      <Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
      {isLocal ? (
        <MonitorIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <CloudIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className={labelClass}>{label}</span>
    </>
  );
}

function LoopCellCompletedContent({ label }: { label: string }) {
  return (
    <>
      <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-green-500" />
      <span className="truncate font-medium text-foreground text-xs">
        {label}
      </span>
    </>
  );
}

function LoopCellFailedContent({ label }: { label: string }) {
  return (
    <>
      <XCircleIcon className="h-3.5 w-3.5 shrink-0 text-red-500" />
      <span className="truncate font-medium text-red-500 text-xs">{label}</span>
    </>
  );
}

// ---- Helpers ----

function tsOf(value: Date | string | null | undefined): number {
  if (!value) {
    return 0;
  }
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function activeFallbackTs(entry: LoopSummaryEntry): number {
  // PENDING / CLAIMED loops have null `startedAt`; fall back to updatedAt so
  // a freshly queued retry isn't suppressed by a previous failure.
  return tsOf(entry.startedAt) || tsOf(entry.updatedAt);
}

// ---- Default LoopCell (legacy behavior preserved) ----

function DefaultLoopCell({ item }: { item: DocumentRowItem }) {
  const { activeLoops } = useContext(RowEditContext);
  const documentId = item.data.id;

  const genStatus =
    item.kind === "artifact" ? item.data.generationStatus : undefined;
  const isFailed = genStatus?.status === "FAILURE";

  const loop = activeLoops?.find((l) => l.documentId === documentId);

  if (isFailed) {
    const failedLoopId = genStatus?.loopId;
    const content = <LoopCellFailedContent label="Loop Failed" />;
    if (failedLoopId) {
      return <LoopLink loopId={failedLoopId}>{content}</LoopLink>;
    }
    return <div className={LOOP_CELL_BASE_CLASS}>{content}</div>;
  }

  if (!loop) {
    return <LoopCellDash />;
  }

  return (
    <LoopLink loopId={loop.id}>
      <LoopCellRunningContent
        isLocal={deriveIsLocal(loop)}
        label={getUserDisplayName(loop.user)}
      />
    </LoopLink>
  );
}

// ---- Team variant ----
//
// Running state comes from activeLoops (existing scope: documentId-only, NOT
// recursive). This preserves existing Team View behavior — the running indicator
// matches the artifact you're looking at, not its children. Completed/failed
// state comes from loopSummaries (recursive scope).

function renderTeamRunning(loop: LoopWithUser) {
  return (
    <LoopLink loopId={loop.id}>
      <LoopCellRunningContent
        isLocal={deriveIsLocal(loop)}
        label={getUserDisplayName(loop.user)}
      />
    </LoopLink>
  );
}

function renderTeamCompleted(c: LoopSummaryEntry) {
  const userName = getUserDisplayName(c.user);
  const relativeTime = c.completedAt ? formatRelativeTime(c.completedAt) : null;
  const label = relativeTime ? `${userName} · ${relativeTime}` : userName;
  return (
    <LoopLink loopId={c.loopId}>
      <LoopCellCompletedContent label={label} />
    </LoopLink>
  );
}

function renderTeamFailed(f: LoopSummaryEntry) {
  return (
    <LoopLink loopId={f.loopId}>
      <LoopCellFailedContent label={terminalLabel(f.status, f.command)} />
    </LoopLink>
  );
}

function pickTeamTerminal(
  latestFailed: LoopSummaryEntry | null,
  latestCompleted: LoopSummaryEntry | null
): ReactNode | null {
  // Compare timestamps when both terminal states exist — newest wins so a
  // successful retry replaces a stale failure.
  if (latestFailed && latestCompleted) {
    const failedTs = tsOf(latestFailed.failedAt);
    const completedTs = tsOf(latestCompleted.completedAt);
    return completedTs > failedTs
      ? renderTeamCompleted(latestCompleted)
      : renderTeamFailed(latestFailed);
  }
  if (latestFailed) {
    return renderTeamFailed(latestFailed);
  }
  if (latestCompleted) {
    return renderTeamCompleted(latestCompleted);
  }
  return null;
}

function TeamLoopCell({ item }: { item: DocumentRowItem }) {
  const { activeLoops, loopSummaries } = useContext(RowEditContext);
  const documentId = item.data.id;

  const directLoop = activeLoops?.find((l) => l.documentId === documentId);
  if (directLoop) {
    return renderTeamRunning(directLoop);
  }

  const summary = loopSummaries?.[documentId];
  const terminalContent = pickTeamTerminal(
    summary?.latestFailed ?? null,
    summary?.latestCompleted ?? null
  );
  if (terminalContent) {
    return terminalContent;
  }

  const genStatus =
    item.kind === "artifact" ? item.data.generationStatus : undefined;
  if (genStatus?.status === "FAILURE") {
    const failedLoopId = genStatus.loopId;
    const content = <LoopCellFailedContent label="Loop Failed" />;
    return failedLoopId ? (
      <LoopLink loopId={failedLoopId}>{content}</LoopLink>
    ) : (
      <div className={LOOP_CELL_BASE_CLASS}>{content}</div>
    );
  }

  return <LoopCellDash />;
}

// ---- My Tasks variant ----
//
// Reads exclusively from loopSummaries. Priority logic (timestamp-aware):
// 1. failed-newer-than-active wins (surface failures aggressively while a new
//    run is still queued/pending — uses startedAt OR updatedAt as fallback so
//    a freshly queued PENDING loop isn't shadowed by a prior failure)
// 2. else active wins (forward progress shown over older terminal states)
// 3. else compare failed vs completed by timestamp — newest terminal wins
//    (a successful retry after a failure must replace the stale failed state)
// 4. else dash

function pickMyTasksEntry(summary: LoopSummary): {
  kind: "active" | "failed" | "completed";
  entry: LoopSummaryEntry;
} | null {
  const { activeLoop, latestFailed, latestCompleted } = summary;
  if (latestFailed && activeLoop) {
    const failedTs = tsOf(latestFailed.failedAt);
    const activeTs = activeFallbackTs(activeLoop);
    if (failedTs > activeTs) {
      return { kind: "failed", entry: latestFailed };
    }
  }
  if (activeLoop) {
    return { kind: "active", entry: activeLoop };
  }
  if (latestFailed && latestCompleted) {
    const failedTs = tsOf(latestFailed.failedAt);
    const completedTs = tsOf(latestCompleted.completedAt);
    return completedTs > failedTs
      ? { kind: "completed", entry: latestCompleted }
      : { kind: "failed", entry: latestFailed };
  }
  if (latestFailed) {
    return { kind: "failed", entry: latestFailed };
  }
  if (latestCompleted) {
    return { kind: "completed", entry: latestCompleted };
  }
  return null;
}

function renderMyTasksActive(entry: LoopSummaryEntry) {
  return (
    <LoopLink loopId={entry.loopId}>
      <LoopCellRunningContent
        isLocal={entry.isLocal}
        label={getCommandLabels(entry.command).progress}
        labelMuted={false}
      />
    </LoopLink>
  );
}

function renderMyTasksFailed(entry: LoopSummaryEntry) {
  return (
    <LoopLink loopId={entry.loopId}>
      <LoopCellFailedContent
        label={terminalLabel(entry.status, entry.command)}
      />
    </LoopLink>
  );
}

function renderMyTasksCompleted(entry: LoopSummaryEntry) {
  return (
    <LoopLink loopId={entry.loopId}>
      <LoopCellCompletedContent
        label={getCommandLabels(entry.command).completed}
      />
    </LoopLink>
  );
}

function MyTasksLoopCell({ item }: { item: DocumentRowItem }) {
  const { loopSummaries } = useContext(RowEditContext);
  const summary = loopSummaries?.[item.data.id];
  if (!summary) {
    return <LoopCellDash />;
  }

  const picked = pickMyTasksEntry(summary);
  if (!picked) {
    return <LoopCellDash />;
  }

  if (picked.kind === "active") {
    return renderMyTasksActive(picked.entry);
  }
  if (picked.kind === "failed") {
    return renderMyTasksFailed(picked.entry);
  }
  return renderMyTasksCompleted(picked.entry);
}

// ---- LoopCell dispatcher ----

export function LoopCell({ item }: { item: DocumentRowItem }) {
  const { loopVariant } = useContext(RowEditContext);
  if (loopVariant === "team") {
    return <TeamLoopCell item={item} />;
  }
  if (loopVariant === "my-tasks") {
    return <MyTasksLoopCell item={item} />;
  }
  return <DefaultLoopCell item={item} />;
}
