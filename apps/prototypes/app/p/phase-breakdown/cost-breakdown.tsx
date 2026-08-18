"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  type CostPhase,
  costPhases,
  headlineCostLabel,
  PHASE_COPY,
  type PhaseSession,
  SESSION_STATUS_META,
  SessionStatus,
} from "./mock";
import { SectionHead } from "./section-head";

// Preview this many sessions before the "View all" affordance; expanding shows
// the whole list (and a "Show fewer" toggle to collapse it again).
const SESSION_PREVIEW_CAP = 5;

export type CostBreakdownProps = {
  openPhases: readonly string[];
  onTogglePhase: (key: string) => void;
  shownAllPhases: readonly string[];
  onToggleShowAll: (key: string) => void;
  onSelectSession: (id: string) => void;
  focusSessionId: string | null;
  onFocusHandled: () => void;
};

// Fixed-width slot so a row with an Active/Failed chip does not push the
// duration column left while Completed rows sit flush right.
function StatusSlot({ status }: { status: SessionStatus }) {
  return (
    <div className="flex w-16 shrink-0 justify-end">
      {status === SessionStatus.Completed ? null : (
        <Chip size="sm" variant={SESSION_STATUS_META[status].variant}>
          {SESSION_STATUS_META[status].label}
        </Chip>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onSelect,
  shouldFocus,
  onFocusHandled,
}: {
  session: PhaseSession;
  onSelect: (id: string) => void;
  shouldFocus: boolean;
  onFocusHandled: () => void;
}) {
  const linkRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (shouldFocus) {
      linkRef.current?.focus();
      onFocusHandled();
    }
  }, [shouldFocus, onFocusHandled]);

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <button
          className="block max-w-full truncate text-left font-medium text-primary text-sm hover:underline"
          onClick={() => onSelect(session.id)}
          ref={linkRef}
          type="button"
        >
          {session.title}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
          <span className="font-mono">{session.id}</span>
          <span aria-hidden>·</span>
          <span>{session.owner}</span>
          <span aria-hidden>·</span>
          <span>{session.model}</span>
        </div>
      </div>
      <div className="shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums">
        <div>{session.durationLabel}</div>
        <div className="mt-0.5">{session.startedLabel}</div>
      </div>
      <StatusSlot status={session.status} />
    </div>
  );
}

function phaseStatLabel(phase: CostPhase): string {
  const base = `${phase.costLabel} · ${phase.pct}%`;
  if (phase.elapsedLabel) {
    return `${base} · ${phase.totalLabel} total · ${phase.elapsedLabel} elapsed`;
  }
  return `${base} · ${phase.totalLabel} total`;
}

function phaseStatTooltip(phase: CostPhase): string {
  const total = `${phase.totalLabel} total is the summed wall-clock across all ${phase.sessions.length} sessions in this phase.`;
  if (phase.elapsedLabel) {
    return `${total} ${phase.elapsedLabel} elapsed is how long the phase spanned on the lead-time line.`;
  }
  return total;
}

function PhaseStatLine({ phase }: { phase: CostPhase }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-auto cursor-default font-mono text-muted-foreground text-xs tabular-nums">
          {phaseStatLabel(phase)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {phaseStatTooltip(phase)}
      </TooltipContent>
    </Tooltip>
  );
}

function PhaseDisclosureButton({
  phase,
  open,
  onToggle,
  panelId,
}: {
  phase: CostPhase;
  open: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  const expandable = phase.sessions.length > 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-controls={expandable ? panelId : undefined}
          aria-expanded={expandable ? open : undefined}
          className="-ml-1 flex items-center gap-2 rounded px-1 py-0.5 enabled:hover:bg-muted/50 disabled:cursor-default"
          disabled={!expandable}
          onClick={onToggle}
          type="button"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
              !expandable && "opacity-30"
            )}
          />
          <span
            className="size-2.5 rounded-[3px]"
            style={{ background: phase.color }}
          />
          <span>{phase.label}</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            ({phase.sessions.length})
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {PHASE_COPY[phase.key]}
      </TooltipContent>
    </Tooltip>
  );
}

function PhaseSessionList({
  phase,
  panelId,
  showAll,
  onToggleShowAll,
  onSelectSession,
  focusSessionId,
  onFocusHandled,
}: {
  phase: CostPhase;
  panelId: string;
  showAll: boolean;
  onToggleShowAll: () => void;
  onSelectSession: (id: string) => void;
  focusSessionId: string | null;
  onFocusHandled: () => void;
}) {
  const hasMore = phase.sessions.length > SESSION_PREVIEW_CAP;
  const visible = showAll
    ? phase.sessions
    : phase.sessions.slice(0, SESSION_PREVIEW_CAP);
  return (
    <div
      className="mt-1.5 ml-6 flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border bg-muted/20"
      id={panelId}
    >
      {visible.map((session) => (
        <SessionRow
          key={session.id}
          onFocusHandled={onFocusHandled}
          onSelect={onSelectSession}
          session={session}
          shouldFocus={session.id === focusSessionId}
        />
      ))}
      {hasMore ? (
        <button
          className="px-3 py-2 text-left font-medium text-muted-foreground text-xs hover:bg-muted/40 hover:text-foreground"
          onClick={onToggleShowAll}
          type="button"
        >
          {showAll
            ? "Show fewer sessions"
            : `View all ${phase.sessions.length} sessions`}
        </button>
      ) : null}
    </div>
  );
}

function PhaseLegendRow({
  phase,
  open,
  onToggle,
  showAll,
  onToggleShowAll,
  onSelectSession,
  focusSessionId,
  onFocusHandled,
}: {
  phase: CostPhase;
  open: boolean;
  onToggle: () => void;
  showAll: boolean;
  onToggleShowAll: () => void;
  onSelectSession: (id: string) => void;
  focusSessionId: string | null;
  onFocusHandled: () => void;
}) {
  const panelId = `phase-sessions-${phase.key}`;
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <PhaseDisclosureButton
          onToggle={onToggle}
          open={open}
          panelId={panelId}
          phase={phase}
        />
        <PhaseStatLine phase={phase} />
      </div>
      {open && phase.sessions.length > 0 ? (
        <PhaseSessionList
          focusSessionId={focusSessionId}
          onFocusHandled={onFocusHandled}
          onSelectSession={onSelectSession}
          onToggleShowAll={onToggleShowAll}
          panelId={panelId}
          phase={phase}
          showAll={showAll}
        />
      ) : null}
    </div>
  );
}

export function CostBreakdown({
  openPhases,
  onTogglePhase,
  shownAllPhases,
  onToggleShowAll,
  onSelectSession,
  focusSessionId,
  onFocusHandled,
}: CostBreakdownProps) {
  return (
    <section>
      <SectionHead count={headlineCostLabel} title="Cost breakdown" />
      {/* The rows below repeat every value, so the bar is decorative. */}
      <div aria-hidden className="flex h-2 w-full overflow-hidden rounded-full">
        {costPhases.map((phase) => (
          <span
            className="block h-full"
            key={phase.key}
            style={{ width: `${phase.pct}%`, background: phase.color }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-col gap-2">
        {costPhases.map((phase) => (
          <PhaseLegendRow
            focusSessionId={focusSessionId}
            key={phase.key}
            onFocusHandled={onFocusHandled}
            onSelectSession={onSelectSession}
            onToggle={() => onTogglePhase(phase.key)}
            onToggleShowAll={() => onToggleShowAll(phase.key)}
            open={openPhases.includes(phase.key)}
            phase={phase}
            showAll={shownAllPhases.includes(phase.key)}
          />
        ))}
      </div>
    </section>
  );
}
