"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type { TurnItem } from "@repo/api/src/types/agent-session";
import { cn } from "@repo/design-system/lib/utils";
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { transcriptIdentityMatchesInvocationAnchor } from "../../lib/transcript-turn-items";
import { getTraceOccurrenceKey } from "./trace-occurrence-key";

type SubagentItem = Extract<TurnItem, { type: "subagent" }>;

/**
 * FEA-4172: one collapsed summary box per sub-agent invocation. The row shows
 * the invocation name (+ type), a compact duration · cost meta row, and an
 * event count; the underlying transcript stays behind the disclosure (`open`)
 * so the parent trace reads as a single line per sub-agent (Claude Code / Codex
 * style) until the user asks for detail. Extracted from session-trace.tsx to
 * shrink that grandfathered file (FEA-4172 code-review).
 *
 * The meta row carries no `tokens` part: there is no per-sub-agent token source
 * (the cost points carry only `{tMs, costUsd}`, and `SyncedAgentSessionAgent`
 * has no counts), so `item.tokens` is always null and the part is dropped. Do
 * not describe this row as showing tokens until a source exists (wongk review).
 */
export function SessionTraceSubagent({
  item,
  invocationAnchor,
}: Readonly<{
  item: SubagentItem;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
}>) {
  const anchored = transcriptIdentityMatchesInvocationAnchor(
    item.transcriptIdentity,
    invocationAnchor
  );
  const [userOpen, setUserOpen] = useState(false);
  const open = anchored || userOpen;
  const metaParts = buildSubagentMetaParts(item);
  const bodyLines = buildSubagentBodyLines(item.body);
  // FEA-3416: label the collapsed block with the number of underlying
  // events/turns in this sub-agent run so it stays a single summarized block
  // instead of inflating the transcript with every turn. Count only the real
  // activity lines (tool/event) — not the synthetic task descriptor or the
  // always-appended terminal status marker the projection adds — and omit the
  // label entirely when there are none (e.g. the branch merged trace carries no
  // body) rather than render a misleading "(0 events)".
  const eventCount = countSubagentEvents(item.body);
  const label = buildSubagentLabel(item);
  // FEA-4178 (wongk review): a body-less sub-agent row — e.g. every row on the
  // branch merged trace, whose lean `MergedTraceItem` carries no transcript —
  // has nothing behind the disclosure. Rendering it as a chevron button would
  // put an affordance on a row that only opens to "No transcript captured.",
  // promising detail it doesn't have. Only expand when there is a body to show;
  // otherwise render the head static (no chevron, no button), mirroring the
  // non-expandable `.st-tools-head-static` tools summary.
  const expandable = item.body.length > 0;
  const summaryContent = (
    <>
      <BotIcon aria-hidden className="st-sub-icon size-3.5" />
      {/* The BotIcon is the only visual "this is a sub-agent" cue but it is
          aria-hidden, so without this the row announces just the invocation
          name ("Review lane (review)"). An sr-only prefix restores the kind
          context for assistive tech while keeping the compact one-line visual. */}
      <span className="sr-only">{SUBAGENT_FALLBACK_LABEL} </span>
      <span className="st-sub-sum">{label}</span>
      {eventCount > 0 ? (
        <span className="st-sub-count">{formatEventCount(eventCount)}</span>
      ) : null}
      {metaParts.length > 0 ? (
        <span className="st-sub-meta mono">
          {metaParts.map((part, index) => (
            <Fragment key={part.kind}>
              {index > 0 ? (
                <span className="st-sub-meta-sep">
                  {SUBAGENT_META_SEPARATOR}
                </span>
              ) : null}
              <span
                className={cn(
                  "st-sub-meta-part",
                  part.kind === "cost" && "cost"
                )}
                // FEA-4178 (wongk review): the sub-agent cost is attributed by
                // timestamp overlap, not metered per-agent, so a bare "$0.20"
                // reads as a measured figure it isn't. Name what it is on hover
                // — mirroring the gutter cost's `Cumulative: $X` title — so the
                // number does not overpromise precision.
                title={part.kind === "cost" ? SUBAGENT_COST_TITLE : undefined}
              >
                {part.text}
              </span>
            </Fragment>
          ))}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className="st-sub"
      data-invocation-anchor-target={anchored ? "true" : undefined}
    >
      {expandable ? (
        <button
          aria-expanded={open}
          className="st-sub-head"
          onClick={() => setUserOpen((value) => !value)}
          type="button"
        >
          {summaryContent}
          {open ? (
            <ChevronDownIcon aria-hidden className="st-sub-chev size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="st-sub-chev size-3.5" />
          )}
        </button>
      ) : (
        <div className="st-sub-head st-sub-head-static">{summaryContent}</div>
      )}
      {expandable && open ? (
        <div className="st-sub-body">
          {/* Model is kept out of the collapsed one-line summary to stay
              scannable, but preserved here behind the disclosure so the datum
              is not lost — duration and cost already ride the header. */}
          {item.model ? (
            <div className="st-sub-info mono">{item.model}</div>
          ) : null}
          {bodyLines.map(({ key, line }) => (
            <SubagentBodyLine key={key} line={line} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SubagentBodyLine({
  line,
}: Readonly<{
  line: SubagentItem["body"][number];
}>) {
  const className = `st-sub-ln k-${getSubagentLineKindClassName(line.kind)}`;
  return (
    <div className={cn(className, line.err && "text-destructive")}>
      {line.kind === "tool" ? (
        <span className="st-sub-ln-t mono">{line.text}</span>
      ) : (
        <span className="st-sub-ln-x">{line.text}</span>
      )}
    </div>
  );
}

function getSubagentLineKindClassName(kind: string): string {
  if (kind === "task") {
    return "task";
  }
  if (kind === "tool") {
    return "tool";
  }
  if (kind === "status") {
    return "status";
  }
  return "say";
}

/**
 * Number of real activity turns in a sub-agent run — the tool/event body lines
 * — excluding the synthetic task descriptor, the synthetic `currentTool` line,
 * and the terminal status marker the projection frames the run with
 * (`buildSubagentBody`). Drives the collapsed block's "(N events)" count
 * (FEA-3416).
 *
 * Real event lines always carry a timestamp (`t: event.createdAt`); the
 * synthetic `currentTool` line the projection prepends has no `t`, so it would
 * otherwise inflate the count when it mirrors the last real tool event.
 */
function countSubagentEvents(body: SubagentItem["body"]): number {
  let count = 0;
  for (const line of body) {
    if ((line.kind === "tool" || line.kind === "event") && line.t) {
      count += 1;
    }
  }
  return count;
}

/** "(N event)" / "(N events)", grouped like the session-level trace count. */
function formatEventCount(count: number): string {
  return `(${count.toLocaleString()} ${count === 1 ? "event" : "events"})`;
}

/**
 * FEA-4172: the collapsed sub-agent summary label — the invocation name plus
 * its declared type when they differ (e.g. "reviewer" / "code-reviewer"). The
 * generic role prefix lives in a leading icon (plus an sr-only prefix for
 * assistive tech), not the visible text, so the box reads as one clean line
 * rather than a "Subagent | …" pill.
 */
function buildSubagentLabel(item: SubagentItem): string {
  const name = item.sub || SUBAGENT_FALLBACK_LABEL;
  if (item.subagentType && item.subagentType !== item.sub) {
    return `${name} (${item.subagentType})`;
  }
  return name;
}

/**
 * FEA-4172: the compact meta row on the collapsed box — duration, tokens, and
 * cost only. Model is intentionally omitted from the one-line summary to keep
 * it scannable; it stays available in the expanded transcript. Absent values
 * are dropped so the separator never renders a dangling divider.
 *
 * Returns typed parts (not a joined string) so the render can class the `cost`
 * part on its own: cost is the one datum in this trace we lift to full
 * `--foreground` contrast (the session-level gutter cost does the same via
 * `.st-gut-line.cost`), so the sub-agent cost must not sit flat-muted next to
 * it (wongk review).
 */
function buildSubagentMetaParts(item: SubagentItem): SubagentMetaPart[] {
  const parts: SubagentMetaPart[] = [];
  if (item.duration) {
    parts.push({ kind: "duration", text: item.duration });
  }
  if (item.tokens) {
    parts.push({ kind: "tokens", text: item.tokens });
  }
  if (item.cost) {
    parts.push({ kind: "cost", text: item.cost });
  }
  return parts;
}

function buildSubagentBodyLines(
  body: SubagentItem["body"]
): SubagentBodyLineRow[] {
  const keyCounts = new Map<string, number>();
  return body.map((line) => {
    const baseKey = `${line.kind}-${line.t ?? "no-time"}-${line.text}`;
    return {
      key: getTraceOccurrenceKey(baseKey, keyCounts),
      line,
    };
  });
}

type SubagentBodyLineRow = {
  key: string;
  line: SubagentItem["body"][number];
};

/** FEA-4178: one part of the collapsed sub-agent box's meta row. `kind` lets the
 *  render class the `cost` part on its own so it can take full `--foreground`
 *  contrast, matching the session-level gutter cost. */
type SubagentMetaPart = {
  kind: "duration" | "tokens" | "cost";
  text: string;
};

/** FEA-4172: separator between the collapsed sub-agent box's meta parts. */
const SUBAGENT_META_SEPARATOR = " · ";
/** Fallback when a sub-agent invocation carries no resolved name. */
const SUBAGENT_FALLBACK_LABEL = "Sub-agent";
/**
 * FEA-4178 (wongk review): hover/title copy for the collapsed box's cost part.
 * The figure is attributed by timestamp overlap with the main-agent turns, not
 * metered per sub-agent, so a bare dollar amount can overstate precision. This
 * names the attribution so the number reads honestly.
 */
const SUBAGENT_COST_TITLE = "Cost attributed to this sub-agent";
