import { DECLARED_EVIDENCE_LAYER } from "@repo/api/src/activity-evidence-layers";
import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import type {
  ActivitySegment,
  SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ActivityBreakdownSlot,
  getPhaseDisplay,
  SHARE_COLUMN_LABEL,
} from "../../../lib/session-activity-phases";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  ActivityBreakdownMode,
  resolveActivitySegments,
  SessionActivityBreakdown,
} from "../session-activity-breakdown";
import { activitySegmentFixture as segment } from "./activity-segment-fixtures";

const FALLBACK_CAPTION = /No per-phase attribution is available/i;
// The Empty footer must point at the row by its real name, not a third word.
const EMPTY_FOOTER_NAMES_ROW_RE = new RegExp(
  `full cost and tokens are in the ${ACTIVITY_PHASE_LABEL.unattributed} row`,
  "i"
);
const COST_UNAVAILABLE_CAPTION = /Per-phase cost isn.t available/i;
const ACTIVE_WORK_CAPTION = /Active work: \d+% of/i;
const TRUNCATED_CAPTION = /later phases are cut off/i;
const EVENT_SET_JARGON = /event set/i;
const PRICING_CAP_JARGON = /pricing cap/i;
const PROVENANCE_WORD_RE = /declared|inferred/;
// ISS-4685: the share column is cost-based by default and time-based only when
// cost is unavailable, so the panel must NAME the basis it is actually showing.
// The bare, unqualified "Share" header is the defect — under a time-framed
// footer it let two phases with equal Time and unequal share read as a
// contradiction — so it must not survive in either mode.
const BARE_SHARE_LABEL = "Share";
// Any rendered percentage cell. In the fixtures that use this, the share
// column is the only numeric percent on screen, so the match set IS the set of
// shares the panel claims.
const PERCENT_CELL_RE = /^\d+%$/;
// The basis sentences are plain English rather than the abbreviated header
// string dropped mid-clause: "the Time % above are still accurate" parses as a
// value, not a noun. Label and prose are kept honest by both deriving from the
// same `shareByTime` flag as the MATH, not by sharing one string.
const DERIVED_SHARE_BASIS_RE = /Shares are by cost, not time/i;
const COST_UNAVAILABLE_SHARE_BASIS_RE =
  /their share of the session time above are still accurate/i;
// ISS-4674 layout contract: the two column sets, the zero-floor phase track that
// let the column collapse, the class marking a column the phone set drops, and
// the scroll container's accessible name.
const BASE_COLUMN_TRACKS =
  "grid-cols-[0.625rem_minmax(6rem,1fr)_3.5rem_4.5rem_3.25rem]";
// The wide set restores all eight columns at the CONTAINER breakpoint
// (`@sm/breakdown`, keyed off the `@container/breakdown` on the panel), not the
// viewport `sm:` — so the breakpoint tracks the detail PANE width, not the
// window (ktp review).
const WIDE_COLUMN_TRACKS =
  "@sm/breakdown:grid-cols-[0.625rem_minmax(6rem,1fr)_3.5rem_2.75rem_3.5rem_3.5rem_4.5rem_3.25rem]";
const COLLAPSIBLE_PHASE_TRACK = "minmax(0";
const SECONDARY_CELL_CLASS = "hidden @sm/breakdown:block";
// The panel's own container-query context: the breakpoint above resolves against
// THIS element's inline size (the pane), which is what actually starves the
// columns, not the viewport.
const CONTAINER_CONTEXT_CLASS = "@container/breakdown";
// Source, Conf., and Tokens — the three the phone set drops.
const SECONDARY_COLUMN_COUNT = 3;
const SCROLL_REGION_LABEL = "Activity breakdown columns";

// Raw activity-segment tiling as it arrives on `activitySegmentRows` — the same
// rows the Activity phases strip renders. A capped session ships these but NOT
// the priced `activitySegments` (the projection drops them), which is exactly
// the ISS-4446 contradiction: strip shows phases, breakdown must not deny them.
const RAW_ROWS: SyncedActivitySegmentRow[] = [
  {
    phase: "implement",
    startMs: 1000,
    endMs: 301_000,
    confidence: 0.8,
    evidenceLayers: [DECLARED_EVIDENCE_LAYER],
    version: 1,
  },
  {
    phase: "review",
    startMs: 301_000,
    endMs: 361_000,
    confidence: 0.5,
    evidenceLayers: ["structural"],
    version: 1,
  },
];

// plan + implement + idle + other = $4.82, matching the fixture session total.
const SEGMENTS: ActivitySegment[] = [
  segment({
    key: "plan",
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: 1.0,
    durationMs: 60_000,
    confidence: 0.9,
    source: "explicit",
  }),
  segment({
    key: "implement",
    inputTokens: 4000,
    outputTokens: 400,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
    costUsd: 3.0,
    durationMs: 300_000,
    confidence: 0.6,
    source: "loop_perf",
  }),
  segment({ key: "idle", durationMs: 120_000 }),
  segment({
    key: "other",
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.82,
    isUnclassified: true,
  }),
];

// The phase grid cells, in row order. Anchored on `data-slot`, not on text: the
// phase NAME lives in its own child element (ISS-4674, so the folded provenance
// suffix cannot merge into it), and a text lookup resolves to that CHILD — whose
// class list is not the cell's layout contract and whose box is its own glyphs
// rather than the flexible phase track.
function phaseCells(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-slot="${ActivityBreakdownSlot.PhaseCell}"]`
    )
  );
}

describe("SessionActivityBreakdown", () => {
  it("renders one row per phase with absolute cost and the honest other/idle remainders", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    render(<SessionActivityBreakdown session={session} />);

    // Each phase gets a labelled row; idle and other are shown, never hidden.
    for (const label of [
      ACTIVITY_PHASE_LABEL.plan,
      ACTIVITY_PHASE_LABEL.implement,
      ACTIVITY_PHASE_LABEL.idle,
      ACTIVITY_PHASE_LABEL.other,
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Absolute per-phase cost, incl. the $0 idle row (shown, not zeroed away).
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText("$3.00")).toBeInTheDocument();
    expect(screen.getByText("$0.82")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("reconciles the header total to the sum of per-phase cost", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );
    const total = SEGMENTS.reduce((sum, s) => sum + s.costUsd, 0);
    // The header shows the reconciled total (also the session's estimatedCost).
    expect(container.textContent).toContain(`$${total.toFixed(2)}`);
  });

  it("distinguishes inferred from declared and surfaces numeric confidence", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    render(<SessionActivityBreakdown session={session} />);

    // Provenance affordance is distinct from confidence (a separate quantity).
    // Each word renders twice — the standalone Source column plus the phone-only
    // inline suffix folded into the phase cell (ISS-4674 jxW/ktk) — so assert at
    // least one carrier rather than a unique match.
    expect(screen.getAllByText("declared").length).toBeGreaterThan(0);
    expect(screen.getAllByText("inferred").length).toBeGreaterThan(0);
    // Numeric per-phase confidence.
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  // ISS-4674 regression. The phase NAME must stay its own element, separate from
  // the provenance word the narrow set folds into the same cell. While the label
  // was a bare text node beside that suffix, the cell's full subtree text read
  // "Implementdeclared", so no element carried the bare phase name and every
  // consumer that matches on subtree text — Playwright's text engine, and so the
  // Chromium layout guard — found nothing at the phone width this panel was
  // fixed for. jsdom could not see it: Testing Library's `getNodeText` joins only
  // an element's DIRECT text-node children, so the bare label still matched here
  // while the e2e spec went red. Assert the STRUCTURE, which jsdom can see.
  it("keeps each phase name in its own element beside the folded provenance suffix", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    const cells = phaseCells(container);
    expect(cells).toHaveLength(SEGMENTS.length);

    // Each name element carries the bare display label and nothing else — no
    // provenance word merged in.
    const names = cells.map((cell) =>
      cell.querySelector(`[data-slot="${ActivityBreakdownSlot.PhaseName}"]`)
    );
    expect(names.map((name) => name?.textContent)).toEqual(
      SEGMENTS.map((segmentItem) => getPhaseDisplay(segmentItem.key).label)
    );
    for (const name of names) {
      expect(PROVENANCE_WORD_RE.test(name?.textContent ?? "")).toBe(false);
    }

    // …while the suffix itself still rides inside the cell, so the narrow set
    // keeps its provenance carrier (AC-005.2). Both halves, or this test would
    // pass on a fix that simply deleted the suffix.
    const cellWithProvenance = cells.filter((cell) =>
      PROVENANCE_WORD_RE.test(cell.textContent ?? "")
    );
    expect(cellWithProvenance).toHaveLength(2);
  });

  it("labels the metric columns with a header row so the two percentages are distinguishable", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    render(<SessionActivityBreakdown session={session} />);

    // Confidence and share are both percentages; the header names them so a
    // touch/keyboard user is not left guessing (the old per-cell `title`
    // tooltips never surfaced for them).
    for (const heading of ["Phase", "Source", "Conf.", "Time", "Tokens"]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    // "Cost" appears both as a header and in footer/data copy, so assert at
    // least one match rather than a unique one.
    expect(screen.getAllByText("Cost").length).toBeGreaterThan(0);
    // The share column is named by its basis, not by a bare unitless "Share"
    // (ISS-4685) — this fixture is priced, so the basis is cost.
    expect(screen.getAllByText(SHARE_COLUMN_LABEL.cost).length).toBeGreaterThan(
      0
    );
    expect(screen.queryByText(BARE_SHARE_LABEL)).not.toBeInTheDocument();
  });

  it("computes the relative % share against the session total", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    render(<SessionActivityBreakdown session={session} />);
    // implement = 3.0 / 4.82 ≈ 62%.
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("renders the honest single fallback when the session has no derived segments and no raw tiling", () => {
    // The fixture carries neither activitySegments nor activitySegmentRows
    // (pre-FEA-3568 / pre-backfill): attribution genuinely IS unavailable.
    const session = createAgentSessionDetailFixture();
    render(<SessionActivityBreakdown session={session} />);

    // ISS-4790: Empty mode is the no-tiling-at-all case, so the row is the
    // `unattributed` residual — spend the classifier never saw — NOT `other`,
    // which means spend it tiled but could not classify. The branch rollup files
    // exactly these sessions under `unattributed`, so the two surfaces now agree
    // about whether the classifier ever looked at the same dollars. The label
    // comes from the canonical map, never a literal copied into the builder.
    expect(
      screen.getByText(ACTIVITY_PHASE_LABEL.unattributed)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(ACTIVITY_PHASE_LABEL.other)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(ACTIVITY_PHASE_LABEL.plan)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(ACTIVITY_PHASE_LABEL.implement)
    ).not.toBeInTheDocument();
    expect(screen.getByText(FALLBACK_CAPTION)).toBeInTheDocument();
    // The footer explaining this state must name the row it explains.
    expect(screen.getByText(EMPTY_FOOTER_NAMES_ROW_RE)).toBeInTheDocument();
    expect(
      screen.queryByText(COST_UNAVAILABLE_CAPTION)
    ).not.toBeInTheDocument();
  });

  // ISS-4446: a capped session ships raw `activitySegmentRows` (the strip renders
  // phases) but NOT priced `activitySegments`. The breakdown must tell the SAME
  // phase story as the strip — never the blanket "no attribution" line.
  it("renders the per-phase breakdown from raw rows on a capped session instead of contradicting the phase strip", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    render(<SessionActivityBreakdown session={session} />);

    // The phases the strip shows are attributed here too — NOT collapsed into a
    // single unclassified remainder.
    expect(
      screen.getByText(ACTIVITY_PHASE_LABEL.implement)
    ).toBeInTheDocument();
    expect(screen.getByText(ACTIVITY_PHASE_LABEL.review)).toBeInTheDocument();
    // It does NOT claim attribution is unavailable — it explains cost is.
    expect(screen.queryByText(FALLBACK_CAPTION)).not.toBeInTheDocument();
    expect(screen.getByText(COST_UNAVAILABLE_CAPTION)).toBeInTheDocument();
  });

  it("shows an honest cost placeholder (not $0.00) per phase on a capped session while labelling the header rollup a session total", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    // Per-phase cost is dropped when capped, so no fabricated $0.00 rows.
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    // The header still carries the session's real rollup cost, so the panel
    // never claims this large session was free — and it is labelled "session
    // total" so it cannot be read as the sum of the "—" Cost column below it.
    expect(container.textContent).toContain(
      `$${session.estimatedCost.toFixed(2)} session total`
    );
  });

  // ISS-4446(e): the "Active work: X% of Y" line is the one number still fully
  // true on a cost-unavailable session, so it must be kept — not dropped.
  it("keeps the Active work time line on a capped session", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    render(<SessionActivityBreakdown session={session} />);

    expect(screen.getByText(COST_UNAVAILABLE_CAPTION)).toBeInTheDocument();
    expect(screen.getByText(ACTIVE_WORK_CAPTION)).toBeInTheDocument();
  });

  // ISS-4446(f): the copy is in the reader's language — no "event set" or
  // "pricing cap" jargon anywhere in the panel.
  it("uses user-language copy with no internal cap jargon", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    render(<SessionActivityBreakdown session={session} />);

    const footer = screen.getByText(COST_UNAVAILABLE_CAPTION);
    const footerText = footer.textContent ?? "";
    expect(footerText).not.toMatch(EVENT_SET_JARGON);
    expect(footerText).not.toMatch(PRICING_CAP_JARGON);
    // No em-dash in the footer product copy (ISS-4446 (h)); the "—" Cost-cell
    // placeholder is a data value, not sentence punctuation, so it lives on the
    // rows, never in this sentence.
    expect(footerText).not.toContain("—");
  });

  // ISS-4446(d) + codex P2: when the tiling is a truncated prefix, the footer
  // says later phases are missing instead of implying the shares cover
  // everything.
  it("adds a truncation caveat when the tiling is a partial prefix", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
      activitySegmentRowsTruncated: true,
    });
    render(<SessionActivityBreakdown session={session} />);

    expect(screen.getByText(TRUNCATED_CAPTION)).toBeInTheDocument();
  });

  it("omits the truncation caveat when the tiling is complete", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    render(<SessionActivityBreakdown session={session} />);

    expect(screen.queryByText(TRUNCATED_CAPTION)).not.toBeInTheDocument();
  });

  // wongk (s5G): a nonempty `activitySegments` array is NOT proof per-phase cost
  // is available. A non-capped incomplete stream builds segments with real
  // durations but $0 cost against a nonzero session cost — that must render as
  // cost-unavailable, not a $0.00 "Derived" breakdown.
  it("treats a nonempty but $0-cost derived breakdown as cost-unavailable", () => {
    const zeroCostSegments = SEGMENTS.map((s) => ({ ...s, costUsd: 0 }));
    const session = createAgentSessionDetailFixture({
      activitySegments: zeroCostSegments,
    });
    render(<SessionActivityBreakdown session={session} />);

    // It does not fabricate $0.00 per phase against a real session cost.
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText(COST_UNAVAILABLE_CAPTION)).toBeInTheDocument();
    // The phases still render — attribution IS present, only cost is missing.
    expect(screen.getByText(ACTIVITY_PHASE_LABEL.plan)).toBeInTheDocument();
    expect(
      screen.getByText(ACTIVITY_PHASE_LABEL.implement)
    ).toBeInTheDocument();
  });

  // ISS-4685. The share column is a COST share in the priced default mode, and
  // nothing on screen said so: the header was a bare "Share" and the Derived
  // footer only carried the time line. Read under a Time column and an
  // "Active work: X% of Y" caption, that reads as share-of-time.
  it("names the share column by its cost basis in the priced default mode", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    // The column header carries the basis it is actually computing.
    const header = container.querySelector("li[aria-hidden]");
    expect(header?.textContent).toContain(SHARE_COLUMN_LABEL.cost);
    expect(header?.textContent).not.toContain(SHARE_COLUMN_LABEL.time);
    // The unqualified label — the defect itself — is gone from the panel.
    expect(screen.queryByText(BARE_SHARE_LABEL)).not.toBeInTheDocument();
    // Prose expansion in the footer, which is the ONLY carrier for a screen
    // reader: the header row is aria-hidden and the "62%" cells have no
    // accessible name of their own.
    expect(screen.getByText(DERIVED_SHARE_BASIS_RE)).toBeInTheDocument();
    // The trustworthy active-work time line is still there beside it, not
    // displaced by the new sentence.
    expect(screen.getByText(ACTIVE_WORK_CAPTION)).toBeInTheDocument();
  });

  // The other half of the same contract: the label must TRACK the basis, not
  // just be renamed once. When per-phase cost is unavailable the very same
  // column is a time share, so a hardcoded "Cost %" would be a fresh lie.
  it("names the share column by its time basis when per-phase cost is unavailable", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    const header = container.querySelector("li[aria-hidden]");
    expect(header?.textContent).toContain(SHARE_COLUMN_LABEL.time);
    expect(header?.textContent).not.toContain(SHARE_COLUMN_LABEL.cost);
    expect(screen.queryByText(BARE_SHARE_LABEL)).not.toBeInTheDocument();
    // This mode always named its basis in prose, and still states it in full —
    // it must not be left with a bare column name while the priced mode gets an
    // explanation, since this footer is the only carrier a screen reader has.
    expect(
      screen.getByText(COST_UNAVAILABLE_SHARE_BASIS_RE)
    ).toBeInTheDocument();
    // And it must not claim a cost basis anywhere, since per-phase cost is the
    // one thing this mode cannot show.
    expect(screen.queryByText(DERIVED_SHARE_BASIS_RE)).not.toBeInTheDocument();
  });

  // ISS-4685 third mode. A PRICED Empty session really is a cost share — its one
  // residual row is priced from the session total — so the header names cost.
  // But it renders exactly one row at 100%, so there is no split to misread and
  // the footer carries no basis sentence: a definition of a column with nothing
  // to compare against is a glossary entry, not an explanation.
  it("names the cost basis in the header of a priced empty state, without a basis sentence", () => {
    const { container } = render(
      <SessionActivityBreakdown session={createAgentSessionDetailFixture()} />
    );

    const header = container.querySelector("li[aria-hidden]");
    expect(header?.textContent).toContain(SHARE_COLUMN_LABEL.cost);
    expect(header?.textContent).not.toContain(SHARE_COLUMN_LABEL.time);
    expect(screen.queryByText(BARE_SHARE_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(DERIVED_SHARE_BASIS_RE)).not.toBeInTheDocument();
    // The state's own explanation is untouched.
    expect(screen.getByText(EMPTY_FOOTER_NAMES_ROW_RE)).toBeInTheDocument();
  });

  // ISS-4685 (wongk). Empty proves there is no TILING; it proves nothing about
  // PRICING. An unpriced session — real work, no token-usage cost and no billing
  // mode, the desktop seed's shape — reaches this same mode with an
  // `estimatedCost` of 0 (the projection's floor for a NULL
  // `cost_usd_estimated`), and keying the basis off the mode headed that column
  // "Cost %" and called its number a share of the session cost while the rest of
  // session detail showed the cost as unknown.
  it("does not claim a cost basis on an unpriced empty session", () => {
    const { container } = render(
      <SessionActivityBreakdown
        session={createAgentSessionDetailFixture({ estimatedCost: 0 })}
      />
    );

    const header = container.querySelector("li[aria-hidden]");
    expect(header?.textContent).toContain(SHARE_COLUMN_LABEL.time);
    expect(header?.textContent).not.toContain(SHARE_COLUMN_LABEL.cost);
    expect(screen.queryByText(DERIVED_SHARE_BASIS_RE)).not.toBeInTheDocument();
  });

  // ISS-4685. Per-row `Math.round` renders three equal shares as 33/33/33 = 99,
  // so a column headed "Cost %" claims a share OF the session that does not add
  // up to the session. The sibling branch Cost-to-merge panel reconciles the
  // identical concept with the largest-remainder helper; this panel now shares
  // it, so the two cannot disagree about the same dollars.
  it("renders shares that total exactly 100 for three equal-cost phases", () => {
    const thirds: ActivitySegment[] = ["plan", "implement", "review"].map(
      (key) =>
        segment({ key, costUsd: 1.0, durationMs: 60_000, source: "explicit" })
    );
    render(
      <SessionActivityBreakdown
        session={createAgentSessionDetailFixture({
          activitySegments: thirds,
          // ISS-5128 + ISS-5366: the residual row is unconditional now, so the
          // session cost has to MATCH what the phases attribute or this fixture
          // grows a fourth "Unattributed" row and stops being the three-phase
          // case it is named for. The fixture default (4.82) does not.
          estimatedCost: 3.0,
        })}
      />
    );

    const rendered = screen
      .getAllByText(PERCENT_CELL_RE)
      .map((node) => Number.parseInt(node.textContent ?? "", 10));
    expect(rendered).toHaveLength(thirds.length);
    expect(rendered.reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  // ISS-4685. A session with neither priced spend nor measured time has no
  // denominator, so there is no share to report. A "0%" under a "Cost %" /
  // "Time %" header is the unknown-denominator case wearing a true zero's
  // clothes — and the proportional bar already declines to draw on exactly this
  // condition, so the column must not keep claiming a split the bar refused.
  it("renders an em dash, not 0%, when there is no denominator to divide by", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    render(
      <SessionActivityBreakdown
        session={createAgentSessionDetailFixture({
          endedAt: now,
          estimatedCost: 0,
          startedAt: now,
        })}
      />
    );

    // No percentage is rendered anywhere: the share cell is the only numeric
    // percent in this fixture (confidence is null on the residual row), so an
    // empty match set is proof the column reported "unknown" rather than 0%.
    expect(screen.queryAllByText(PERCENT_CELL_RE)).toHaveLength(0);
    // ...and it says so with the same em dash the rest of the panel uses for an
    // unavailable value.
    const shareCell = screen
      .getByText(FALLBACK_CAPTION)
      .closest("section")
      ?.querySelectorAll("li:not([aria-hidden]) > span:last-child")[0];
    expect(shareCell?.textContent).toBe("—");
  });

  // The reported repro (SES-74465): two phases with the SAME wall-time and
  // different spend render different shares. That is correct cost math, and the
  // panel now says which measure it is, so the pair cannot read as a data bug.
  it("explains its basis when two phases share a duration but not a share", () => {
    const equalTimeSegments: ActivitySegment[] = [
      segment({
        key: "implement",
        costUsd: 3.0,
        durationMs: 120_000,
        source: "explicit",
      }),
      segment({
        key: "review",
        costUsd: 1.0,
        durationMs: 120_000,
        source: "explicit",
      }),
    ];
    const session = createAgentSessionDetailFixture({
      activitySegments: equalTimeSegments,
      // The $4 the shares below are OF. Left at the fixture default (4.82) the
      // now-unconditional ISS-5128 residual would add an Unattributed row and
      // move both percentages off the figures this case is about.
      estimatedCost: 4.0,
    });
    render(<SessionActivityBreakdown session={session} />);

    // Same Time cell rendered twice, two different shares (75% / 25% of $4).
    expect(screen.getAllByText("2m")).toHaveLength(2);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    // ...and the panel names the measure that makes those two numbers agree.
    expect(screen.getByText(DERIVED_SHARE_BASIS_RE)).toBeInTheDocument();
  });
});

describe("resolveActivitySegments", () => {
  it("uses derived segments when present and priced", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const resolved = resolveActivitySegments(session);
    expect(resolved.mode).toBe(ActivityBreakdownMode.Derived);
    expect(resolved.segments).toHaveLength(SEGMENTS.length);
    expect(resolved.rowsTruncated).toBe(false);
  });

  // wongk (s5G): a nonempty derived breakdown whose per-phase cost sums to 0 is
  // an unpriced/incomplete cost stream, not a trustworthy $0.00 breakdown.
  it("treats a nonempty $0-cost derived breakdown as cost-unavailable, not derived", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS.map((s) => ({ ...s, costUsd: 0 })),
    });
    const resolved = resolveActivitySegments(session);
    expect(resolved.mode).toBe(ActivityBreakdownMode.CostUnavailable);
    // Phases/durations are still carried through.
    expect(resolved.segments.length).toBeGreaterThan(0);
  });

  // thread -o: `buildActivitySegments` clamps malformed spans to zero duration
  // rather than dropping them, so a tiling of all-bad bounds must fall through
  // to Empty, not render a table of 0s/0% under a "durations attributed" footer.
  it("falls back to Empty when the raw tiling clamps to zero total duration", () => {
    const malformedRows: SyncedActivitySegmentRow[] = [
      {
        phase: "implement",
        startMs: 5000,
        endMs: 1000, // end before start -> clamps to 0 duration
        confidence: 0.8,
        evidenceLayers: [DECLARED_EVIDENCE_LAYER],
        version: 1,
      },
    ];
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: malformedRows,
    });
    const resolved = resolveActivitySegments(session);
    expect(resolved.mode).toBe(ActivityBreakdownMode.Empty);
    expect(resolved.segments).toHaveLength(1);
    // ISS-4790: the no-attribution residual is `unattributed`, matching the
    // bucket the branch rollup files these sessions under.
    expect(resolved.segments[0]?.key).toBe(UNATTRIBUTED_KEY);
    expect(resolved.segments[0]?.label).toBe(ACTIVITY_PHASE_LABEL.unattributed);
  });

  // ISS-4446: capped session — no priced segments, but raw rows present. Derive
  // the per-phase breakdown from the tiling with zero cost.
  it("derives an unpriced per-phase breakdown from raw rows when the session is capped", () => {
    const session = createAgentSessionDetailFixture({
      activitySegmentRows: RAW_ROWS,
    });
    const resolved = resolveActivitySegments(session);
    expect(resolved.mode).toBe(ActivityBreakdownMode.CostUnavailable);
    // One segment per distinct phase in the tiling — attribution IS present.
    expect(resolved.segments.map((segment) => segment.key)).toEqual([
      "implement",
      "review",
    ]);
    // Durations carry over from the tiling; cost/tokens are honestly zero.
    for (const segment of resolved.segments) {
      expect(segment.durationMs).toBeGreaterThan(0);
      expect(segment.costUsd).toBe(0);
    }
  });

  // thread -d + codex P2: the truncation flag threads through so the footer can
  // qualify the shares as a partial window.
  it("threads the truncated flag through from the session", () => {
    const truncated = resolveActivitySegments(
      createAgentSessionDetailFixture({
        activitySegmentRows: RAW_ROWS,
        activitySegmentRowsTruncated: true,
      })
    );
    expect(truncated.rowsTruncated).toBe(true);

    const complete = resolveActivitySegments(
      createAgentSessionDetailFixture({ activitySegmentRows: RAW_ROWS })
    );
    expect(complete.rowsTruncated).toBe(false);
  });

  it("falls back to a single unattributed segment when there is neither derived nor raw tiling", () => {
    const session = createAgentSessionDetailFixture();
    const resolved = resolveActivitySegments(session);
    expect(resolved.mode).toBe(ActivityBreakdownMode.Empty);
    expect(resolved.segments).toHaveLength(1);
    // ISS-4790: `unattributed`, not `other` — the classifier never saw this
    // spend, and the branch rollup files it under the same bucket.
    expect(resolved.segments[0]).toMatchObject({
      key: UNATTRIBUTED_KEY,
      label: ACTIVITY_PHASE_LABEL.unattributed,
      isUnclassified: true,
      costUsd: session.estimatedCost,
      inputTokens: session.inputTokens,
    });
  });
});

// ISS-4674: at ~390px the eight columns' fixed tracks consumed the whole width,
// so the flexible Phase track collapsed to nothing (rows became bare colored
// dots), the un-truncated "Phase" header spilled over "Source" as "PSaosuerce",
// and the trailing Share column clipped off-screen with no cue.
//
// jsdom performs no layout, so these assert the layout CONTRACT a browser then
// resolves — the two column sets, which cells drop below `sm`, the clip on every
// column label, and the scroll container the squeezed-pane case falls back to.
// The pixel proof (Cost and Share on screen at 390px, headers that do not
// collide at the tightest eight-column width, the unchanged desktop rendering)
// is the Chromium case in `e2e/session-detail.spec.ts` and the desktop-renderer
// case in `apps/desktop/test/e2e/responsive-pages.spec.ts`.
describe("SessionActivityBreakdown — narrow-viewport layout (ISS-4674)", () => {
  it("drops to a five-column set below the sm breakpoint so cost and share still fit", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    const rows = Array.from(container.querySelectorAll("li"));
    // The header plus one row per segment, all on the same shared tracks.
    expect(rows).toHaveLength(SEGMENTS.length + 1);
    for (const row of rows) {
      // Base = the phone set; the `sm:` variant restores all eight columns.
      expect(row.className).toContain(BASE_COLUMN_TRACKS);
      expect(row.className).toContain(WIDE_COLUMN_TRACKS);
      // A 0 floor on the phase track is what let the fixed tracks starve the
      // phase name — neither set may reintroduce it.
      expect(row.className).not.toContain(COLLAPSIBLE_PHASE_TRACK);
    }
  });

  it("hides exactly the three secondary columns on the phone set, in both the labels and the data cells", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    // Every row must hide the SAME number of cells as the header, or the
    // surviving cells stop lining up with the five base tracks.
    for (const row of Array.from(container.querySelectorAll("li"))) {
      const hidden = Array.from(row.querySelectorAll("span")).filter((cell) =>
        cell.className.includes(SECONDARY_CELL_CLASS)
      );
      expect(hidden).toHaveLength(SECONDARY_COLUMN_COUNT);
    }

    // Cost and the share column — the ones the panel exists for — are never
    // dropped. The share label is the basis-named one (ISS-4685); this fixture
    // is priced, so it is the cost variant.
    const header = container.querySelector("li[aria-hidden]");
    for (const label of ["Cost", SHARE_COLUMN_LABEL.cost, "Phase", "Time"]) {
      const cell = Array.from(header?.querySelectorAll("span") ?? []).find(
        (candidate) => candidate.textContent === label
      );
      expect(cell?.className).not.toContain(SECONDARY_CELL_CLASS);
    }
  });

  it("clips every column label inside its own track so a label can never overlap the next column", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    const header = container.querySelector("li[aria-hidden]");
    const labelledCells = Array.from(
      header?.querySelectorAll("span") ?? []
    ).filter((cell) => (cell.textContent ?? "").trim().length > 0);

    // Every labelled cell, not just Phase — a column label can out-measure its
    // track at any width (a larger user font size), so this is the independent
    // second bug, fixed regardless of which column set is live.
    expect(labelledCells.map((cell) => cell.textContent)).toEqual([
      "Phase",
      "Source",
      "Conf.",
      "Time",
      "Tokens",
      "Cost",
      SHARE_COLUMN_LABEL.cost,
    ]);
    for (const cell of labelledCells) {
      // `min-w-0` defeats the grid item's `min-width: auto`, which is what
      // actually allows the track to clip; `truncate` renders the ellipsis.
      expect(cell.className).toContain("min-w-0");
      expect(cell.className).toContain("truncate");
    }
  });

  it("lets the phase NAME wrap rather than truncate, so the unclassified remainder stays readable", () => {
    // Empty mode: "Other / unclassified" is the panel's only row, so truncating
    // it would leave the whole panel reading "Other / uncl…".
    const { container } = render(
      <SessionActivityBreakdown session={createAgentSessionDetailFixture()} />
    );

    const cells = phaseCells(container);
    expect(cells).toHaveLength(1);
    const phaseCell = cells[0]!;
    expect(phaseCell.className).toContain("min-w-0");
    expect(phaseCell.className).not.toContain("truncate");
    // `overflow-wrap: anywhere` breaks a single unbreakable titleized key (an
    // out-of-taxonomy `phase` like `post_review_validation`) so it cannot spill
    // over the Time cell, while still preferring the space in this label
    // (jxU/ktm review). Without it `min-w-0` alone gives no break point for a
    // spaceless token.
    expect(phaseCell.className).toContain("[overflow-wrap:anywhere]");
    // Still only one data row, so the wrap is cheap.
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("does not spill an out-of-taxonomy phase key over the Time cell (jxU/ktm)", () => {
    // `phase` is a bounded free string, not the closed eight-key taxonomy, so a
    // future classifier key titleizes to one unbreakable token. The phase cell
    // must carry the anywhere-break that keeps that token inside its 6rem track.
    const outOfTaxonomyKey = "post_review_validation";
    // Null provenance so no inline suffix joins the cell's text — the assertion
    // is about the break rule on the phase label itself.
    const session = createAgentSessionDetailFixture({
      activitySegments: [
        {
          ...SEGMENTS[0]!,
          key: outOfTaxonomyKey,
          isUnclassified: false,
          source: null,
        },
      ],
      // Fully attributed, so the now-unconditional ISS-5128 residual adds no
      // second phase cell — this case asserts there is exactly ONE.
      estimatedCost: 1.0,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    const cells = phaseCells(container);
    expect(cells).toHaveLength(1);
    const phaseCell = cells[0]!;
    // The titleized key renders as the cell's phase name, so the break rule
    // below is guarding the token this test is about.
    expect(phaseCell.textContent).toBe(getPhaseDisplay(outOfTaxonomyKey).label);
    expect(phaseCell.className).toContain("[overflow-wrap:anywhere]");
    expect(phaseCell.className).not.toContain("truncate");
  });

  it("puts the whole panel in a container-query context so the breakpoint tracks the pane, not the viewport (ktp)", () => {
    const { container } = render(
      <SessionActivityBreakdown
        session={createAgentSessionDetailFixture({
          activitySegments: SEGMENTS,
        })}
      />
    );

    // The column-set breakpoint (@sm/breakdown, asserted on the rows) resolves
    // against THIS element's inline size — the detail pane — which is what
    // actually starves the columns when the comments rail is open, not the
    // window width.
    const section = container.querySelector("section");
    expect(section?.className).toContain(CONTAINER_CONTEXT_CLASS);
  });

  it("keeps provenance readable on the phone set by folding it into the phase cell (jxW/ktk)", () => {
    // Below @sm/breakdown the standalone Source column is dropped, so declared
    // vs inferred — the one honest-attribution qualifier — must survive as a
    // muted suffix in the phase cell, hidden again at @sm+ so it is never
    // doubled with the standalone column.
    const { container } = render(
      <SessionActivityBreakdown
        session={createAgentSessionDetailFixture({
          activitySegments: SEGMENTS,
        })}
      />
    );

    // At least one segment is inferred and one declared in the fixture, and both
    // words render twice: once in the (currently-hidden) standalone column and
    // once in the phone-only inline suffix.
    for (const word of ["declared", "inferred"]) {
      const carriers = screen.getAllByText(word);
      const inlineSuffix = carriers.find((node) =>
        node.className.includes("@sm/breakdown:hidden")
      );
      const standaloneColumn = carriers.find((node) =>
        node.className.includes(SECONDARY_CELL_CLASS)
      );
      // The inline suffix carries provenance on the phone set...
      expect(inlineSuffix).toBeDefined();
      // ...and hides at @sm+ so the standalone column is the sole carrier there.
      expect(standaloneColumn).toBeDefined();
    }

    // A segment with unknown provenance emits neither carrier — no empty
    // "declared/inferred" word is invented for it.
    const emptyProvenanceRow = Array.from(
      container.querySelectorAll("li")
    ).find((row) => row.textContent?.includes("Idle"));
    expect(emptyProvenanceRow?.textContent).not.toMatch(PROVENANCE_WORD_RE);
  });

  it("keeps the table in a scroll container for the squeezed-pane case", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    const { container } = render(
      <SessionActivityBreakdown session={session} />
    );

    const track = container.querySelector(".overflow-x-auto");
    expect(track).not.toBeNull();
    // The list sizes to its columns and overflows the track rather than being
    // squeezed into it — the same contract GridTable states for its host.
    expect(track?.querySelector("ul")?.className).toContain("min-w-fit");
  });

  it("does not add a tab stop or a second landmark when nothing overflows", () => {
    const session = createAgentSessionDetailFixture({
      activitySegments: SEGMENTS,
    });
    render(<SessionActivityBreakdown session={session} />);

    // jsdom lays nothing out, so the track measures as non-scrollable — the
    // same state as a desktop width where all eight columns fit. There must be
    // no dead tab stop and no group nested inside the panel's own named
    // section. The focusable-while-scrollable half is asserted in Chromium.
    expect(
      screen.queryByRole("group", { name: SCROLL_REGION_LABEL })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Activity breakdown" })
    ).toBeInTheDocument();
  });
});

describe("getPhaseDisplay", () => {
  it("returns the canonical display for a known phase", () => {
    expect(getPhaseDisplay("implement").label).toBe(
      ACTIVITY_PHASE_LABEL.implement
    );
    expect(getPhaseDisplay("other").label).toBe(ACTIVITY_PHASE_LABEL.other);
  });

  it("titleizes an unknown phase rather than crashing", () => {
    expect(getPhaseDisplay("bikeshed")).toEqual({
      label: "Bikeshed",
      colorVar: expect.any(String),
    });
  });

  it("does not let an inherited-property key shadow the lookup (proto-safety)", () => {
    // `phase` is a bounded free string, so keys like these must take the
    // titleize fallback, not resolve to an Object.prototype member with
    // undefined label/color.
    for (const key of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      const display = getPhaseDisplay(key);
      expect(typeof display.label).toBe("string");
      expect(display.label.length).toBeGreaterThan(0);
      expect(typeof display.colorVar).toBe("string");
    }
  });
});
