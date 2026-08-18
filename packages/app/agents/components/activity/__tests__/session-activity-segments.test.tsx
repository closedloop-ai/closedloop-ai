import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionActivitySegments } from "../session-activity-segments";

// ISS-4790: every span label is derived from the canonical label map, so a
// divergent literal in `describeKind` fails this suite instead of silently
// renaming the bucket. `plan` is included because the strip used to fall through
// to the RAW lowercase phase key here ("plan ·") while both breakdowns rendered
// "Plan" for the same span.
const PLAN_LABEL_RE = new RegExp(`^${ACTIVITY_PHASE_LABEL.plan} ·`);
const IDLE_LABEL_RE = new RegExp(`^${ACTIVITY_PHASE_LABEL.idle} ·`);
const OTHER_LABEL_RE = new RegExp(`^${ACTIVITY_PHASE_LABEL.other} ·`);
const UNATTRIBUTED_ANYWHERE_RE = new RegExp(ACTIVITY_PHASE_LABEL.unattributed);
const ACTIVITY_SEGMENTS_RE = /Activity phases/i;
const PHASES_SPAN_RE = /phases span 3m 0s/;
const PHASES_TIMELINE = "Activity phases timeline";
const OF_260_RE = /of 260$/;
const CLICK_RE = /click/i;
const IDLE_SHARE_RE = /\d+% idle/i;
const ACTIVITY_PHASES_BUTTON_RE = /activity phases/i;

function row(
  overrides: Partial<SyncedActivitySegmentRow> = {}
): SyncedActivitySegmentRow {
  return {
    phase: "implement",
    startMs: 1000,
    endMs: 2000,
    confidence: 0.9,
    evidenceLayers: ["declared"],
    version: 1,
    ...overrides,
  };
}

describe("SessionActivitySegments", () => {
  it("renders one accessible listitem per synced activity segment", () => {
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "plan", startMs: 0, endMs: 1000 }),
          row({ phase: "implement", startMs: 1000, endMs: 3000 }),
          row({
            phase: "idle",
            evidenceLayers: [],
            startMs: 3000,
            endMs: 3500,
          }),
        ]}
      />
    );

    expect(
      screen.getByRole("list", { name: PHASES_TIMELINE })
    ).toBeInTheDocument();
    // The strip's own slices are the labeled listitems; the legend list is
    // aria-hidden decoration, so only the three segments count.
    expect(
      screen.getByRole("listitem", { name: PLAN_LABEL_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: IDLE_LABEL_RE })
    ).toBeInTheDocument();
  });

  it("keys the strip with an inline legend for the kinds present", () => {
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "plan", startMs: 0, endMs: 1000 }),
          row({
            phase: "idle",
            evidenceLayers: [],
            startMs: 1000,
            endMs: 2000,
          }),
        ]}
      />
    );
    // Legend keys each present kind by name, so the color coding is decodable
    // without hover. The bucket words come from the canonical map (the
    // chart-annotation lowercase is CSS, not a second spelling), so a legend
    // literal that drifts from the tooltip beside it fails here.
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(ACTIVITY_PHASE_LABEL.idle)).toBeInTheDocument();
  });

  it("renders nothing when the session has no rows", () => {
    const { container } = render(<SessionActivitySegments rows={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(ACTIVITY_SEGMENTS_RE)).not.toBeInTheDocument();
  });

  it("names an evidence-free catch-all span the same word the breakdown does", () => {
    // ISS-4790: this span used to read "Unattributed" on the strip while the
    // breakdown directly below read "Other" for the same milliseconds — two
    // mutually exclusive names on one page, and `unattributed` specifically
    // means spend the classifier never saw, which an emitted `other` row is not.
    // The evidence-free distinction stays, in the fill and the legend.
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "other", evidenceLayers: [], startMs: 0, endMs: 1000 }),
        ]}
      />
    );
    expect(
      screen.getByRole("listitem", { name: OTHER_LABEL_RE })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("listitem", { name: UNATTRIBUTED_ANYWHERE_RE })
    ).not.toBeInTheDocument();
  });

  it("fills dropped runs so a truncated strip shows no bare gaps", () => {
    // 260 narrow spans exceed the 200-node ceiling. The widest survive; the
    // dropped runs collapse into "hidden" fills so the track stays covered
    // rather than leaving holes that read as idle.
    const rows: SyncedActivitySegmentRow[] = [];
    for (let i = 0; i < 260; i += 1) {
      // Every 5th span is far wider, so it survives the widest-first cut and
      // leaves narrow dropped neighbors on either side.
      const width = i % 5 === 0 ? 400 : 20;
      const startMs = i * 1000;
      rows.push(row({ phase: "implement", startMs, endMs: startMs + width }));
    }
    render(<SessionActivitySegments rows={rows} />);

    const items = screen.getAllByRole("listitem");
    // Kept slices are the labeled listitems; hidden fills are aria-hidden and
    // don't inflate the accessible count past the 200 ceiling.
    expect(items.length).toBeLessThanOrEqual(200);
    const hidden = document.querySelectorAll('.sd3-seg[data-kind="hidden"]');
    expect(hidden.length).toBeGreaterThan(0);
    // Honest "showing N of M" count in the header.
    expect(screen.getByText(OF_260_RE)).toBeInTheDocument();
  });

  it("surfaces phase on hover via the shared sd3-tip popover, not a native title", () => {
    render(
      <SessionActivitySegments
        rows={[row({ phase: "plan", startMs: 0, endMs: 1000 })]}
      />
    );

    const segment = screen.getByRole("listitem", { name: PLAN_LABEL_RE });
    const track = screen.getByRole("list", {
      name: PHASES_TIMELINE,
    });
    // Consistency with the Session Timeline cost bars: the strip must NOT fall
    // back to the browser's native `title` tooltip (different font/box/delay).
    expect(segment).not.toHaveAttribute("title");
    // Passive key: the slice is presentational — no click/keyboard interactivity.
    expect(segment).not.toHaveAttribute("onclick");
    expect(segment.tagName).toBe("LI");
    // No popover until the reader hovers.
    expect(document.querySelector(".sd3-tip")).toBeNull();

    // Hover is delegated from the track container (mouseover bubbles).
    fireEvent.mouseOver(segment);
    // The same styled sd3 popover the cost bars use, portaled to the body.
    const tip = document.querySelector(".sd3-tip.sd3-tip-seg");
    expect(tip).not.toBeNull();
    // Passive key: it inspects phase, it does not promise a click/jump.
    expect(tip?.textContent).not.toMatch(CLICK_RE);

    fireEvent.mouseLeave(track);
    expect(document.querySelector(".sd3-tip")).toBeNull();
  });

  it("renders the header with the Session Timeline title convention", () => {
    render(
      <SessionActivitySegments
        rows={[row({ phase: "plan", startMs: 0, endMs: 1000 })]}
      />
    );
    // Aligns with the sibling meta-section stacked above it in the sticky head
    // (Session Timeline uses .sd3-act-title), not the Session Trace convention.
    const title = screen.getByText("Activity phases");
    expect(title).toHaveClass("sd3-act-title");
  });

  it("declares its own scale so it can't be read against the cost bars", () => {
    // The strip runs on the segment window's own min/max, not the cost bars'
    // session-duration scale. A single "phases span <dur>" caption plus the
    // indented body make the independent scale explicit, so a reader never trusts
    // a vertical correspondence with the bars above — one duration indicator, not
    // a start tick + end tick + caption all repeating the same number.
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "plan", startMs: 0, endMs: 60_000 }),
          row({ phase: "implement", startMs: 60_000, endMs: 180_000 }),
        ]}
      />
    );
    // Window spans 0 → 180000ms = 3 minutes; the single scale caption states it.
    expect(screen.getByText(PHASES_SPAN_RE)).toBeInTheDocument();
    // The redundant 0:00 tick is gone — the caption is the only duration label.
    expect(screen.queryByText("0:00")).not.toBeInTheDocument();
    // The track lives in the inset body, offset from the full-width bars above.
    const track = screen.getByRole("list", { name: PHASES_TIMELINE });
    expect(track.closest(".sd3-segs-body")).not.toBeNull();
  });

  it("renders nothing when every row is malformed", () => {
    const { container } = render(
      <SessionActivitySegments rows={[row({ startMs: 100, endMs: 100 })]} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(ACTIVITY_SEGMENTS_RE)).not.toBeInTheDocument();
  });

  // FEA-4238: a mostly-idle session's phase strip must not front-load a
  // ~98%-empty visualization above the trace — the disclosure defaults collapsed.
  it("defaults the disclosure collapsed for a mostly-idle session", () => {
    const sixtySixHoursMs = 66 * 60 * 60 * 1000;
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "idle", startMs: 0, endMs: sixtySixHoursMs }),
          row({
            phase: "implement",
            startMs: sixtySixHoursMs,
            endMs: sixtySixHoursMs + 30 * 60 * 1000,
          }),
        ]}
      />
    );

    // The header is a disclosure toggle (aria-expanded), collapsed by default so
    // the near-empty track is not painted inline. It carries the section title so
    // the accessible name and the "expand this" affordance both survive the fold.
    const toggle = screen.getByRole("button", {
      name: ACTIVITY_PHASES_BUTTON_RE,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.querySelector(".sd3-act-title")?.textContent).toBe(
      "Activity phases"
    );
    // Collapsed: the track (and its legend) are not rendered.
    expect(
      screen.queryByRole("list", { name: PHASES_TIMELINE })
    ).not.toBeInTheDocument();
    // The honest "N% idle" caveat states why the strip is folded, and it lives ON
    // the summary toggle (always visible) — not inside the collapsed body, which
    // would hide the explanation exactly when it is needed.
    const idleNote = screen.getByText(IDLE_SHARE_RE);
    expect(idleNote).toBeInTheDocument();
    expect(toggle.contains(idleNote)).toBe(true);
    // The section keeps its accessible region name.
    expect(
      screen.getByRole("region", { name: ACTIVITY_SEGMENTS_RE })
    ).toBeInTheDocument();
  });

  it("uses the same disclosure (open by default) when the working stretch is real", () => {
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "idle", startMs: 0, endMs: 1000 }),
          row({ phase: "implement", startMs: 1000, endMs: 2000 }),
        ]}
      />
    );

    // The control is the SAME disclosure toggle on every session (stable), but a
    // session with real work defaults OPEN so the track is directly visible.
    const toggle = screen.getByRole("button", {
      name: ACTIVITY_PHASES_BUTTON_RE,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("list", { name: PHASES_TIMELINE })
    ).toBeInTheDocument();
    // 50% idle is not a majority-idle span, so no idle caveat is surfaced.
    expect(screen.queryByText(IDLE_SHARE_RE)).not.toBeInTheDocument();
  });

  it("can fold and unfold the strip from the disclosure toggle", () => {
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "idle", startMs: 0, endMs: 1000 }),
          row({ phase: "implement", startMs: 1000, endMs: 2000 }),
        ]}
      />
    );

    const toggle = screen.getByRole("button", {
      name: ACTIVITY_PHASES_BUTTON_RE,
    });
    // Open by default (real work); the reader folds it away.
    expect(
      screen.getByRole("list", { name: PHASES_TIMELINE })
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("list", { name: PHASES_TIMELINE })
    ).not.toBeInTheDocument();
    // And unfolds it again — a stable control the reader owns.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("list", { name: PHASES_TIMELINE })
    ).toBeInTheDocument();
  });

  it("stays inline (never folds) and drops the idle caveat when the tiling is truncated", () => {
    // FEA-3779: the same ~98%-idle prefix, flagged truncated. A truncated
    // start-ordered prefix could have had its real work dropped from the tail, so
    // the strip must not fold as "mostly idle" nor claim an idle share of a
    // partial window — it stays open and leads with the honest truncation note.
    const sixtySixHoursMs = 66 * 60 * 60 * 1000;
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "idle", startMs: 0, endMs: sixtySixHoursMs }),
          row({
            phase: "implement",
            startMs: sixtySixHoursMs,
            endMs: sixtySixHoursMs + 30 * 60 * 1000,
          }),
        ]}
        rowsTruncated
      />
    );

    const toggle = screen.getByRole("button", {
      name: ACTIVITY_PHASES_BUTTON_RE,
    });
    // Not folded despite the ~98% idle share.
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // No "N% idle" caveat over a partial window.
    expect(screen.queryByText(IDLE_SHARE_RE)).not.toBeInTheDocument();
    // The honest truncation note IS present on the summary.
    expect(toggle).toHaveTextContent("later phases truncated");
  });

  it("surfaces the idle caveat on a majority-idle strip that stays above the fold threshold", () => {
    // ~90% idle: above the 50% caveat line but the 10% non-idle work is above the
    // 5% fold edge, so the strip stays OPEN yet still explains itself with a
    // sentence rather than looking broken (FEA-4238 review — the hard 5% edge).
    render(
      <SessionActivitySegments
        rows={[
          row({ phase: "idle", startMs: 0, endMs: 9000 }),
          row({ phase: "implement", startMs: 9000, endMs: 10_000 }),
        ]}
      />
    );

    const toggle = screen.getByRole("button", {
      name: ACTIVITY_PHASES_BUTTON_RE,
    });
    // Not folded (10% work > 5% floor), but the idle sentence is present on the
    // summary regardless.
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const idleNote = screen.getByText(IDLE_SHARE_RE);
    expect(toggle.contains(idleNote)).toBe(true);
  });
});
