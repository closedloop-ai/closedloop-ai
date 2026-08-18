"use client";

import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { formatDuration } from "@repo/app/shared/lib/format-utils";
import { useMemo, useState } from "react";
import { getPhaseDisplay } from "../../lib/session-activity-phases";
import {
  getTooltipAnchor,
  type TooltipAnchor,
  useViewportTooltipStyle,
  ViewportTooltipPortal,
} from "../detail/viewport-tooltip";
import type { ActivitySegmentKind } from "./activity-segment-kind";
import {
  ActivitySegmentsState,
  type ProjectedActivitySegment,
  projectActivitySegments,
} from "./activity-segments-projection";
import { ActivitySegmentsShell } from "./session-activity-segments-shell";

/**
 * FEA-3705: renders the raw activity-segment tiling (`activitySegmentRows`,
 * FEA-3568) as a bounded, positioned phase strip in the session-detail activity
 * header. Shared verbatim by both the web app and the desktop renderer through
 * `@repo/app`, so the two surfaces stay in lockstep. Rendering is driven by the
 * pure {@link projectActivitySegments} projection (all state handling lives
 * there); this component only paints its output and exposes accessible names.
 *
 * Bounded for long sessions: at most {@link MAX_RENDERED_SEGMENTS} spans are
 * placed as absolutely-positioned slices on a single fixed-height track (no
 * nested scroll region, so the parent trace scroll is never captured or reset).
 * When more spans exist, the widest {@link MAX_RENDERED_SEGMENTS} are shown and
 * an honest "showing N of M" note is surfaced.
 */

/**
 * DOM-node ceiling for the strip. The synced tiling is already capped at
 * `MAX_SYNCED_ACTIVITY_SEGMENTS` (500) on the wire, but a strip that wide is
 * both illegible and needlessly heavy to lay out; we render the widest slices
 * (the spans a reader can actually see and click) and note the remainder.
 */
const MAX_RENDERED_SEGMENTS = 200;

export type SessionActivitySegmentsProps = {
  /** The verbatim `activitySegmentRows` DTO field for the session. */
  rows: readonly SyncedActivitySegmentRow[] | null | undefined;
  /**
   * The verbatim `activitySegmentRowsTruncated` DTO signal (FEA-3779): the
   * upstream tiling was cut on the serialized-byte budget, so `rows` is a
   * start-ordered prefix, not the whole tiling. Optional/additive — omitted or
   * null means complete. When truncated, the strip must not fold or claim
   * "mostly idle": an early-idle prefix could have had its real work dropped.
   */
  rowsTruncated?: boolean | null;
};

/** The segment currently under the pointer plus its anchor rect, for the tooltip. */
type HoverSegment = {
  anchor: TooltipAnchor;
  segment: ProjectedActivitySegment;
};

export function SessionActivitySegments({
  rows,
  rowsTruncated,
}: Readonly<SessionActivitySegmentsProps>) {
  const projection = useMemo(
    () => projectActivitySegments(rows, { rowsTruncated }),
    [rows, rowsTruncated]
  );
  const [hover, setHover] = useState<HoverSegment | null>(null);

  const rendered = useMemo(() => {
    if (projection.segments.length <= MAX_RENDERED_SEGMENTS) {
      return projection.segments;
    }
    // Keep the widest (most legible/clickable) spans, then restore chronological
    // order so the strip still reads left-to-right in time.
    return [...projection.segments]
      .sort((a, b) => b.widthPercent - a.widthPercent)
      .slice(0, MAX_RENDERED_SEGMENTS)
      .sort((a, b) => a.startMs - b.startMs);
  }, [projection.segments]);

  // Segments we dropped for legibility still happened, so the track can't be
  // left bare where they sat — a hole reads as idle and the strip would lie.
  // Collapse each contiguous run of dropped spans into one honest "hidden"
  // fill positioned over exactly the range it covers (bounded node count).
  const hiddenFills = useMemo(
    () => buildHiddenFills(projection.segments, rendered),
    [projection.segments, rendered]
  );

  // Which kinds are actually on the strip, so the legend keys only the meaning
  // this session encodes (never a swatch for a state that isn't present).
  const presentKinds = useMemo(
    () => collectPresentKinds(rendered, hiddenFills.length > 0),
    [rendered, hiddenFills]
  );

  // Honest empty/unavailable states render nothing — an older/pre-backfill
  // session shows no Activity Segments block at all, the way an empty Comments
  // list has no header, rather than a permanent "nothing here" panel.
  if (projection.state !== ActivitySegmentsState.Ready) {
    return null;
  }

  const hiddenCount = projection.segments.length - rendered.length;

  // The count lives in the header (right slot), matching the Session Trace
  // header; the note below only carries the honest truncation/malformed
  // qualifiers so we never imply the tiling is complete.
  const countLabel =
    hiddenCount > 0
      ? `${rendered.length} of ${projection.segments.length}`
      : `${rendered.length} phase${rendered.length === 1 ? "" : "s"}`;

  // FEA-4238: the honest caveats that must survive a fold, on the always-visible
  // summary (never the disclosure body, which the fold would hide exactly when
  // the caveat is needed). The idle share leads: a strip that runs on wall-clock
  // time and is mostly hatch reads broken, so ANY majority-idle session states
  // "N% idle" in one line of type — decoupled from the hard 5% fold edge, so a
  // 94%-hatch session that stays inline (just above the fold threshold) still
  // explains itself rather than looking the same kind of broken the fold
  // prevents. The truncation/malformed notes follow.
  const summaryNotes: string[] = [];
  // Only a COMPLETE tiling can state its idle share: over a truncated prefix the
  // "N% idle" figure is of a partial window (the dropped tail may hold the work),
  // so it would mislead. A truncated strip leads with the honest truncation note.
  if (!projection.truncated && projection.idleDurationShare > 0.5) {
    summaryNotes.push(
      `${Math.round(projection.idleDurationShare * 100)}% idle`
    );
  }
  if (projection.truncated) {
    summaryNotes.push("later phases truncated");
  }
  if (projection.malformedCount > 0) {
    // ISS-4790 review: "malformed dropped" is our word for it, not the reader's.
    // Say what actually happened to them in their language.
    const phaseWord = projection.malformedCount === 1 ? "phase" : "phases";
    summaryNotes.push(
      `${projection.malformedCount} ${phaseWord} couldn't be read`
    );
  }

  // One honest scale caption. The strip runs on the segment window's own min/max,
  // NOT the session-duration scale the cost bars above use, so it states that
  // independent scale and its total span in a single label — "phases span <dur>".
  // Paired with the strip's inset (`.sd3-segs-body`), that stops a reader from
  // lining a segment up under the bar directly above it and trusting a shared
  // axis. (Round 4: dropped the redundant 0:00 + right-tick pair that printed the
  // same duration a second and third time — one duration indicator, not three.)
  const spanLabel =
    projection.spanStartMs != null && projection.spanEndMs != null
      ? `phases span ${formatDuration(
          new Date(projection.spanStartMs),
          new Date(projection.spanEndMs)
        )}`
      : null;

  // Hover is delegated from the track container (the accepted "container carries
  // the hover, tiles are presentational" pattern, matching the branch timeline):
  // a passive-key slice must NOT be a button, so the tiles carry no handlers and
  // the <ul> resolves which segment the pointer is over from its data-index.
  const handleTrackHover = (event: PointerLikeEvent) => {
    const tile = closestSegmentTile(event.target);
    const index = tile?.dataset.segIndex;
    if (tile && index != null) {
      const segment = rendered[Number(index)];
      if (segment) {
        setHover({ anchor: getTooltipAnchor(tile), segment });
        return;
      }
    }
    setHover(null);
  };

  // FEA-4238: the strip is ALWAYS a disclosure (a stable, foldable "Activity
  // phases" header on every session), but it defaults COLLAPSED for a mostly-idle
  // session — a long wall-clock span the agent slept through (e.g. a 66h run)
  // whose strip is ~98% empty hatch and reads broken front-loaded above the
  // trace. A session with a real working stretch defaults OPEN. Either way the
  // reader can fold or unfold, and the honest "N% idle" caveat rides the
  // always-visible summary so a folded strip states why without being expanded.
  const defaultOpen = !projection.idleDominant;

  const body = (
    <>
      {/*
       * The strip is INSET from the full-width cost bars above (`.sd3-segs-body`)
       * because it runs on the segment window's own min/max, not the
       * session-duration scale the bars use. The inset (a single subtle left rule
       * + offset) means the two strips visibly don't share a left edge, so a
       * reader can't line a phase up under the bar over it and read a vertical
       * correspondence the data doesn't back. The lone scale caption below states
       * the window's own span. (Round 4: the inset carries the separation; the
       * extra top rule + three-part axis were redundant scaffolding, removed.)
       */}
      <div className="sd3-segs-body">
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: passive key — the track only surfaces a read-only hover tooltip; the slices are presentational and promise no action. */}
        {/* biome-ignore lint/a11y/useKeyWithMouseEvents: mouse-only inspect enhancement over already-accessible content — every slice carries an aria-label and the legend keys each kind, so a keyboard/SR reader decodes the strip without this hover popover (mirrors the branch timeline's dot-rail). */}
        <ul
          aria-label="Activity phases timeline"
          className="sd3-segs-track"
          onMouseLeave={() => setHover(null)}
          onMouseOver={handleTrackHover}
        >
          {hiddenFills.map((fill) => (
            <li
              aria-hidden="true"
              className="sd3-seg"
              data-kind="hidden"
              key={fill.key}
              style={{
                left: `${fill.leftPercent}%`,
                width: `${fill.widthPercent}%`,
              }}
            />
          ))}
          {rendered.map((segment, index) => (
            <ActivitySegmentBar
              index={index}
              key={segment.key}
              segment={segment}
            />
          ))}
        </ul>
        {spanLabel ? (
          <p aria-hidden="true" className="sd3-segs-scale">
            {spanLabel}
          </p>
        ) : null}
      </div>
      {hover ? (
        <ActivitySegmentTooltip anchor={hover.anchor} segment={hover.segment} />
      ) : null}
    </>
  );

  return (
    <ActivitySegmentsShell
      count={countLabel}
      defaultOpen={defaultOpen}
      legend={<ActivitySegmentsLegend kinds={presentKinds} />}
      summaryNotes={summaryNotes}
      truncated={projection.truncated}
    >
      {body}
    </ActivitySegmentsShell>
  );
}

/** Minimal shape of the mouse-over event we read (target only). */
type PointerLikeEvent = { target: EventTarget | null };

/** Walk from the event target up to the nearest labeled segment tile, if any. */
function closestSegmentTile(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof globalThis.HTMLElement)) {
    return null;
  }
  const tile = target.closest<HTMLElement>(".sd3-seg[data-seg-index]");
  return tile;
}

/**
 * Kinds a legend key is worth showing for. `active` is the default read of the
 * strip, so it only gets a swatch when a non-active kind is also present and
 * the reader needs to tell them apart.
 */
type LegendKind = ActivitySegmentKind | "hidden";

/**
 * ISS-4790: the two entries that name a TAXONOMY BUCKET read from the canonical
 * `ACTIVITY_PHASE_LABEL`, so the legend cannot spell a bucket differently from
 * the tooltip beside it or the breakdown below it. `active` and `hidden` stay
 * literals because they name a strip KIND (a fill encoding), not a phase bucket
 * — there is no taxonomy phase called "active". The chart-annotation lowercase
 * is CSS (`.sd3-segs-lg-name`, `text-transform: lowercase`), not a second
 * spelling of the words.
 */
const LEGEND_LABELS: Record<LegendKind, string> = {
  active: "Active",
  idle: ACTIVITY_PHASE_LABEL.idle,
  unavailable: ACTIVITY_PHASE_LABEL.other,
  hidden: "Hidden",
};

/**
 * Inline key next to the count, the way a chart labels its own series. The
 * strip encodes the span's KIND in fill (solid = active, hatch = idle, flat =
 * a catch-all span with no supporting evidence, faint = hidden by truncation);
 * without a key that meaning only lives on hover, so a mouse-free or
 * screen-reader-free reader can't decode the colors. Only keys the kinds
 * actually on this strip.
 */
function ActivitySegmentsLegend({
  kinds,
}: Readonly<{ kinds: readonly LegendKind[] }>) {
  if (kinds.length === 0) {
    return null;
  }
  // The legend is a visual key. Each segment already announces its own kind in
  // its aria-label, so the legend is aria-hidden to keep the screen-reader tree
  // free of a redundant color glossary.
  return (
    <ul aria-hidden="true" className="sd3-segs-legend">
      {kinds.map((kind) => (
        <li className="sd3-segs-lg" key={kind}>
          <span className="sd3-segs-lg-sw" data-kind={kind} />
          <span className="sd3-segs-lg-name">{LEGEND_LABELS[kind]}</span>
        </li>
      ))}
    </ul>
  );
}

function ActivitySegmentBar({
  index,
  segment,
}: Readonly<{
  index: number;
  segment: ProjectedActivitySegment;
}>) {
  // The strip is a passive phase KEY, not a row of navigable events: unlike the
  // cost bars / event dots above (which jump to a trace row on click), a span
  // covers a time range with no single target row, so it promises no action.
  // The tile carries NO handlers (the track delegates hover) and a default
  // cursor, so it reads as a legend, not a clickable sibling of the bars.
  // `data-seg-index` lets the track resolve which segment the pointer is over;
  // `aria-label` keeps it legible without hover.
  return (
    <li
      aria-label={buildSegmentLabel(segment)}
      className="sd3-seg"
      data-kind={segment.kind}
      data-seg-index={index}
      style={{
        left: `${segment.leftPercent}%`,
        width: `${segment.widthPercent}%`,
      }}
    />
  );
}

/**
 * Hover popover for a single segment — reuses the same `.sd3-tip` sd3 popover
 * and viewport-anchored placement as the Session Timeline cost-bar tooltip
 * ({@link ViewportTooltipPortal} / {@link useViewportTooltipStyle}), so the two
 * stacked strips share ONE tooltip treatment instead of this one falling back to
 * the browser's native `title` box. Passive/read-only: it carries no
 * "click to open" affordance because the strip is a key, not a navigable row.
 */
function ActivitySegmentTooltip({
  anchor,
  segment,
}: Readonly<{ anchor: TooltipAnchor; segment: ProjectedActivitySegment }>) {
  const { placement, ref, style } = useViewportTooltipStyle(anchor);
  const confidencePercent = Math.round(segment.confidence * 100);
  return (
    <ViewportTooltipPortal>
      <div
        className="sd3-tip sd3-tip-seg"
        data-placement={placement}
        ref={ref}
        style={style}
      >
        <div className="sd3-tip-h">
          <b>{describeKind(segment.kind, segment.phase)}</b>
          <span className="mono">
            {formatDuration(new Date(segment.startMs), new Date(segment.endMs))}
          </span>
        </div>
        <div className="sd3-tip-meta">
          {confidencePercent}% confidence
          {segment.workItemRef ? ` · ${segment.workItemRef}` : ""}
          {segment.subagentId ? ` · subagent ${segment.subagentId}` : ""}
        </div>
      </div>
    </ViewportTooltipPortal>
  );
}

/**
 * Screen-reader / hover label for a single span. Deliberately verbose so the
 * strip is legible without hover: phase, duration, confidence, and a linked
 * work item when one exists. The phase word comes from {@link describeKind},
 * which resolves the span's phase key through the canonical label map, so the
 * label always agrees with the breakdown below it.
 */
function buildSegmentLabel(segment: ProjectedActivitySegment): string {
  const parts: string[] = [describeKind(segment.kind, segment.phase)];
  parts.push(
    formatDuration(new Date(segment.startMs), new Date(segment.endMs))
  );
  parts.push(`${Math.round(segment.confidence * 100)}% confidence`);
  if (segment.workItemRef) {
    parts.push(segment.workItemRef);
  }
  if (segment.subagentId) {
    parts.push(`subagent ${segment.subagentId}`);
  }
  return parts.join(" · ");
}

/**
 * The bucket word for one span, resolved from its PHASE KEY through the same
 * canonical map the breakdown below and the branch bar use — never from the
 * strip's `kind`, which is a fill encoding, not a taxonomy.
 *
 * ISS-4790: this used to answer from `kind`, so the same span could carry two
 * mutually exclusive names on one page. An evidenced `other` span classified
 * `active` fell through to the raw lowercase `phase` and read "other" while both
 * breakdowns read "Other"; an evidence-free `other` span classified
 * `unavailable` read "Unattributed" while the breakdown underneath read "Other"
 * for the same milliseconds — and `unattributed` means spend the classifier
 * NEVER SAW, which an emitted `other` row is not. Reading the phase key fixes
 * both: every non-idle span resolves through `getPhaseDisplay` — the SAME
 * resolver the breakdown beneath the strip uses — so known keys take the
 * canonical label, unknown keys titleize, and a blank key takes that resolver's
 * unnameable-key word. Delegating rather than re-deciding is the point: a blank
 * key briefly had its own catch-all branch here, which made the strip say
 * "Other" while the breakdown said "Unknown" for the same span on the same page
 * — a third spelling, reintroduced by the fix for the first two.
 *
 * The evidence-free distinction is not lost, it just lives where it belongs:
 * in the swatch/fill (`data-kind`) and the legend, not in a contradicting word.
 */
function describeKind(kind: ActivitySegmentKind, phase: string): string {
  if (kind === "idle") {
    return ACTIVITY_PHASE_LABEL.idle;
  }
  return getPhaseDisplay(phase.trim()).label;
}

type HiddenFill = {
  key: string;
  leftPercent: number;
  widthPercent: number;
};

/**
 * Compute the honest "hidden" fills for the spans truncation dropped. Each
 * contiguous run of dropped segments (in chronological order) collapses to one
 * faint slice covering exactly its range, so the track never shows a bare gap
 * where work actually happened. Bounded: at most one fill per gap between kept
 * spans, so the extra node count stays small.
 */
function buildHiddenFills(
  all: readonly ProjectedActivitySegment[],
  rendered: readonly ProjectedActivitySegment[]
): HiddenFill[] {
  if (rendered.length === all.length) {
    return [];
  }
  const keptKeys = new Set(rendered.map((segment) => segment.key));
  const fills: HiddenFill[] = [];
  let run: ProjectedActivitySegment[] = [];

  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const left = run[0].leftPercent;
    const last = run.at(-1);
    if (!last) {
      return;
    }
    const right = last.leftPercent + last.widthPercent;
    fills.push({
      key: `hidden-${run[0].key}`,
      leftPercent: left,
      widthPercent: Math.max(0, right - left),
    });
    run = [];
  };

  // `all` is already chronological (projection preserves input order).
  for (const segment of all) {
    if (keptKeys.has(segment.key)) {
      flush();
    } else {
      run.push(segment);
    }
  }
  flush();
  return fills;
}

/**
 * The kinds this strip actually paints, in a stable legend order. `active` is
 * only keyed when another kind is present too, so a plain all-active strip
 * doesn't carry a redundant one-item legend.
 */
function collectPresentKinds(
  rendered: readonly ProjectedActivitySegment[],
  hasHidden: boolean
): LegendKind[] {
  const present = new Set<LegendKind>();
  for (const segment of rendered) {
    present.add(segment.kind);
  }
  if (hasHidden) {
    present.add("hidden");
  }
  // A lone "active" legend is noise; only key active when it needs to be told
  // apart from another kind on the same strip.
  if (present.size === 1 && present.has("active")) {
    return [];
  }
  const order: LegendKind[] = ["active", "idle", "unavailable", "hidden"];
  return order.filter((kind) => present.has(kind));
}
