import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import {
  TRACE_END_OF_READ_NOTE,
  TRACE_EVENTS_TRUNCATED_CAPTION,
  TRACE_EVENTS_TRUNCATED_NOTE,
  TRACE_UNREAD_TAIL_LEGEND,
} from "@repo/app/shared/lib/trace-truncation-copy";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createAgentSessionDetailFixture,
  createTurnItemsSpanning,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// ISS-5075: the detail read now bounds the session's raw event stream at a
// defensive row ceiling, so a long-running session's `events` — and the
// `turnItems`/`timeline` derived from them — can arrive as an intentionally
// partial chronological PREFIX, flagged `eventsTruncated`. The Session Trace
// header counts exactly that set, so it must not report a prefix as the whole
// run. Mounts the COMPOSED view because the claim under test is what the header
// tells the reader on screen, not a helper's return value.
//
// Shared verbatim by web and desktop through `@repo/app`, so pinning the
// composed view pins both surfaces.

const TRACE_COUNT_SELECTOR = ".sd3-tracehead .sd3-th-count";
const END_OF_TRACE_NOTE = new RegExp(TRACE_END_OF_READ_NOTE, "i");

const UNREAD_BUCKET_SELECTOR = ".sd3-bars2 .sd3-bar2.unread";

function renderDetail(
  session: ReturnType<typeof createAgentSessionDetailFixture>
) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    )
  );
}

describe("session trace count truncation (ISS-5075)", () => {
  // Absence is the contract's only encoding of "complete" (the field is typed
  // `true`-or-absent), so the complete path is covered by OMITTING it — which is
  // also what every producer that never truncates serves.
  it("leaves the count unqualified when the flag is absent", () => {
    const session = createAgentSessionDetailFixture();
    renderDetail(session);

    const count = document.querySelector<HTMLElement>(TRACE_COUNT_SELECTOR);
    expect(count).toHaveTextContent(
      `${(session.turnItems?.length ?? 0).toLocaleString()} events`
    );
    expect(count).not.toHaveTextContent("truncated");
  });

  it("says later events are truncated when the read hit the cap, without changing what it counts", () => {
    const session = createAgentSessionDetailFixture({ eventsTruncated: true });
    renderDetail(session);

    // The number keeps describing the session's own trace projection — swapping
    // in a different quantity would relocate the split rather than close it.
    const rows = session.turnItems?.length ?? 0;
    expect(rows).not.toBe(session.events.length);
    expect(
      document.querySelector<HTMLElement>(TRACE_COUNT_SELECTOR)
    ).toHaveTextContent(
      `${rows.toLocaleString()} events · ${TRACE_EVENTS_TRUNCATED_NOTE}`
    );
  });

  // Stage review: the cut is also disclosed at the BOTTOM of the rows, where a
  // reader scrolling a long trace actually meets it — the header qualifier alone
  // leaves the trace simply stopping with nothing to explain it.
  it("closes the rendered trace with an end-of-trace note when the read was cut", async () => {
    renderDetail(createAgentSessionDetailFixture({ eventsTruncated: true }));

    await waitFor(() =>
      expect(screen.getByText(END_OF_TRACE_NOTE)).toBeInTheDocument()
    );
  });

  /*
   * Stage review: the Session Timeline plots its bars and dot rail from the same
   * prefix, so the strip has to say it is partial. On a truncated read the axis
   * is extended to the session's OBSERVED end rather than stopping at the last
   * plotted bucket (`resolveWindowEndMs`), so the tail past that bucket is drawn
   * as an unread region — and the caption is that region's legend, naming the
   * shading the reader can see, rather than a bare statement with nothing on
   * screen to attach to.
   *
   * This case and the one below it are a pair, split on the ONE thing that
   * decides the wording: whether the axis actually outruns the last plotted
   * bucket. Here the session's observed end (12:20) sits well past its last
   * plotted row (12:04), so there IS a tail and the caption is its legend.
   */
  it("says the timeline strip was truncated", () => {
    renderDetail(createAgentSessionDetailFixture({ eventsTruncated: true }));

    expect(readTimelineCaption()).toBe(TRACE_UNREAD_TAIL_LEGEND);
  });

  /*
   * The other half of that pair: a truncated read whose last plotted row IS the
   * session's observed end, so the window stops where the bars stop and the
   * strip has no unshaded tail. The cut is real and still has to be disclosed —
   * but a legend for a region that is not drawn would be its own small lie, so
   * the caption states the fact plainly instead.
   *
   * This is the reachable other branch of the strip's caption, and it is what
   * the whole still-running population looks like: the axis is extended only to
   * an OBSERVED bound (never the `updatedAt` sync bump), so a session that is
   * still emitting rows when the read hits its ceiling has nothing beyond its
   * last row to mark.
   */
  it("states the truncation plainly when the strip has no unplotted tail", () => {
    const startedAt = "2026-06-10T12:00:00.000Z";
    /*
     * ISS-5999: exactly two hours, which is what the window's finest scale
     * (24 columns x 5m) covers, so every rendered column holds part of the run
     * and there is no trailing empty stretch. ISS-5819's clock window is
     * unconditional now, and a run SHORTER than the window leaves empty columns
     * past its last row — which the unread-tail rule shades, so a 30-minute
     * fixture no longer describes "no unplotted tail" at all.
     */
    const lastPlottedAt = "2026-06-10T14:00:00.000Z";
    renderDetail(
      createAgentSessionDetailFixture({
        eventsTruncated: true,
        startedAt: new Date(startedAt),
        lastActivityAt: new Date(lastPlottedAt),
        updatedAt: new Date(lastPlottedAt),
        endedAt: null,
        // The rows have to reach the observed end for there to be no tail, so
        // the transcript is re-timed onto the window this session declares.
        turnItems: createTurnItemsSpanning(startedAt, lastPlottedAt),
      })
    );

    expect(document.querySelectorAll(UNREAD_BUCKET_SELECTOR)).toHaveLength(0);
    expect(readTimelineCaption()).toBe(TRACE_EVENTS_TRUNCATED_CAPTION);
  });

  it("leaves the timeline unqualified when the read was complete", () => {
    renderDetail(createAgentSessionDetailFixture());

    expect(readTimelineCaption()).toBeNull();
  });

  /*
   * Logical-QA review: the header count and its qualifier must describe ONE
   * population. The count is always the session's DB-derived projection — the
   * capped one — so the qualifier rides `eventsTruncated` alone. Gating it on
   * what the panel painted meant that on the primary web path (an archived
   * transcript, which is the sole trace source whenever it has content, so the
   * rendered source is never the capped projection) a session past the cap
   * printed its count with no disclosure at all.
   *
   * The end-of-trace note is the other case and stays gated: it claims the ROWS
   * on screen stop early, which is untrue of a whole parsed transcript.
   */
  it("qualifies the count even when the panel painted a different projection", async () => {
    const session = createAgentSessionDetailFixture({
      eventsTruncated: true,
      transcripts: [
        {
          fileKey: "main",
          availability: TranscriptAvailability.Available,
          uploadedAt: "2026-08-04T13:35:00.000Z",
          permanentFailureReason: null,
        },
      ],
    });
    renderDetail(session);

    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(TRACE_COUNT_SELECTOR)
      ).toHaveTextContent(TRACE_EVENTS_TRUNCATED_NOTE)
    );
    expect(screen.queryByText(END_OF_TRACE_NOTE)).not.toBeInTheDocument();
  });

  /*
   * Stage VQA review: a caption cannot undo what the eye already read off the
   * strip. An empty region there already means idle (`.sd3-bar2.idle`,
   * `.sd3-bar2.cb-gap` are both hatched gaps), so the tail past the last plotted
   * bucket needs its own treatment or an unread tail and a quiet tail look the
   * same.
   *
   * What opens that tail is the axis spanning the whole run while the bars stop
   * at the cut, which is now the unconditional derivation (ISS-5366 retired the
   * reconciliation flag to its enabled state).
   */
  it("marks the unplotted tail of the timeline strip as unread", () => {
    renderDetail(createAgentSessionDetailFixture({ eventsTruncated: true }));

    expect(
      document.querySelectorAll(UNREAD_BUCKET_SELECTOR).length
    ).toBeGreaterThan(0);
    // Only then does the caption get to be a legend: it points at a region that
    // is actually on screen.
    expect(readTimelineCaption()).toBe(TRACE_UNREAD_TAIL_LEGEND);
  });

  it("leaves the strip unmarked when the read was complete", () => {
    renderDetail(createAgentSessionDetailFixture());

    expect(document.querySelectorAll(UNREAD_BUCKET_SELECTOR)).toHaveLength(0);
  });

  /*
   * #4949 review (wongk): the caption's test and the shading it captions have to
   * run over the SAME strip. `unreadFromIndex` is derived from the PROJECTED
   * columns, and the bar row and label rail shade on `index >= unreadFromIndex`
   * over those same columns — but the caption compared it against the
   * pre-projection `buckets.length`.
   *
   * The desktop producer bins a session into up to 40 uniform bins and syncs the
   * RESULT, so a persisted strip is routinely wider than the 24 columns the
   * window renders. Any such session then satisfied `unreadFromIndex < 40`
   * unconditionally — 24 columns can never index past 24 — and the strip
   * promised "Shaded: later events truncated" over a tail it had shaded none of.
   *
   * This is the ISS-5999 population specifically: the clock projection was gated
   * behind `sessions-detail-prototype-parity`, so retiring the flag is what
   * makes a shrinking projection the default rather than an opt-in cohort.
   *
   * Every source bin carries activity, so every projected column does too and
   * the unread tail is genuinely empty — which makes the shaded-bar count the
   * counterfactual: swap `columns.length` back to `buckets.length` and the
   * caption flips to the legend while that count stays 0.
   */
  it("states the truncation plainly when a 40-bin persisted strip projects onto fewer columns", () => {
    renderDetail(createFullyActivePersistedStripSession());

    expect(document.querySelectorAll(UNREAD_BUCKET_SELECTOR)).toHaveLength(0);
    expect(readTimelineCaption()).toBe(TRACE_EVENTS_TRUNCATED_CAPTION);
  });
});

/** The desktop producer's bin ceiling — wider than the window's 24 columns. */
const PERSISTED_BIN_COUNT = 40;
const STRIP_STARTED_AT = "2026-06-10T12:00:00.000Z";
const STRIP_ENDED_AT = "2026-06-10T14:00:00.000Z";

/**
 * A truncated read whose persisted strip is a full 40-bin tiling of the run,
 * every bin priced and counted, so the projection onto 24 columns leaves no
 * empty trailing column for the unread rule to shade.
 *
 * #4949 review (wongk): the bins MUST carry producer bounds. `hasProducerBinBounds`
 * is what admits a strip to the clock projection at all, so an unstamped fixture
 * is projected onto nothing — the hook hands back the caller's own 40 buckets and
 * `columns` IS `buckets`, which makes this case's stated counterfactual (swap
 * `columns.length` for `buckets.length`) a no-op that passes against the very bug
 * it was written for. Stamped, the 40 bins really do project onto 24 columns and
 * the two lengths genuinely differ.
 */
function createFullyActivePersistedStripSession() {
  const spanMs =
    new Date(STRIP_ENDED_AT).getTime() - new Date(STRIP_STARTED_AT).getTime();
  const binMs = spanMs / PERSISTED_BIN_COUNT;
  return createAgentSessionDetailFixture({
    activityBuckets: withProducerBinBounds(
      Array.from({ length: PERSISTED_BIN_COUNT }, (_, index) => ({
        label: new Date(
          new Date(STRIP_STARTED_AT).getTime() + index * binMs
        ).toISOString(),
        cIn: 0.4,
        cOut: 0.3,
        cCache: 0.1,
        total: 3,
        toolStart: 1,
        tl0: index,
        byModel: { "gpt-5.5": { cIn: 0.4, cOut: 0.3, cCache: 0.1 } },
      })),
      {
        endMs: new Date(STRIP_ENDED_AT).getTime(),
        startMs: new Date(STRIP_STARTED_AT).getTime(),
      }
    ),
    endedAt: null,
    eventsTruncated: true,
    lastActivityAt: new Date(STRIP_ENDED_AT),
    startedAt: new Date(STRIP_STARTED_AT),
    // The rows have to reach the observed end, or the axis outruns them and the
    // tail the projection did not create reappears from the window instead.
    turnItems: createTurnItemsSpanning(STRIP_STARTED_AT, STRIP_ENDED_AT),
    updatedAt: new Date(STRIP_ENDED_AT),
  });
}

/** The Session Timeline's own caption under the axis, or `null` when silent. */
function readTimelineCaption(): string | null {
  return document.querySelector(".sd3-actbar p")?.textContent ?? null;
}
