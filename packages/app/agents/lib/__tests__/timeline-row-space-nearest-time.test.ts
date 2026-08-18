import type { TurnItem } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { translateTraceRowToRendered } from "../timeline-row-space";
import {
  epochSentinelSay,
  idlessSay,
  promptRow,
  subagentWithEventId,
} from "./timeline-row-space-fixtures";

// The nearest-time fallback and its guards, split from the staged-matching suite
// (`timeline-row-space.test.ts`) so each ordered-fallback concern stays reviewable
// (FEA-4252). Nearest-time only runs when no strong id correlates the two
// divergent projections — the common web case — so these cover that it lands on
// the RIGHT rendered row and never mis-binds under stale/epoch/tie/subagent-file
// divergence.

describe("nearest-time fallback for a divergent web trace (FEA-4252 / FEA-3586)", () => {
  // The two projections mint their strong ids from DIFFERENT pipelines, so on a
  // real web session almost no turn shares an identity. Before the fallback, a
  // dot/column click on any such turn resolved to null and scrolled NOWHERE
  // (Mike: "neither the dots nor the columns scroll to the proper place"). These
  // sessions run for hours, so the clicked turn is often well past the first
  // hour — the exact FEA-3586 territory where the wrong-row bug bit hardest.
  const sourceRows: TurnItem[] = [
    promptRow(0, "db-turn-1", "kick off"), // 10:00:00
    idlessSay(1, "2026-07-09T10:45:00.000Z", 0), // 45m in — id-less agent turn
    idlessSay(2, "2026-07-09T11:30:00.000Z", 1), // 90m in — PAST the first hour
    idlessSay(3, "2026-07-09T12:15:00.000Z", 2), // 135m in
  ];
  // The cloud parse assigns its OWN ids and inserts an extra leading turn, so no
  // id lines up and every ordinal is shifted — the exact divergence.
  const renderedRows: TurnItem[] = [
    idlessSay(0, "2026-07-09T09:59:30.000Z", 4), // cloud-only preamble
    idlessSay(1, "2026-07-09T10:00:02.000Z", 5), // ≈ source row 0
    idlessSay(2, "2026-07-09T10:44:50.000Z", 6), // ≈ source row 1
    idlessSay(3, "2026-07-09T11:29:40.000Z", 7), // ≈ source row 2 (past hour 1)
    idlessSay(4, "2026-07-09T12:14:30.000Z", 8), // ≈ source row 3
  ];

  it("resolves a click on a turn PAST the first hour to the right rendered row", () => {
    // Source row 2 is 90 minutes in — its nearest rendered row is 3, NOT the top
    // of the transcript (row 0) the old collapse-to-first bug produced.
    expect(translateTraceRowToRendered(2, sourceRows, renderedRows)).toBe(3);
  });

  it("resolves each divergent id-less turn to its own nearest rendered row", () => {
    expect(translateTraceRowToRendered(0, sourceRows, renderedRows)).toBe(1);
    expect(translateTraceRowToRendered(1, sourceRows, renderedRows)).toBe(2);
    expect(translateTraceRowToRendered(3, sourceRows, renderedRows)).toBe(4);
  });

  it("never returns null while the rendered trace has any landable row", () => {
    // Every source row resolves to a real rendered row — the click always scrolls.
    for (let row = 0; row < sourceRows.length; row++) {
      expect(
        translateTraceRowToRendered(row, sourceRows, renderedRows)
      ).not.toBeNull();
    }
  });
});

describe("nearest-time plausibility, tie, and epoch guards (FEA-4252)", () => {
  it("returns null on an equidistant tie rather than guessing the first row", () => {
    // Two rendered rows exactly as close as each other to the click: the nearest
    // instant is genuinely ambiguous, and picking the first could land one turn
    // off — the wrong-position bug FEA-4252 fixes. The per-projection ordinal is
    // meaningless across projections, so there is no principled tiebreak → null.
    const source: TurnItem[] = [idlessSay(0, "2026-07-09T10:00:05.000Z", 0)];
    const rendered: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 7), // 5s before
      idlessSay(1, "2026-07-09T10:00:10.000Z", 9), // 5s after — exact tie
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(null);
  });

  it("still resolves when one candidate is strictly nearer than the rest (no tie)", () => {
    const source: TurnItem[] = [idlessSay(0, "2026-07-09T10:00:09.000Z", 0)];
    const rendered: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 0), // 9s — far
      idlessSay(1, "2026-07-09T10:00:10.000Z", 1), // 1s — strictly nearest
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
  });

  it("returns null when the only candidate is implausibly far in time (stale missing-tail trace)", () => {
    // A stale cloud upload is missing the clicked turn's later tail, so the last
    // surviving rendered row is hours earlier. Nearest-time must NOT bind the click
    // to that far row — that is the wrong-position scroll FEA-4252 fixes. Beyond the
    // plausibility bound it returns null (the caller skips the jump) instead.
    const source: TurnItem[] = [idlessSay(0, "2026-07-09T14:00:00.000Z", 0)];
    const rendered: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 1), // 4h earlier — implausible
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(null);
  });

  it("still binds to a distant-but-within-bound neighbor of a dropped turn", () => {
    // A dropped turn's closest surviving neighbor is a few minutes off — inside the
    // plausibility bound — so the click still lands on the nearest real row rather
    // than skipping. This is the "closest neighbor" guarantee, not a far mis-bind.
    const source: TurnItem[] = [idlessSay(0, "2026-07-09T10:09:00.000Z", 0)];
    const rendered: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 1), // 9m earlier — within 10m bound
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(0);
  });

  it("treats a Unix-epoch sentinel timestamp as no usable time, not a 1970 instant", () => {
    // Some producers stamp a MISSING tool/subagent timestamp as epoch 0. Because
    // `Number.isFinite(0)` is true, an un-guarded nearest-time would treat the
    // sentinel as a real 1970 instant and bind the click to whatever rendered row
    // is closest to epoch. The source turn carries ONLY the epoch sentinel (no
    // strong id, no group tag), so with epoch correctly rejected there is no usable
    // signal and the translator skips the jump (null) rather than landing wrong.
    const source: TurnItem[] = [epochSentinelSay(0)];
    const rendered: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 1),
      idlessSay(1, "2026-07-09T10:05:00.000Z", 2),
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(null);
  });

  it("ignores a rendered row whose only timestamp is the epoch sentinel when correlating", () => {
    // The clicked turn has a real instant; a rendered epoch-sentinel row must not
    // masquerade as its nearest neighbor. The real rendered row (row 1) wins.
    const source: TurnItem[] = [idlessSay(0, "2026-07-09T10:00:03.000Z", 0)];
    const rendered: TurnItem[] = [
      epochSentinelSay(0), // sentinel — must be skipped, not treated as 1970
      idlessSay(1, "2026-07-09T10:00:05.000Z", 1), // the real nearest row
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
  });
});

describe("subagent-file scoping (FEA-4252 allowNearestTime)", () => {
  it("does not bind a root timeline click into a subagent sidechain via nearest-time", () => {
    // When the rendered trace is a subagent:{id} sidechain, the Session Timeline
    // stays keyed to the ROOT session.turnItems — a DIFFERENT conversation. Their
    // instants are unrelated, so a root prompt with no strong id must NOT nearest-
    // time onto whatever subagent row is closest in wall-clock time. With
    // allowNearestTime off only a file-agnostic strong id may bind; here the root
    // prompt shares none, so the translator correctly skips the jump.
    const rootClick: TurnItem[] = [idlessSay(0, "2026-07-09T10:00:01.000Z", 0)];
    const subagentTrace: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 1), // unrelated subagent row
    ];
    expect(
      translateTraceRowToRendered(0, rootClick, subagentTrace, {
        allowNearestTime: false,
      })
    ).toBe(null);
  });

  it("still binds a subagent-file click by a shared strong id even with nearest-time disabled", () => {
    // The one legitimate cross-file signal: a subagent summary row present in both
    // the root projection and the sidechain by a shared strong id. That still binds
    // with nearest-time off, so a strongly-identified turn is not lost.
    const source: TurnItem[] = [subagentWithEventId(0, "grp-1", "evt-shared")];
    const subagentTrace: TurnItem[] = [
      idlessSay(0, "2026-07-09T09:00:00.000Z", 1),
      subagentWithEventId(1, "grp-1", "evt-shared"),
    ];
    expect(
      translateTraceRowToRendered(0, source, subagentTrace, {
        allowNearestTime: false,
      })
    ).toBe(1);
  });
});
