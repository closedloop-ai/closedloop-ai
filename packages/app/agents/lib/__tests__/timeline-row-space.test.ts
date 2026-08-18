import type { TurnItem } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  buildTraceRowTranslators,
  transcriptIdentitiesMatch,
  translateRenderedRowToTrace,
  translateTraceRowToRendered,
} from "../timeline-row-space";
import {
  idlessSay,
  promptRow,
  sayRow,
  subagentGroupAt,
  subagentGroupUntimed,
  subagentRow,
  subagentToolGroup,
  subagentWithEventId,
  toolsRow,
  untimedSay,
} from "./timeline-row-space-fixtures";

// The staged strong-id → group-tag matching, the reference-equality no-op, the
// reverse "you are here" translation, and the skeleton gate. The nearest-time
// fallback and its plausibility/tie/epoch/subagent-file guards live in the
// sibling `timeline-row-space-nearest-time.test.ts` (FEA-4252 split-by-concern).

describe("translateTraceRowToRendered (FEA-4252)", () => {
  // The Session Timeline computes jump rows from the DB projection
  // (`session.turnItems`), while the web trace renders the parsed cloud
  // transcript. Both carry the SAME `transcriptIdentity` per logical turn, but
  // the cloud projection here holds an extra leading row that shifts every
  // shared turn by one — the divergence that made a timeline click land on the
  // wrong turn.
  const dbRows: TurnItem[] = [
    promptRow(0, "turn-1", "first prompt"),
    toolsRow(1, "toolu_a", "2026-07-09T10:00:01.000Z"),
    subagentRow(2, "agent-native-1"),
  ];
  const renderedRows: TurnItem[] = [
    // Extra assistant preamble the cloud parser kept but the DB projection
    // dropped, pushing the shared turns down by one row.
    sayRow(0, "cloud-preamble"),
    promptRow(1, "turn-1", "first prompt"),
    toolsRow(2, "toolu_a", "2026-07-09T10:00:01.000Z"),
    subagentRow(3, "agent-native-1"),
  ];

  it("maps each timeline (DB) row to the rendered row that owns the same identity", () => {
    expect(translateTraceRowToRendered(0, dbRows, renderedRows)).toBe(1);
    // A DIFFERENT target than the prompt, proving the translation is per-turn.
    expect(translateTraceRowToRendered(1, dbRows, renderedRows)).toBe(2);
    expect(translateTraceRowToRendered(2, dbRows, renderedRows)).toBe(3);
  });

  it("matches a tools turn by an inner tool's provider id, not only the turn identity", () => {
    const dbToolByInner: TurnItem[] = [toolsRow(0, "toolu_x", null)];
    const renderedToolByInner: TurnItem[] = [
      sayRow(0, "preamble"),
      toolsRow(9, "toolu_x", null),
    ];
    expect(
      translateTraceRowToRendered(0, dbToolByInner, renderedToolByInner)
    ).toBe(9);
  });

  it("is the identity when the two projections coincide (desktop / aligned web)", () => {
    expect(translateTraceRowToRendered(1, dbRows, dbRows)).toBe(1);
    const sameShape = dbRows.map((row) => ({ ...row }));
    expect(translateTraceRowToRendered(2, dbRows, sameShape)).toBe(2);
  });

  it("falls back to the nearest-time rendered row when no identity is shared (FEA-4252)", () => {
    // The clicked subagent turn (10:00:02) has no identity counterpart in a
    // partial cloud trace, but the two projections still share real timestamps.
    // The nearest-time fallback lands on the closest rendered turn so the click
    // scrolls SOMEWHERE sensible — never nothing (the bug: identity-only returned
    // null, and the caller then skipped the jump so the trace never moved).
    const partial: TurnItem[] = [
      sayRow(0, "early"), // 10:00:00.500
      subagentRow(1, "unrelated-agent"), // 10:00:02.000 — nearest to the click
    ];
    expect(translateTraceRowToRendered(2, dbRows, partial)).toBe(1);
  });

  it("does NOT trust equal length as alignment when identity misses (divergent same-length projections)", () => {
    // Equal item counts do not imply aligned `_row` values: the cloud parser keeps
    // a leading preamble the DB projection dropped AND drops a trailing DB event
    // the parser missed, so the two projections stay the SAME length (3 == 3) while
    // every shared turn is shifted down by one row. No identity is shared (the two
    // pipelines mint different ids), so an equal-length shortcut would return the
    // untranslated `sourceRow` and scroll to an unrelated turn (or a nonexistent
    // `data-row`). Timestamps still discriminate, so the click must resolve via
    // nearest-time — landing on the RIGHT rendered row, not the coincidentally
    // same-numbered one.
    const source: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.000Z", 0), // turn A
      idlessSay(1, "2026-07-09T10:10:00.000Z", 1), // turn B (the clicked turn)
      idlessSay(2, "2026-07-09T10:20:00.000Z", 2), // turn C (dropped from rendered)
    ];
    const rendered: TurnItem[] = [
      idlessSay(0, "2026-07-09T09:50:00.000Z", 7), // cloud-only preamble
      idlessSay(1, "2026-07-09T10:00:05.000Z", 8), // turn A -> rendered row 1
      idlessSay(2, "2026-07-09T10:10:05.000Z", 9), // turn B -> rendered row 2
    ];
    // With the (removed) equal-length shortcut these would each return the raw
    // sourceRow (0, 1), landing on the preamble / the wrong turn. Nearest-time
    // correctly shifts them to the rendered rows that own the same instant.
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
    expect(translateTraceRowToRendered(1, source, rendered)).toBe(2);
    // Turn C has no rendered counterpart; its nearest instant is still rendered
    // row 2 (~9m55s away, inside the plausibility bound), so the click scrolls to
    // the closest surviving turn rather than a phantom row 2 that (here) happens
    // to exist but belongs to turn B.
    expect(translateTraceRowToRendered(2, source, rendered)).toBe(2);
  });

  it("returns null only when the rendered trace has no landable row at all", () => {
    // A genuinely empty rendered projection (skeleton) has nothing to scroll to,
    // so the caller still correctly skips the jump.
    expect(translateTraceRowToRendered(2, dbRows, [])).toBe(null);
  });

  it("prefers a strong producer id over a NEARER-in-time non-identity row", () => {
    // The strong-id target must win even when a DIFFERENT rendered row is closer
    // in time to the click — proving strong-id matching runs first and is not a
    // no-op that nearest-time could stand in for. The clicked subagent (10:00:02,
    // eventId evt-real) has its identity twin at rendered row 2 (also 10:00:02);
    // a decoy at rendered row 1 (10:00:01.900, no shared id) sits 100ms closer.
    // If strong-id matching were removed or reordered behind nearest-time, the
    // decoy (row 1) would win — so landing on row 2 isolates the strong-id branch.
    const source: TurnItem[] = [subagentWithEventId(0, "grp-1", "evt-real")];
    const rendered: TurnItem[] = [
      subagentToolGroup(0, "grp-1"),
      idlessSay(1, "2026-07-09T10:00:01.900Z", 5), // 100ms closer, no strong id
      subagentWithEventId(2, "grp-1", "evt-real"), // 10:00:02 — the identity twin
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(2);
  });

  it("prefers a strong producer id over an earlier externalAgentId group match", () => {
    // The projection copies `externalAgentId` onto every tool owned by a
    // subagent, so an earlier tool group can carry the same group tag as the
    // real target. A strong per-turn id (here the subagent's eventId) must win
    // over that earlier group-tag row rather than binding to it.
    const source: TurnItem[] = [subagentWithEventId(0, "grp-1", "evt-real")];
    const rendered: TurnItem[] = [
      subagentToolGroup(0, "grp-1"),
      subagentWithEventId(1, "grp-1", "evt-real"),
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
  });

  it("runs nearest-time BEFORE the group tag so a same-subagent earlier row cannot win", () => {
    // A failed subagent shares its `externalAgentId` with an EARLIER tool row it
    // owned (before the failed retry). With no strong id, a group-tag-before-time
    // order would bind the click to that earlier tool row and never reach
    // nearest-time. The clicked turn's real instant is far from the earlier row
    // and close to the later one, so time must win: the jump lands on the row that
    // shares the instant, not the earlier same-group tool row.
    const source: TurnItem[] = [subagentGroupAt(0, "grp-1", "10:30:00")];
    const rendered: TurnItem[] = [
      subagentGroupAt(0, "grp-1", "10:00:00"), // earlier same-subagent tool row
      idlessSay(1, "2026-07-09T10:29:55.000Z", 3), // ≈ the clicked instant, no tag
    ];
    // Group tag alone would pick row 0; nearest-time (running first) picks row 1.
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
  });

  it("still uses the group tag when no strong id AND no usable timestamp resolve", () => {
    // Strip timestamps so nearest-time yields null; the group tag is then the only
    // signal left and a same-subagent row still beats skipping the jump entirely.
    const source: TurnItem[] = [subagentGroupUntimed(0, "grp-9")];
    const rendered: TurnItem[] = [
      untimedSay(0, "preamble"),
      subagentGroupUntimed(1, "grp-9"),
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
  });

  it("falls back to an externalAgentId group tag only when no stronger id matches", () => {
    const source: TurnItem[] = [subagentRow(0, "agent-native-1")];
    const rendered: TurnItem[] = [
      sayRow(0, "preamble"),
      subagentRow(1, "agent-native-1"),
    ];
    expect(translateTraceRowToRendered(0, source, rendered)).toBe(1);
  });
});

describe("translateRenderedRowToTrace (FEA-4252 'you are here')", () => {
  const dbRows: TurnItem[] = [
    promptRow(0, "turn-1", "first prompt"),
    toolsRow(1, "toolu_a", "2026-07-09T10:00:01.000Z"),
  ];
  const renderedRows: TurnItem[] = [
    sayRow(0, "cloud-preamble"),
    promptRow(1, "turn-1", "first prompt"),
    toolsRow(2, "toolu_a", "2026-07-09T10:00:01.000Z"),
  ];

  it("maps a rendered active row back into the source (bucket tl0) space", () => {
    // The scroll handler reports rendered row 2 (the tools turn); the timeline
    // marker needs source row 1 so it lands on the same turn's bucket.
    expect(translateRenderedRowToTrace(2, dbRows, renderedRows)).toBe(1);
    expect(translateRenderedRowToTrace(1, dbRows, renderedRows)).toBe(0);
  });

  it("maps a cloud-only row back to its nearest-time source turn", () => {
    // A cloud-only row that shares no identity with any DB turn but sits strictly
    // closest to the prompt (10:00:00.000) resolves to source row 0, so the "you
    // are here" marker still lands on a sensible turn instead of vanishing. The
    // preamble is placed 200ms from the prompt and 800ms from the tools turn so
    // the prompt is the UNAMBIGUOUS nearest (not an equidistant tie).
    const cloudOnly: TurnItem[] = [
      idlessSay(0, "2026-07-09T10:00:00.200Z", 4),
      promptRow(1, "turn-1", "first prompt"),
      toolsRow(2, "toolu_a", "2026-07-09T10:00:01.000Z"),
    ];
    expect(translateRenderedRowToTrace(0, dbRows, cloudOnly)).toBe(0);
  });

  it("keeps the rendered row when no source turn carries a usable timestamp", () => {
    // With no landable/timed source rows the nearest-time fallback yields null,
    // so the marker falls back to the rendered row rather than jumping to 0.
    const untimedSource: TurnItem[] = [{ type: "end", text: "done" }];
    expect(translateRenderedRowToTrace(2, untimedSource, renderedRows)).toBe(2);
  });
});

describe("transcriptIdentitiesMatch (FEA-4252 staged matching)", () => {
  it("matches on a shared strong producer id", () => {
    expect(
      transcriptIdentitiesMatch(
        { eventId: "e1" },
        { eventId: "e1", providerToolUseId: "t9" }
      )
    ).toBe(true);
  });

  it("matches on exact timestamp + ordinal when no strong id is present", () => {
    expect(
      transcriptIdentitiesMatch(
        { timestamp: "2026-07-09T10:00:01.000Z", timestampOrdinal: 2 },
        { timestamp: "2026-07-09T10:00:01.000Z", timestampOrdinal: 2 }
      )
    ).toBe(true);
    expect(
      transcriptIdentitiesMatch(
        { timestamp: "2026-07-09T10:00:01.000Z", timestampOrdinal: 2 },
        { timestamp: "2026-07-09T10:00:01.000Z", timestampOrdinal: 3 }
      )
    ).toBe(false);
  });

  it("does not treat two undefined id fields as a match", () => {
    expect(transcriptIdentitiesMatch({ eventId: undefined }, {})).toBe(false);
  });
});

describe("buildTraceRowTranslators (FEA-4252 skeleton gate)", () => {
  const dbRows: TurnItem[] = [promptRow(0, "turn-1", "first prompt")];

  it("reports hasRenderedRows=false while the rendered trace is empty", () => {
    // A skeleton trace has no `[data-row]` to land on; the timeline disables its
    // bars/dots rather than promise navigation it cannot perform.
    expect(buildTraceRowTranslators(dbRows, []).hasRenderedRows).toBe(false);
  });

  it("reports hasRenderedRows=true once the trace has rows", () => {
    expect(buildTraceRowTranslators(dbRows, dbRows).hasRenderedRows).toBe(true);
  });
});
