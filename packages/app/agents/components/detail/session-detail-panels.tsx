"use client";

import { AgentCard } from "@repo/app/agents/components/agent-card";
import { EventGroupRow } from "@repo/app/agents/components/events/event-group-row";
import type {
  EventFilterSelection,
  SessionAgent,
  SessionEventFacets,
  SessionEventGroup,
  SessionOverviewStats,
} from "@repo/app/agents/lib/session-types";
import { Chip } from "@repo/design-system/components/ui/chip";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertCircleIcon,
  BotIcon,
  HistoryIcon,
  TerminalSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * ISS-5366: the caption under a Subagents MetricCard with no count.
 *
 * Worded to match `SubagentTypesBody`'s unavailable line — both describe the
 * same missing agent rows, and two different sentences for one cause reads as
 * two different problems. No "yet": the cause can be a producer that will never
 * report them, and "yet" promises data that is on its way.
 */
const SUBAGENT_COUNT_UNAVAILABLE_DETAIL = "Not available for this session";

export type SessionSummaryMetric = {
  label: string;
  /**
   * ISS-4979 (#4291 review): nullable, and passed to `MetricCard` unchanged.
   * `MetricCard` derives its own no-data state from a nullish `value` and
   * renders the muted "No data" glyph; a builder that coerces the absence to an
   * em-dash STRING defeats that path and prints the rule character in the bold
   * 2xl value slot, which FEA-4236 exists to prevent. Absence belongs in the
   * type, not in a placeholder string. Pair with a `detail` caption that says
   * why the value is missing.
   */
  value: string | null;
  detail?: string;
  info?: { what: string; how?: string };
};

export type SessionMetadataField = {
  label: string;
  value: string;
};

export type SessionModelUsageRow = {
  model: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  estimatedCost: string;
};

export type SessionToolInvocationRow = {
  toolName: string;
  count: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SessionErrorDetailRow = {
  id: string;
  eventType: string;
  createdAt: string;
  summary: string;
  rawData?: string | null;
};

type SessionSummaryMetricsProps = {
  metrics: SessionSummaryMetric[];
};

type SessionMetadataPanelProps = {
  metadata: SessionMetadataField[];
  details?: SessionMetadataField[];
};

type SessionModelUsageTableProps = {
  rows: SessionModelUsageRow[];
};

type SessionToolInvocationsPanelProps = {
  rows: SessionToolInvocationRow[];
};

type SessionErrorDetailsPanelProps = {
  errors: SessionErrorDetailRow[];
};

type JsonPanelProps = {
  title: string;
  description?: string;
  value?: string | null;
  emptyMessage?: string;
};

type SessionAgentsSectionProps = {
  agents: SessionAgent[];
  activeAgentId?: string;
};

type SessionTimelineSectionProps = {
  facets: SessionEventFacets;
  groups: SessionEventGroup[];
  activeFilters?: EventFilterSelection;
};

type SessionOverviewSectionProps = {
  stats: SessionOverviewStats;
};

export function SessionSummaryMetrics({ metrics }: SessionSummaryMetricsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard
          detail={metric.detail}
          info={metric.info}
          key={metric.label}
          label={metric.label}
          value={metric.value}
        />
      ))}
    </div>
  );
}

/**
 * FEA-3644: a metadata value that never spills outside its column. Long,
 * unbroken values (working directories, branch names, paths) truncate with an
 * ellipsis and surface the full value on hover/focus via the shared tooltip,
 * matching the sessions table's branch/repo chip pattern.
 *
 * The tooltip is opt-in per value: only genuinely clipped text becomes a
 * focusable button with a tooltip. Short values that fit (owner, harness, ids)
 * render as a plain span so a keyboard user doesn't tab through a button on
 * every field and a screen reader doesn't announce "button" on a value that
 * repeats text already fully visible.
 */
function MetadataValue({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // Measure after layout and on resize: a value is clipped when its rendered
  // content is wider than the column track it occupies. `value` is a dependency
  // so a new string re-measures (its width, and thus whether it overflows, can
  // differ from the previous render).
  useEffect(() => {
    const element = textRef.current;
    if (!element) {
      return;
    }
    const measure = () => {
      // Reading textContent ties the measurement to the current `value`.
      const clipped = element.scrollWidth > element.clientWidth;
      setIsTruncated(clipped && element.textContent === value);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  const text = (
    <span
      className={cn(
        "block min-w-0 truncate",
        // Only clipped values are focusable, so only they carry a focus ring —
        // matches the interactive chip's focus-visible treatment.
        isTruncated &&
          "rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className
      )}
      ref={textRef}
      tabIndex={isTruncated ? 0 : undefined}
    >
      {value}
    </span>
  );

  if (!isTruncated) {
    return text;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">{value}</TooltipContent>
    </Tooltip>
  );
}

export function SessionMetadataPanel({
  metadata,
  details = [],
}: SessionMetadataPanelProps) {
  return (
    <Section
      contentClassName="space-y-3 text-sm"
      description="Identity, ownership, and source metadata for the synced session."
      title="Session metadata"
    >
      <div className="grid gap-3 md:grid-cols-2">
        {metadata.map((item) => (
          <div className="min-w-0" key={item.label}>
            <div className="text-muted-foreground">{item.label}</div>
            <MetadataValue className="font-medium" value={item.value} />
          </div>
        ))}
      </div>
      {details.length > 0 ? (
        <div className="space-y-2 border-t pt-3">
          {details.map((item) => (
            <div className="flex min-w-0 gap-1" key={item.label}>
              <span className="shrink-0 text-muted-foreground">
                {item.label}:
              </span>{" "}
              <MetadataValue value={item.value} />
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

export function SessionModelUsageTable({ rows }: SessionModelUsageTableProps) {
  return (
    <Section
      contentClassName="space-y-0"
      description="Input, output, cache, and cost totals grouped by model."
      title="Token usage by model"
    >
      {rows.length === 0 ? (
        <EmptyState
          className="py-10"
          description="No model usage rows were recorded for this session."
          icon={BotIcon}
          title="No model usage"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cache Read</TableHead>
              <TableHead className="text-right">Cache Write</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.model}>
                <TableCell className="font-medium">{row.model}</TableCell>
                <TableCell className="text-right">{row.inputTokens}</TableCell>
                <TableCell className="text-right">{row.outputTokens}</TableCell>
                <TableCell className="text-right">
                  {row.cacheReadTokens}
                </TableCell>
                <TableCell className="text-right">
                  {row.cacheWriteTokens}
                </TableCell>
                <TableCell className="text-right">
                  {row.estimatedCost}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function SessionToolInvocationsPanel({
  rows,
}: SessionToolInvocationsPanelProps) {
  return (
    <Section
      contentClassName="space-y-0"
      description="Distinct tools invoked during the session, grouped with counts and timing."
      title="Tool invocations"
    >
      {rows.length === 0 ? (
        <EmptyState
          className="py-10"
          description="No tool invocations were captured for this session."
          icon={WrenchIcon}
          title="No tool activity"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead>First Seen</TableHead>
              <TableHead>Last Seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.toolName}>
                <TableCell className="font-medium">{row.toolName}</TableCell>
                <TableCell className="text-right">{row.count}</TableCell>
                <TableCell>{row.firstSeenAt}</TableCell>
                <TableCell>{row.lastSeenAt}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function SessionErrorDetailsPanel({
  errors,
}: SessionErrorDetailsPanelProps) {
  return (
    <Section
      contentClassName="space-y-4"
      description="API and session events flagged as errors."
      title="Error details"
    >
      {errors.length === 0 ? (
        <EmptyState
          className="py-10"
          description="No error events were captured for this session."
          icon={AlertCircleIcon}
          title="No errors"
        />
      ) : (
        errors.map((event) => (
          <div className="rounded-md border bg-muted/30 p-3" key={event.id}>
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">{event.eventType}</div>
              <div className="text-muted-foreground text-xs">
                {event.createdAt}
              </div>
            </div>
            <div className="mt-2 text-sm">{event.summary}</div>
            {event.rawData ? (
              <pre className="mt-3 overflow-auto rounded-md bg-background p-2 text-xs">
                {event.rawData}
              </pre>
            ) : null}
          </div>
        ))
      )}
    </Section>
  );
}

export function SessionAgentsSection({
  agents,
  activeAgentId,
}: SessionAgentsSectionProps) {
  return (
    <Section
      contentClassName="p-0"
      description="Agent rows captured from the local desktop monitor."
      title="Agents"
    >
      {agents.length === 0 ? (
        <EmptyState
          className="py-10"
          description="No agent records were captured for this session."
          icon={WrenchIcon}
          title="No agents"
        />
      ) : (
        <div className="grid gap-3 px-6 pb-6 lg:grid-cols-2">
          {agents.map((agent) => (
            <AgentCard
              active={agent.id === activeAgentId}
              agent={agent}
              key={agent.id}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

export function SessionTimelineSection({
  facets,
  groups,
  activeFilters,
}: SessionTimelineSectionProps) {
  return (
    <Section
      contentClassName="space-y-0"
      description="Normalized event stream with shared filtering and grouped rows."
      title="Event timeline"
    >
      {groups.length === 0 ? (
        <EmptyState
          className="py-10"
          description="No events were captured for this session."
          icon={HistoryIcon}
          title="No events"
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 border-border/70 border-b px-6 pb-4 text-xs">
            <Chip variant="muted">{facets.statuses.length} statuses</Chip>
            <Chip variant="muted">{facets.eventTypes.length} event types</Chip>
            <Chip variant="muted">{facets.toolNames.length} tools</Chip>
            <Chip variant="muted">{facets.agents.length} agents</Chip>
            {activeFilters?.query ? (
              <Chip interactive variant="outline">
                Search: {activeFilters.query}
              </Chip>
            ) : null}
            {activeFilters?.statuses.map((status) => (
              <Chip key={`status-${status}`} variant="outline">
                {status}
              </Chip>
            ))}
            {activeFilters?.eventTypes.map((eventType) => (
              <Chip key={`event-${eventType}`} variant="outline">
                {eventType}
              </Chip>
            ))}
            {activeFilters?.toolNames.map((toolName) => (
              <Chip key={`tool-${toolName}`} variant="outline">
                {toolName}
              </Chip>
            ))}
          </div>
          <div className="space-y-3 px-6 pb-6">
            {groups.map((group) => (
              <EventGroupRow group={group} key={group.id} />
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

export function SessionOverviewSection({ stats }: SessionOverviewSectionProps) {
  return (
    <Section
      contentClassName="space-y-0"
      description="Shared session analytics built from events, tools, subagents, and token flow."
      title="Session overview"
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            detail={stats.eventRateHint}
            label="Events"
            value={stats.totalEvents.toLocaleString()}
          />
          <MetricCard
            label="Tool calls"
            value={stats.toolCalls.toLocaleString()}
          />
          {/* ISS-5366: a null count is UNKNOWN, not zero. Passed through
              nullish so `MetricCard` renders its own muted no-data slot, with a
              caption naming the cause — the same treatment the Duration card
              beside it already uses, and the same vocabulary the "Subagent
              types" box below uses for the identical gap. Before this, the two
              panels disagreed: a confident "0" here against "aren't available
              for this session" there. */}
          <MetricCard
            detail={
              stats.subagents === null
                ? SUBAGENT_COUNT_UNAVAILABLE_DETAIL
                : undefined
            }
            label="Subagents"
            value={
              stats.subagents === null ? null : stats.subagents.toLocaleString()
            }
          />
          <MetricCard
            label="Compactions"
            value={stats.compactions.toLocaleString()}
          />
          <MetricCard label="Errors" value={stats.errors.toLocaleString()} />
          <MetricCard
            detail={stats.durationDetail}
            label="Duration"
            value={stats.durationLabel}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-border/80 bg-muted/10 p-4">
            <h4 className="font-medium text-sm">Top tools</h4>
            <div className="mt-3 space-y-2">
              {stats.topTools.length ? (
                stats.topTools.map((tool) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/80 px-3 py-2"
                    key={tool.toolName}
                  >
                    <span className="font-mono text-sm">{tool.toolName}</span>
                    <Chip variant="muted">{tool.count}</Chip>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-sm">
                  No tool activity.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border/80 bg-muted/10 p-4">
            {/* The h4 renders in EVERY state so the section never drops out of
                the document outline when a session has no subagents. */}
            <h4 className="font-medium text-sm">Subagent types</h4>
            <SubagentTypesBody stats={stats} />
          </div>

          <div className="rounded-xl border border-border/80 bg-muted/10 p-4">
            <h4 className="font-medium text-sm">Token mix</h4>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>Input</span>
                <span className="font-mono">
                  {stats.tokens.inputTokens.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Output</span>
                <span className="font-mono">
                  {stats.tokens.outputTokens.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Cache read</span>
                <span className="font-mono">
                  {stats.tokens.cacheReadTokens.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Cache write</span>
                <span className="font-mono">
                  {stats.tokens.cacheWriteTokens.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>

        {stats.activeAgent ? (
          <div className="rounded-xl border border-border/80 bg-muted/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-medium text-sm">Active agent</h4>
              <Chip variant="outline">{stats.activeAgent.name}</Chip>
              {stats.activeAgent.currentTool ? (
                <Chip variant="muted">{stats.activeAgent.currentTool}</Chip>
              ) : null}
            </div>
            {stats.activeAgent.task ? (
              <p className="mt-3 text-muted-foreground text-sm">
                {stats.activeAgent.task}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

export function JsonPanel({
  title,
  description,
  value,
  emptyMessage = "No structured data is available.",
}: JsonPanelProps) {
  return (
    <Section
      contentClassName="space-y-0"
      description={description}
      title={title}
    >
      {value ? (
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
          {value}
        </pre>
      ) : (
        <EmptyState
          className="py-10"
          description={emptyMessage}
          icon={TerminalSquareIcon}
          title={`No ${title.toLowerCase()}`}
        />
      )}
    </Section>
  );
}

/**
 * ISS-4677: three DISTINCT states for the Overview "Subagent types" tally, so
 * the panel cannot say "No subagent activity." about data that never arrived.
 *
 *  - agent rows unavailable → say so, and offer no count;
 *  - rows arrived, no subagents → a real, knowable zero;
 *  - otherwise → the busiest-first, capped tally, which now EXCLUDES the
 *    session's own main agent and therefore reconciles with the Subagents
 *    metric above (it previously counted the root row under a "main" label,
 *    rendering "1" for a session that ran no subagents at all).
 */
function SubagentTypesBody({ stats }: { stats: SessionOverviewStats }) {
  // Optional + additive: a producer that predates the flag omits it, and the
  // pre-ISS-4677 assumption was "available". One vocabulary across all three
  // states — the heading's, "subagent types" — so the box does not call the same
  // thing three names. No "yet": the cause can be a desktop build that will
  // never report it, and "yet" promises data that is on its way.
  if (stats.subagentTypesAvailable === false) {
    return (
      <p className="mt-3 text-muted-foreground text-sm">
        Subagent types aren&apos;t available for this session.
      </p>
    );
  }
  if (stats.subagentTypes.length === 0) {
    return (
      <p className="mt-3 text-muted-foreground text-sm">
        This session ran no subagents.
      </p>
    );
  }
  const omittedTypes = stats.subagentTypesOmitted ?? 0;
  const omittedAgents = stats.subagentTypesOmittedAgentCount ?? 0;
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        {stats.subagentTypes.map((entry) => (
          <Chip
            key={entry.label}
            variant={entry.isCompaction ? "warning" : "outline"}
          >
            {entry.label} {entry.count}
          </Chip>
        ))}
      </div>
      {/* The list is a capped shortlist, so it is stated as a plain muted line
          BELOW the chips rather than as another chip: a meta-count wearing the
          same shape as the real types reads as one of them, and its number would
          be parsed in the same unit as the agent counts beside it. Both numbers
          are named, because the reader needs the agent count to reconcile the
          visible chips against the Subagents metric above. */}
      {omittedTypes > 0 ? (
        <p className="mt-2 text-muted-foreground text-xs">
          {omittedTypes} more {omittedTypes === 1 ? "type" : "types"} not shown
          ({omittedAgents} {omittedAgents === 1 ? "subagent" : "subagents"})
        </p>
      ) : null}
    </>
  );
}
