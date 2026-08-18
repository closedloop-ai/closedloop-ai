"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  BotIcon,
  FingerprintIcon,
  FolderGit2Icon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  TicketIcon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { SessionComment, SessionDetail } from "../mock-detail";
import { PropertiesPanel, type PropertyRow } from "./properties-panel";
import { SessionStatusChip } from "./session-cells";
import { SessionCommentsPanel } from "./session-comments-panel";
import { SessionTimeline } from "./session-timeline";
import { SessionTrace } from "./session-trace";

export function SessionDetailView({
  detail,
  commentsCollapsed = false,
}: {
  detail: SessionDetail;
  commentsCollapsed?: boolean;
}) {
  const [activeTraceRow, setActiveTraceRow] = useState(0);
  const [activeMinutes, setActiveMinutes] = useState(0);
  const [comments, setComments] = useState<SessionComment[]>(detail.comments);
  const programmaticScrollUntil = useRef(0);
  const setActiveTracePosition = useCallback(
    (row: number, atMinutes?: number, scroll = true) => {
      setActiveTraceRow(row);
      const turn = detail.trace.find(
        (candidate, index) => (candidate.row ?? index) === row
      );
      const [hours, minutes] = turn?.timeLabel.split(":") ?? ["0", "0"];
      setActiveMinutes(atMinutes ?? Number(hours) * 60 + Number(minutes));
      if (!scroll) {
        return;
      }
      programmaticScrollUntil.current = Date.now() + 1000;
      const target = document.getElementById(`session-trace-row-${row}`);
      const scroller = target?.closest<HTMLElement>(
        "[data-session-detail-scroll]"
      );
      if (!(target && scroller)) {
        return;
      }
      const sticky = scroller.querySelector<HTMLElement>(
        "[data-session-timeline-sticky]"
      );
      scroller.scrollTo({
        behavior: "smooth",
        top:
          scroller.scrollTop +
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          (sticky?.offsetHeight ?? 0) -
          8,
      });
    },
    [detail.trace]
  );
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-auto" data-session-detail-scroll>
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-6 px-5 pt-8 pb-6">
          {/* The breadcrumb already says Sessions, so the title leads with the
              session name plus its status. */}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-semibold text-2xl tracking-tight">
              {detail.name}
            </h1>
            {/* Same chip as the table row, so the status (and its Active pulse)
                reads identically in both places. */}
            <SessionStatusChip status={detail.status} />
          </div>

          <SessionProperties detail={detail} />
        </div>

        {/* The Session Timeline pins to the top of the scroll area while the
            properties above and the trace below scroll under it; the full-width
            bottom border matches production. */}
        <div
          className="sticky top-0 z-10 border-b bg-background"
          data-session-timeline-sticky
        >
          <div className="mx-auto w-full max-w-[1000px] px-5 py-4">
            <SessionTimeline
              activeMinutes={activeMinutes}
              detail={detail}
              key={detail.id}
              onJump={setActiveTracePosition}
            />
          </div>
        </div>

        <div className="mx-auto w-full max-w-[1000px] px-5 pt-6 pb-10">
          <SessionTrace
            activeTraceRow={activeTraceRow}
            detail={detail}
            onActiveTraceRowChange={(row) =>
              Date.now() >= programmaticScrollUntil.current
                ? setActiveTracePosition(row, undefined, false)
                : undefined
            }
          />
        </div>
      </div>

      {commentsCollapsed ? null : (
        <SessionCommentsPanel
          activeTraceRow={activeTraceRow}
          comments={comments}
          onCommentsChange={setComments}
          onSelectAnchor={setActiveTracePosition}
        />
      )}
    </div>
  );
}

function SessionProperties({ detail }: { detail: SessionDetail }) {
  const rows: PropertyRow[] = [
    {
      label: "Owner",
      value: <span>{detail.ownerName}</span>,
    },
    {
      label: "Model",
      value: <span className="truncate">{detail.model}</span>,
    },
    {
      label: "Autonomy",
      value:
        detail.autonomy == null ? (
          <span className="text-muted-foreground">Not scored</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <GaugeIcon aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="tabular-nums">{detail.autonomy}</span>
          </span>
        ),
    },
    {
      label: "Repository",
      value:
        detail.repo == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <FolderGit2Icon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-mono">{detail.repo}</span>
          </span>
        ),
    },
    {
      label: "Branch",
      value:
        detail.branch == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitBranchIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-mono">{detail.branch}</span>
          </span>
        ),
    },
    {
      label: "Pull request",
      value:
        detail.prNumber == null ? (
          <span className="text-muted-foreground">No PR yet</span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitPullRequestIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="font-mono">#{detail.prNumber}</span>
            {detail.prStateLabel ? (
              <span className="text-muted-foreground text-xs">
                {detail.prStateLabel}
              </span>
            ) : null}
          </span>
        ),
    },
    {
      label: "Duration",
      value: <span className="tabular-nums">{detail.durationLabel}</span>,
    },
    {
      label: "Cost",
      value: <span className="tabular-nums">{detail.costLabel}</span>,
    },
    {
      label: "Started",
      value: <span>{detail.startedLabel}</span>,
    },
    {
      label: "Working dir",
      value: <span className="truncate font-mono">{detail.workingDir}</span>,
    },
    {
      label: "Session ID",
      value: (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <FingerprintIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-mono text-xs">
            {detail.externalSessionId}
          </span>
        </span>
      ),
    },
    {
      label: "Linked artifacts",
      value: (
        <span className="flex flex-wrap items-center gap-1.5">
          {detail.linkedArtifacts.map((artifact) => (
            <Chip
              className="gap-1"
              key={artifact.slug}
              title={`${artifact.kind}: ${artifact.name}`}
              variant="outline"
            >
              <TicketIcon aria-hidden className="size-3 shrink-0" />
              <span className="font-mono">{artifact.slug}</span>
            </Chip>
          ))}
        </span>
      ),
    },
  ];

  const summary = (
    <>
      <span
        className="inline-flex min-w-0 items-center gap-1.5"
        title={detail.model}
      >
        <BotIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{detail.model}</span>
      </span>
      {detail.repo ? (
        <span
          className="inline-flex min-w-0 items-center gap-1.5 font-mono"
          title={detail.repo}
        >
          <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{detail.repo}</span>
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <GitPullRequestIcon aria-hidden className="size-3.5" />
        {detail.prNumber ? "1 PR" : "No PRs"}
      </span>
    </>
  );

  return <PropertiesPanel rows={rows} summary={summary} />;
}
