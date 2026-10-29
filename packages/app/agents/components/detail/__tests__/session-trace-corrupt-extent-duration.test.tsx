/**
 * ISS-8767 (#6809 review) — a refused `tools` extent must not print a duration.
 *
 * The shared fold repaired the IDLE half: `mergedTraceItemEndMs` refuses an
 * impossible `endMs`, so later idle markers survive. It could not repair the
 * ROW: `buildMergedTrace` returns the tool item unchanged, the branch adapter
 * forwards `endMs`, and `TraceMessageRow` prints `group.endMs - group.startMs`.
 * A nanosecond stamp handed over as milliseconds therefore rendered as a
 * confident multi-million-year tool duration on a trace whose pauses had
 * already been fixed — a fabricated measurement, which the repo's bad-data rule
 * puts below no measurement at all.
 *
 * The load-bearing pair is both arms on the SAME scenario: the healthy run
 * prints its real duration, so the corrupt arm's absence is a value proven to
 * render being withheld, not a selector that never matched.
 */
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTrace } from "../session-trace";
import type { SessionTraceItem } from "../session-trace-groups";
import { withProviders } from "./agent-session-detail-view.test-helpers";

const START_ISO = "2026-06-10T09:00:00.000Z";
const START_MS = Date.parse(START_ISO);
const HEALTHY_RUN_MS = 240_000;
const TOOL_SUMMARY = "3 migration tools";

/** The realistic shape of a corrupt extent: a nanosecond stamp read as ms. */
const NANOSECOND_STAMP_AS_MS = START_MS * 1_000_000;

describe("a refused tool extent renders no duration rather than a fabricated one", () => {
  it("prints the duration of a run whose extent is trustworthy", () => {
    render(
      withProviders(
        <SessionTrace items={[toolsTurn(START_MS + HEALTHY_RUN_MS)]} />
      )
    );

    expect(screen.getByText(TOOL_SUMMARY)).toBeInTheDocument();
    expect(
      screen.getByText(formatDurationMs(HEALTHY_RUN_MS))
    ).toBeInTheDocument();
  });

  it("prints no duration for a run whose extent was refused", () => {
    render(
      withProviders(
        <SessionTrace items={[toolsTurn(NANOSECOND_STAMP_AS_MS)]} />
      )
    );

    // The run itself still renders: the extent is refused, not the item.
    expect(screen.getByText(TOOL_SUMMARY)).toBeInTheDocument();
    // The specific lie, named — so a regression reads as the wrong duration
    // rather than as a row that merely failed to appear.
    expect(
      screen.queryByText(formatDurationMs(NANOSECOND_STAMP_AS_MS - START_MS))
    ).not.toBeInTheDocument();
    expect(screen.queryByText(DURATION_PATTERN)).not.toBeInTheDocument();
  });
});

/** Any `Xm Ys` / `X.Ys` gutter duration, so no fabricated span can slip past. */
const DURATION_PATTERN = /^\d+m \d+s$|^\d+\.\d+s$/;

function toolsTurn(endMs: number): SessionTraceItem {
  return {
    type: "tools",
    _row: 0,
    t: START_ISO,
    tMs: START_MS,
    endMs,
    cum: 0,
    actor: {
      name: "gpt-5.5",
      sessionId: "corrupt-extent-session",
      human: null,
      color: "var(--primary)",
      harness: "codex",
    },
    summary: TOOL_SUMMARY,
    items: [{ label: "bash", detail: "pnpm migrate", err: false }],
    hasFail: false,
    failN: 0,
    cats: { bash: 1 },
  };
}
