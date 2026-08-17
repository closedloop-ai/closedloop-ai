import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";

const SESSIONS_RE = /2 sessions/;
const NO_SESSIONS_RE = /no sessions on this branch yet/i;
const NO_SESSION_ACTIVITY_RE = /no session activity/i;
const NO_MEASURABLE_DURATION_RE = /no measurable duration/i;
const NO_COST_ATTRIBUTED_RE = /no cost has been attributed yet/i;
const TWO_SESSIONS_RAN_RE = /2 sessions ran on this branch/;
const ONE_SESSION_RAN_RE = /^1 session ran on this branch/;
const NOT_TWO_SESSIONS_RE = /2 sessions?/;
const PR_TIMELINE_RE = /PR timeline/;
const WALL_CLOCK_LABEL_RE = /wall clock/i;
const TOKENS_RE = /tokens/i;
const CHRIS_UNAVAILABLE_RE = /Chris Unavailable/i;
const ALL_TIMING_UNAVAILABLE_RE = /Timing is unavailable for s1, s2/;
const SES_2_TIMING_UNAVAILABLE_RE = /Timing is unavailable for SES-2/;
const LATE_ACTIVITY_OMITTED_RE = /90-day timeline limit.*late-session/;
const LONG_RUNNING_ACTIVITY_OMITTED_RE = /90-day timeline limit.*long-running/;
const UNTIMED_TIMING_UNAVAILABLE_RE = /Timing is unavailable for untimed/;
const CHRIS_PARTIAL_COST_RE = /Chris \$5\.00\*/;

function bars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".bq-bar"));
}

// FEA-3576 — bars segment by the human user and size by cost, so fixtures carry
// `ownerUserName` + `estimatedCostUsd` rather than the old actor + token setup.
describe("BranchPrActivityTimeline (E1, per-user cost)", () => {
  it("renders one bar per clock-hour with gaps, plus a session-count header", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 2,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T13:00:00.000Z",
          endedAt: "2026-06-10T14:00:00.000Z",
          estimatedCostUsd: 1,
          ownerUserName: "Chris",
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    // Hours 10, 11, 12, 13 → 4 columns; 11 and 12 are synthesized gaps.
    expect(bars(container)).toHaveLength(4);
    expect(container.querySelectorAll('.bq-bar[data-gap="true"]')).toHaveLength(
      2
    );
    expect(screen.getByText(SESSIONS_RE)).toBeInTheDocument();
    expect(screen.getByText("240m 0s")).toBeInTheDocument();
    expect(screen.queryByText(WALL_CLOCK_LABEL_RE)).not.toBeInTheDocument();
  });

  it("renders a single color when every session shares one user", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          ownerUserName: "Chris",
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    const keys = new Set(
      Array.from(container.querySelectorAll("[data-actor-key]")).map((el) =>
        el.getAttribute("data-actor-key")
      )
    );
    expect(keys.size).toBe(1);
  });

  it("renders canonical attributed cost while retaining raw estimated cost for compatibility", () => {
    const detail = makeBranchDetail({
      additions: 100,
      attributedCostUsd: 25,
      estimatedCostUsd: 100,
      sessions: [
        makeBranchSession({
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
          evenSplitCostUsd: 25,
          ownerUserName: "Chris",
        }),
      ],
    });

    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    const stats = container.querySelector(".bq-stats");
    expect(stats).toHaveTextContent("$25.00");
    expect(stats).not.toHaveTextContent("$100.00");
    expect(stats).toHaveTextContent("LOC/$");
  });

  it("does not fall back from explicit null or zero attributed cost", () => {
    const session = makeBranchSession({
      startedAt: "2026-06-10T10:00:00.000Z",
      endedAt: "2026-06-10T11:00:00.000Z",
      estimatedCostUsd: 100,
    });
    const { container, rerender } = render(
      <BranchPrActivityTimeline
        detail={makeBranchDetail({
          attributedCostUsd: null,
          estimatedCostUsd: 100,
          sessions: [session],
        })}
      />
    );
    expect(container.querySelector(".bq-stats")).toHaveTextContent(
      "Unavailablecost"
    );

    rerender(
      <BranchPrActivityTimeline
        detail={makeBranchDetail({
          attributedCostUsd: 0,
          estimatedCostUsd: 100,
          sessions: [session],
        })}
      />
    );
    const stats = container.querySelector(".bq-stats");
    expect(stats).toHaveTextContent("$0.00");
    expect(stats).not.toHaveTextContent("$100.00");
  });

  it("concurrency-marks an hour with two distinct users (colored + sized by cost)", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: 10,
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 6,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 4,
          ownerUserName: "Thadeus",
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    const concurrent = container.querySelector(
      '.bq-bar[data-concurrent="true"]'
    );
    expect(concurrent).not.toBeNull();
    const segments =
      concurrent?.querySelectorAll<HTMLElement>("[data-actor-key]");
    expect(segments).toHaveLength(2);
    // Legacy display-name identities are normalized to the same keys as the
    // actor color domain; heights remain proportional to cost (60% / 40%).
    expect(
      Array.from(segments ?? []).map((el) => el.getAttribute("data-actor-key"))
    ).toEqual(["legacy:chris", "legacy:thadeus"]);
    expect(segments?.[0]?.style.height).toBe("60%");
    expect(segments?.[1]?.style.height).toBe("40%");
  });

  it("uses the rendered subtotal when Branch-level cost is unavailable", () => {
    const detail = makeBranchDetail({
      additions: 60,
      deletions: 0,
      estimatedCostUsd: null,
      sessions: [
        makeBranchSession({
          sessionId: "priced-session",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 6,
          ownerUserName: "Chris",
        }),
      ],
    });

    render(<BranchPrActivityTimeline detail={detail} />);

    expect(screen.getByText("$6.00")).toBeInTheDocument();
    expect(screen.getByText("—", { exact: true })).toBeInTheDocument();
  });

  it("renders the standalone empty state when there are no sessions", () => {
    render(
      <BranchPrActivityTimeline detail={makeBranchDetail({ sessions: [] })} />
    );
    expect(screen.getByText(NO_SESSIONS_RE)).toBeInTheDocument();
  });

  // FEA-4269 — a branch with linked sessions + a non-empty merged transcript
  // whose session timing forms no positive-duration burst (zero-duration
  // imported timing) produces ZERO cost columns. The timeline must NOT then
  // claim "No session activity captured" above the full trace; it keeps the
  // section + stats and shows the honest timing-specific message instead.
  it("does NOT show the no-activity empty state when sessions and a transcript are linked but timing yields no bucketizable duration (FEA-4269)", () => {
    // startedAt === endedAt and every trace item shares that instant, so no
    // burst span forms → buildSessionTimeline returns zero columns, exactly the
    // production repro (merged PR + non-empty trace + zero-duration sessions).
    const instant = "2026-06-10T10:00:00.000Z";
    const detail = makeBranchDetail({
      // A merged-PR fixture with CONSISTENT linked sessions: `sessionIds` names
      // the same two session rows carried in `sessions` (shafty023 flagged the
      // prior fixture as internally inconsistent — `sessionIds` disagreed with
      // `sessions` and it was not marked merged despite the "merged PR" comment).
      status: BranchStatus.Merged,
      prState: "MERGED",
      prNumber: 3835,
      mergedAt: "2026-06-10T12:00:00.000Z",
      estimatedCostUsd: 34.45,
      sessionIds: ["s1", "s2"],
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: instant,
          endedAt: instant,
          estimatedCostUsd: 12,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: instant,
          endedAt: instant,
          estimatedCostUsd: 22,
          ownerUserName: "Thadeus",
        }),
      ],
      mergedTrace: [
        {
          type: "sessionstart",
          sessionId: "s1",
          t: instant,
          actor: { name: "Chris", harness: "claude" },
        },
        {
          type: "prompt",
          sessionId: "s1",
          t: instant,
          tMs: Date.parse(instant),
          cumCostUsd: null,
          actorName: "Chris",
          text: "kick off the work",
        },
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    // The zero-duration timing means no cost bars can be drawn …
    expect(bars(container)).toHaveLength(0);
    // … but the branch DID have sessions, so the misleading absence claim is
    // never rendered.
    expect(screen.queryByText(NO_SESSION_ACTIVITY_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_SESSIONS_RE)).not.toBeInTheDocument();
    // The cause is TIMING, not pricing (the branch is priced $34.45), so the
    // message names the actual reason instead of promising a pricing fix
    // (Threads 0/1).
    expect(screen.getByText(NO_MEASURABLE_DURATION_RE)).toBeInTheDocument();
    expect(screen.queryByText(NO_COST_ATTRIBUTED_RE)).not.toBeInTheDocument();
    expect(screen.getByText(TWO_SESSIONS_RAN_RE)).toBeInTheDocument();
    // The section chrome survives, while the chartable cost and duration are
    // unavailable rather than fabricating $0 or presenting the full Branch cost
    // as if the absent bars reconciled to it.
    expect(screen.getByText(PR_TIMELINE_RE)).toBeInTheDocument();
    expect(screen.getByText("cost", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(container.textContent).not.toContain("$34.45");
    expect(screen.getByText(ALL_TIMING_UNAVAILABLE_RE)).toBeInTheDocument();
  });

  it("stars the chartable subtotal and names a loaded non-bucketable Session without changing LOC/$", () => {
    const detail = makeBranchDetail({
      additions: 120,
      deletions: 0,
      estimatedCostUsd: 12,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          slug: "SES-1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 5,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "s2",
          slug: "SES-2",
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 7,
          ownerUserName: "Thadeus",
        }),
      ],
    });

    const { container } = render(<BranchPrActivityTimeline detail={detail} />);

    expect(bars(container)).toHaveLength(1);
    const chartableCost = screen.getByText("$5.00*");
    expect(chartableCost).toHaveAccessibleDescription(
      SES_2_TIMING_UNAVAILABLE_RE
    );
    expect(screen.getByText("60m 0s*")).toHaveAccessibleDescription(
      SES_2_TIMING_UNAVAILABLE_RE
    );
    expect(screen.getByText("10", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("10*", { exact: true })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("$12.00");
  });

  it("stars the rendered subtotal when the global timeline cap omits a later Session", () => {
    const detail = makeBranchDetail({
      additions: 120,
      deletions: 0,
      estimatedCostUsd: 12,
      sessions: [
        makeBranchSession({
          sessionId: "early",
          slug: "early-session",
          startedAt: "2026-01-01T10:00:00.000Z",
          endedAt: "2026-01-01T11:00:00.000Z",
          estimatedCostUsd: 5,
        }),
        makeBranchSession({
          sessionId: "late",
          slug: "late-session",
          startedAt: "2026-05-01T10:00:00.000Z",
          endedAt: "2026-05-01T11:00:00.000Z",
          estimatedCostUsd: 7,
        }),
      ],
    });

    const { container } = render(
      <BranchPrActivityTimeline detail={detail} onScrubHour={vi.fn()} />
    );

    expect(screen.getByText("$5.00*")).toHaveAccessibleDescription(
      LATE_ACTIVITY_OMITTED_RE
    );
    expect(screen.getByText("129600m 0s*")).toHaveAccessibleDescription(
      LATE_ACTIVITY_OMITTED_RE
    );
    expect(screen.getByText("10", { exact: true })).toBeInTheDocument();
    expect(container.textContent).not.toContain("$12.00");
  });

  it("stars the rendered portion when one Session exceeds the timeline cap", () => {
    const detail = makeBranchDetail({
      additions: 1000,
      deletions: 0,
      estimatedCostUsd: 100,
      sessions: [
        makeBranchSession({
          sessionId: "long-running",
          slug: "long-running",
          startedAt: "2026-01-01T10:00:00.000Z",
          endedAt: "2026-04-11T10:00:00.000Z",
          estimatedCostUsd: 100,
        }),
      ],
    });

    const { container } = render(
      <BranchPrActivityTimeline detail={detail} onScrubHour={vi.fn()} />
    );

    expect(screen.getByText("$90.00*")).toHaveAccessibleDescription(
      LONG_RUNNING_ACTIVITY_OMITTED_RE
    );
    expect(screen.getByText("129600m 0s*")).toHaveAccessibleDescription(
      LONG_RUNNING_ACTIVITY_OMITTED_RE
    );
    expect(screen.getByText("10", { exact: true })).toBeInTheDocument();
    expect(container.textContent).not.toContain("$100.00");
  });

  it("keeps a known subtotal when priced and unpriced activity share an owner-hour", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 8,
      sessions: [
        makeBranchSession({
          sessionId: "priced",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 5,
          evenSplitCostUsd: 5,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "unpriced",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: null,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "untimed",
          slug: "",
          name: " ",
          navigableRef: "",
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 3,
        }),
      ],
    });

    const { container } = render(
      <BranchPrActivityTimeline detail={detail} onScrubHour={vi.fn()} />
    );

    const chartableCost = screen.getByText("$5.00*");
    expect(chartableCost).toHaveAccessibleDescription(
      UNTIMED_TIMING_UNAVAILABLE_RE
    );
    expect(bars(container)[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(CHRIS_PARTIAL_COST_RE)
    );
  });

  it("renders unavailable-cost activity as an active bar aligned with the playhead", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          // Un-priced session: real activity but no attributable cost.
          estimatedCostUsd: null,
          ownerUserName: "Chris",
          inputTokens: 500,
        }),
      ],
    });
    const { container } = render(
      <BranchPrActivityTimeline
        activeHourStart="2026-06-10T10:00:00.000Z"
        detail={detail}
        onScrubHour={vi.fn()}
      />
    );
    expect(bars(container)).toHaveLength(1);
    expect(bars(container)[0]).toHaveClass("hot");
    expect(bars(container)[0]).not.toHaveAttribute("data-gap");
    expect(bars(container)[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(CHRIS_UNAVAILABLE_RE)
    );
    expect(
      screen.queryByText(NO_MEASURABLE_DURATION_RE)
    ).not.toBeInTheDocument();
    expect(screen.getByText(PR_TIMELINE_RE)).toBeInTheDocument();
  });

  it("still renders real cost bars when only SOME hours are un-priced (gaps stay honest)", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 4,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T13:00:00.000Z",
          endedAt: "2026-06-10T14:00:00.000Z",
          // Unavailable-cost activity in a later hour remains an active mark.
          estimatedCostUsd: null,
          ownerUserName: "Chris",
        }),
      ],
    });
    const { container } = render(<BranchPrActivityTimeline detail={detail} />);
    // Hours 10..13 render as bars; the priced hour has a real segment.
    expect(bars(container).length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-actor-key]").length).toBe(2);
    const activityOnlySegment = bars(container)
      .at(-1)
      ?.querySelector<HTMLElement>("[data-actor-key]");
    expect(
      Number.parseFloat(activityOnlySegment?.style.height ?? "0")
    ).toBeGreaterThan(0);
  });

  it("labels the tooltip's token split as TOKENS so it isn't read as sub-costs of the dollar figure", async () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          ownerUserName: "Chris",
          inputTokens: 1_200_000,
        }),
      ],
    });
    const { container } = render(
      <BranchPrActivityTimeline detail={detail} onScrubHour={vi.fn()} />
    );
    const [bar] = bars(container);
    await userEvent.hover(bar as HTMLElement);
    // The token section carries an explicit unit caption (Thread B: the dollar
    // header and the token split are two different units in one card).
    const label = document.querySelector(".bq-tip-splitlabel");
    expect(label?.textContent).toMatch(TOKENS_RE);
    // And the token value is a compacted token count, not a dollar figure.
    expect(document.body.textContent).toContain("1.2M");
  });

  it("carries an hour bucket at the k ceiling up to 1M rather than the invalid 1000k tier", async () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          ownerUserName: "Chris",
          // ISS-5746: 999_950 tokens is 999.95k, which rounds to "1000.0k" at
          // 1dp — the tier has to carry with the rounding. The other two rows
          // pin the tier below it (1dp, not whole-k) and the dash an empty
          // split keeps instead of a real zero.
          inputTokens: 999_950,
          outputTokens: 1500,
        }),
      ],
    });
    const { container } = render(
      <BranchPrActivityTimeline detail={detail} onScrubHour={vi.fn()} />
    );
    const [bar] = bars(container);
    await userEvent.hover(bar as HTMLElement);
    const splitValues = Array.from(
      document.querySelectorAll(".bq-tip-spv")
    ).map((node) => node.textContent);
    expect(splitValues).toEqual(["1M", "1.5k", "—"]);
  });

  it("clears a keyboard-opened tooltip when its timeline bar loses focus", async () => {
    const user = userEvent.setup();
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          ownerUserName: "Chris",
        }),
      ],
    });
    const { container } = render(
      <BranchPrActivityTimeline detail={detail} onScrubHour={vi.fn()} />
    );
    const [bar] = bars(container);
    if (!bar) {
      throw new Error("Expected a focusable timeline bar");
    }

    await user.tab();
    expect(bar).toHaveFocus();
    expect(document.querySelector(".bq-tip")).toBeInTheDocument();

    await user.tab();
    expect(bar).not.toHaveFocus();
    expect(document.querySelector(".bq-tip")).not.toBeInTheDocument();
  });

  it("shows a defensible starred LOC/$ value for incomplete trace evidence", () => {
    const detail = makeBranchDetail({
      additions: 20,
      attributedCostUsd: 5,
      estimatedCostUsd: 10,
      deletions: 0,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 4,
          evenSplitCostUsd: 2,
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T13:00:00.000Z",
          estimatedCostUsd: 6,
          evenSplitCostUsd: 3,
        }),
      ],
    });
    render(
      <BranchPrActivityTimeline
        detail={detail}
        traceState={{
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Incomplete,
          },
          completeness: { state: BranchTraceCompletenessState.Incomplete },
          qualifyingSessionCount: 2,
          sessions: [
            {
              identity: {
                artifactId: "s1",
                name: "Loaded Session",
                navigableRef: "SES-1",
                slug: "SES-1",
              },
              state: BranchTraceSessionHydrationState.Loaded,
            },
            {
              identity: {
                artifactId: "s2",
                name: "Unavailable Session",
                navigableRef: "SES-2",
                slug: "SES-2",
              },
              reason: BranchTraceUnavailableReason.Permission,
              state: BranchTraceSessionHydrationState.Unavailable,
            },
          ],
        }}
      />
    );

    expect(screen.getByText("$2.00*")).toBeInTheDocument();
    expect(screen.getByText("10*")).toBeInTheDocument();
    expect(screen.getByText("LOC/$")).toBeInTheDocument();
  });

  // FEA-4269 review (wongk) — a branch can carry the SAME session as multiple
  // rows (one per PR link). The bars already dedup by `sessionId`, so the
  // "N sessions" message must derive its count from DISTINCT ids too, or a single
  // zero-duration session repeated across two links falsely reads as "2 sessions".
  it("counts DISTINCT sessions (not raw rows) in the no-bars message when one session is linked twice (FEA-4269)", () => {
    const instant = "2026-06-10T10:00:00.000Z";
    // The SAME zero-duration session (same sessionId) appears in TWO rows — the
    // two-PR-link duplication. Every duplicate row carries identical session-level
    // fields, matching the production shape.
    const duplicatedSession = {
      sessionId: "s1",
      startedAt: instant,
      endedAt: instant,
      estimatedCostUsd: 5,
      ownerUserName: "Chris",
    };
    const detail = makeBranchDetail({
      estimatedCostUsd: 5,
      sessions: [
        makeBranchSession(duplicatedSession),
        makeBranchSession(duplicatedSession),
      ],
    });
    render(<BranchPrActivityTimeline detail={detail} />);
    // The distinct count is 1, so the message says "1 session ran…", never the
    // raw-row-count "2 sessions".
    expect(screen.getByText(ONE_SESSION_RAN_RE)).toBeInTheDocument();
    expect(screen.queryByText(NOT_TWO_SESSIONS_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(TWO_SESSIONS_RAN_RE)).not.toBeInTheDocument();
  });

  it("fires onScrubHour with the bar's hour and highlights the active bar", async () => {
    const onScrubHour = vi.fn();
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          ownerUserName: "Chris",
        }),
      ],
    });
    const { container } = render(
      <BranchPrActivityTimeline
        activeHourStart="2026-06-10T10:00:00.000Z"
        detail={detail}
        onScrubHour={onScrubHour}
      />
    );
    const [bar] = bars(container);
    expect(bar?.className).toContain("hot");
    await userEvent.click(bar as HTMLElement);
    expect(onScrubHour).toHaveBeenCalledWith("2026-06-10T10:00:00.000Z");
  });
});
