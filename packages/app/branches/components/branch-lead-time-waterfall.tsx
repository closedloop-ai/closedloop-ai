"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { leadTimeWaterfallSegments } from "../lib/branch-derivations";

/**
 * Lead-time-for-change waterfall (Epic D / D5) — restyled to the design
 * handoff's `BQLeadTime`: a staged wall-clock track from the FIRST session's
 * start (NOT branch creation) through merge, with active work as solid segments
 * and idle gaps hatched. Work/idle segments are derived from the branch's
 * lightweight `leadTime` activity summary (PLN-1148 Phase 2) — server-computed
 * from the captured event instants (real gaps ≥ 2m render as idle), so the
 * default view no longer depends on the events-heavy `mergedTrace`. v1 has no
 * per-phase signal, so work is a single Build color; phase colors appear when
 * phase capture lands. `totalMs`/`mergeUnknown`/`multiPr` come from the shared D5
 * computation (the same `totalMs` D6's lead-time card reads). Open-ended when
 * the branch hasn't merged; a multi-PR branch gets an asterisk.
 */
export type BranchLeadTimeWaterfallProps = {
  detail: BranchPageDetail;
};

const BUILD_COLOR = "#4F7DF0";

type Seg = { type: "work" | "idle"; durationMs: number };

/**
 * Build the ordered work/idle track from the branch's lightweight lead-time
 * activity summary (PLN-1148 Phase 2) — `firstActivityT` / `lastActivityT` bound
 * the track and `idleSpans` hatch the gaps. This summary is computed server-side
 * from the captured event instants, so the waterfall no longer depends on the
 * events-heavy `mergedTrace` (which is now fetched lazily for the timeline tab).
 */
function buildTrack(detail: BranchPageDetail): {
  segs: Seg[];
  totalMs: number;
  idleMs: number;
} {
  const {
    firstActivityT,
    lastActivityT,
    idleSpans: activitySpans,
  } = detail.leadTime;
  const anchor = firstActivityT ? Date.parse(firstActivityT) : Number.NaN;
  const lastStamp = lastActivityT ? Date.parse(lastActivityT) : Number.NaN;
  if (Number.isNaN(anchor) || Number.isNaN(lastStamp)) {
    return { segs: [], totalMs: 0, idleMs: 0 };
  }
  const mergedMs = detail.mergedAt ? Date.parse(detail.mergedAt) : Number.NaN;
  const end =
    !Number.isNaN(mergedMs) && mergedMs >= lastStamp ? mergedMs : lastStamp;
  const totalMs = Math.max(1, end - anchor);

  const idleSpans = activitySpans
    .map((span) => ({
      a: Date.parse(span.startT),
      b: Date.parse(span.endT),
    }))
    .filter((s) => !(Number.isNaN(s.a) || Number.isNaN(s.b)))
    .sort((a, b) => a.a - b.a);

  const segs: Seg[] = [];
  let cursor = anchor;
  let idleMs = 0;
  for (const span of idleSpans) {
    const a = Math.max(cursor, span.a);
    const b = Math.min(end, span.b);
    if (a > cursor) {
      segs.push({ type: "work", durationMs: a - cursor });
    }
    if (b > a) {
      segs.push({ type: "idle", durationMs: b - a });
      idleMs += b - a;
      cursor = b;
    }
  }
  if (end > cursor) {
    segs.push({ type: "work", durationMs: end - cursor });
  }
  return { segs, totalMs, idleMs };
}

export function BranchLeadTimeWaterfall({
  detail,
}: BranchLeadTimeWaterfallProps) {
  const { totalMs, mergeUnknown, multiPr } = leadTimeWaterfallSegments(detail);
  const track = buildTrack(detail);
  const idlePct =
    track.totalMs > 0 ? Math.round((track.idleMs / track.totalMs) * 100) : 0;

  // Keep the header consistent with the body: when the trace yields no track
  // (e.g. the merged-trace load degraded to []), don't show a computed duration
  // above the empty-state chart.
  let headCount: string;
  if (mergeUnknown) {
    headCount = "in progress";
  } else if (track.segs.length > 0) {
    headCount = `${formatDurationMs(totalMs)}${track.idleMs > 0 ? ` · ${idlePct}% idle` : ""}`;
  } else {
    headCount = "—";
  }

  return (
    <section className="bq-lead">
      <div className="bq-sec-head">
        <span className="bq-sec-title">
          Lead time for change
          {multiPr ? (
            <abbr
              className="ml-0.5 cursor-help text-amber-600 no-underline dark:text-amber-400"
              title="Multiple linked PRs — lead time can't be attributed to a single pull request."
            >
              *
            </abbr>
          ) : null}
        </span>
        <span className="bq-sec-count">{headCount}</span>
      </div>

      {track.segs.length === 0 ? (
        <p className="bq-lead-foot">
          Not enough session activity captured yet to chart lead time.
        </p>
      ) : (
        <>
          <div className="bq-lead-track">
            {track.segs.map((seg, i) =>
              seg.type === "idle" ? (
                <span
                  className="bq-lead-gap"
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and have no stable id.
                  key={`idle-${i}`}
                  style={{
                    width: `${(seg.durationMs / track.totalMs) * 100}%`,
                  }}
                  title={`Idle / waiting · ${formatDurationMs(seg.durationMs)}`}
                />
              ) : (
                <span
                  className="bq-lead-seg"
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and have no stable id.
                  key={`work-${i}`}
                  style={{
                    width: `${(seg.durationMs / track.totalMs) * 100}%`,
                    background: BUILD_COLOR,
                  }}
                  title={`Active work · ${formatDurationMs(seg.durationMs)}`}
                />
              )
            )}
          </div>
          <div className="bq-lead-axis">
            <span className="font-mono">first session</span>
            <span className="bq-lead-mergept">
              {mergeUnknown ? "in progress" : "merged"}
            </span>
          </div>
          <div className="bq-lead-key">
            <span className="bq-lead-kitem">
              <span
                className="bq-lead-ksw"
                style={{ background: BUILD_COLOR }}
              />
              Active work
              <b className="font-mono">
                {formatDurationMs(track.totalMs - track.idleMs)}
              </b>
            </span>
            <span className="bq-lead-kitem">
              <span className="bq-lead-ksw idle" />
              Idle / waiting
              <b className="font-mono">{formatDurationMs(track.idleMs)}</b>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
