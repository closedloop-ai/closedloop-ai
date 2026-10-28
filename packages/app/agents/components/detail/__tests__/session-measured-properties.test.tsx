import { TRACE_PREFIX_COUNTED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  SessionAutonomyProperty,
  SessionTokensProperty,
  SessionWorkProperty,
} from "../session-measured-properties";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5565: the session-detail Properties panel coerced absent counts to `0`.
 *
 * The headline case was Autonomy, whose list-vs-detail parity spec now lives on
 * the value (PLN-2169 M2: `values/__tests__/session-autonomy-value.test.tsx`,
 * with the row's one sentence pinned on `resolveSessionAutonomyExplanation`).
 * This file keeps the Tokens and Work rows, which still own their own empty
 * semantics and sentences, plus the proof that the Autonomy row mounts its
 * shared value and carries the value's sentence in its accessible name.
 */

const EM_DASH = "—";

function emptyGlyphElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.childElementCount === 0 && element.textContent?.trim() === EM_DASH
  );
}

/**
 * ISS-5581 code review: the reason used to live in a native `title` on the dash,
 * which is hover-only. It now rides `PropertyValue`'s `explanation` (ISS-4654) —
 * a focusable button whose accessible name ends with the sentence — so the
 * assertions below are about the ROW's accessible name, not a title attribute.
 *
 * Reads the sr-only TAIL rather than the whole button, because the row's VALUE
 * is in that name too: "310 tool calls" in the value would satisfy a
 * `not.toContain("tool calls")` check meant to prove the sentence does not name
 * that counter (ISS-5636).
 */
function explanationOf(container: HTMLElement): string {
  const trigger = container.querySelector("button");
  if (!trigger) {
    throw new Error("row did not render an explained (focusable) value");
  }
  const sentence = trigger.querySelector(".sr-only");
  if (!sentence) {
    throw new Error("explained value carried no accessible sentence");
  }
  return sentence.textContent ?? "";
}

describe("ISS-5565: the Tokens row degrades per counter", () => {
  it("collapses to one glyph when no token counter was recorded", () => {
    const session = createAgentSessionDetailFixture({
      tokensIn: null,
      tokensOut: null,
      cache: null,
      cacheWrite: null,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    // One shrug, not four, and emphatically not "0 in | 0 out".
    expect(emptyGlyphElements(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("0 in");
  });

  it("shows the counters it has and dashes only the ones it does not", () => {
    const session = createAgentSessionDetailFixture({
      tokensIn: 1234,
      tokensOut: 56,
      cache: null,
      cacheWrite: null,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    expect(container.textContent).toContain("1,234");
    expect(container.textContent).toContain("56");
    // Exactly the two unrecorded counters are dashed — a partially-recorded row
    // must not throw away the halves it does know.
    expect(emptyGlyphElements(container)).toHaveLength(2);
  });

  /**
   * ISS-5637: this pins the FLAG-OFF default, and only that. ISS-5565 wrote it
   * believing an unrecorded counter arrives as `null`, which made an all-zero
   * quadruple a measured zero — but neither producer can emit that null, so
   * these four zeros are what a session with NO token-usage rows renders, and
   * calling them measured is the defect ISS-5637 fixes. Behind
   * `session-tokens-recorded-honesty` the same fixture reads as one dash; see
   * `session-tokens-recorded-honesty.test.tsx`, which owns the flag-on
   * contract and the still-genuine per-counter measured zero.
   */
  it("keeps an all-zero quadruple reading as zeros while the gate is closed", () => {
    const session = createAgentSessionDetailFixture({
      tokensIn: 0,
      tokensOut: 0,
      cache: 0,
      cacheWrite: 0,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    expect(emptyGlyphElements(container)).toHaveLength(0);
    expect(container.textContent).toContain("0 in");
  });
});

describe("ISS-5581: a missing value's reason is reachable without a mouse", () => {
  it("puts the autonomy reason in the accessible name, not a hover-only title", () => {
    const session = createAgentSessionDetailFixture({ autonomy: null });
    const { container } = render(<SessionAutonomyProperty session={session} />);

    expect(explanationOf(container)).toContain(
      "Autonomy was not recorded for this session"
    );
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("names only the token counters that are actually missing", () => {
    const session = createAgentSessionDetailFixture({
      cache: null,
      cacheWrite: null,
      tokensIn: 100,
      tokensOut: 200,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    expect(explanationOf(container)).toContain(
      "Cache reads and cache writes were not recorded for this session"
    );
  });

  it("states the whole row once when no token counter was recorded", () => {
    const session = createAgentSessionDetailFixture({
      cache: null,
      cacheWrite: null,
      tokensIn: null,
      tokensOut: null,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    // Not four counter names strung together, and not the bare fragment "Not
    // recorded" that used to sit beside three full-sentence siblings.
    expect(explanationOf(container)).toContain(
      "Token counts were not recorded for this session"
    );
  });

  it("says nothing at all when every counter was recorded", () => {
    const session = createAgentSessionDetailFixture({
      cache: 1,
      cacheWrite: 2,
      tokensIn: 3,
      tokensOut: 4,
    });
    const { container } = render(<SessionTokensProperty session={session} />);

    // A fully-measured row is not a hedge, so it must not become a button with
    // an explanation appended to its name.
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("ISS-5565: the Work row stops inventing steering episodes", () => {
  it("dashes an unrecorded steering count instead of claiming zero steers", () => {
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: null,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    // "0 steers" and "we never counted" are different claims about how
    // autonomous the run was, and only one of them is true here.
    expect(container.textContent).not.toContain("0 steers");
    expect(container.textContent).toContain("7 turns");
    expect(emptyGlyphElements(container)).toHaveLength(1);
  });

  it("keeps a recorded zero-steer run reading as zero steers", () => {
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 0,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("0 steers");
    expect(emptyGlyphElements(container)).toHaveLength(0);
  });

  it("falls back to the transcript length before giving up on the turn count", () => {
    // `turnItems.length` is a real derivation from the same record, not a
    // coercion, so it is used before the row admits it does not know.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 3,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);
    const expectedTurns = session.turnItems?.length ?? 0;

    expect(expectedTurns).toBeGreaterThan(0);
    expect(container.textContent).toContain(`${expectedTurns} turns`);
    expect(emptyGlyphElements(container)).toHaveLength(0);
  });

  it("dashes the turn count when there is no transcript to count either", () => {
    // `turnItems` is optional on `AgentSessionDetail`, so an absent transcript
    // is a reachable shape — and with no turn count either, the row genuinely
    // does not know.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 3,
      turns: null,
      turnItems: undefined,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).not.toContain("0 turns");
    expect(emptyGlyphElements(container)).toHaveLength(1);
  });

  it("collapses to one glyph when no work counter was recorded at all", () => {
    // Code review: "— turns | 0 tool calls | — steers" is two shrugs strung on
    // pipes around a zero, which scans as a broken row rather than an honest
    // one. Tokens already collapses in this situation; Work now matches it.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: null,
      toolCallsTotal: null,
      toolUseCount: 0,
      turnItems: undefined,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(emptyGlyphElements(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("turns");
    expect(container.textContent).not.toContain("tool calls");
    expect(container.textContent).not.toContain("steers");
  });

  it("keeps a measured tool-call count visible when its neighbours are unknown", () => {
    // The boundary the collapse must not cross: `toolUseCount` is
    // non-nullable, so a nonzero count is a MEASURED fact. Hiding it because
    // the counters either side of it were never recorded would trade one
    // dishonesty for another, so the row degrades per counter instead.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: null,
      toolCallsTotal: null,
      toolUseCount: 12,
      turnItems: undefined,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("12 tool calls");
    expect(emptyGlyphElements(container)).toHaveLength(2);
  });

  it("names the steer count as a prefix count when the read was truncated", () => {
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 4,
      steeringEpisodesTruncated: true,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    // The number itself is unchanged — it is what the producer counted, and
    // swapping in a different quantity would relocate the split rather than
    // close it.
    expect(container.textContent).toContain("4 steers");
    expect(explanationOf(container)).toContain(
      `Steering episodes were ${TRACE_PREFIX_COUNTED_NOTE}`
    );
  });

  it("leaves the tool-call count out of the qualifier, which ISS-5407 already re-reads whole-run", () => {
    const session = createAgentSessionDetailFixture({
      eventsTruncated: true,
      steeringEpisodes: 4,
      steeringEpisodesTruncated: true,
      toolCallsTotal: 310,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("310 tool calls");
    // A metadata-sourced `turns` is not event-folded either, so exactly one
    // counter is named. Hedging all three would trade this bug for the opposite.
    expect(explanationOf(container)).not.toContain("tool calls");
    expect(explanationOf(container)).not.toContain("Turns and");
  });

  it("also names turns when the count fell back to the truncated transcript", () => {
    const session = createAgentSessionDetailFixture({
      eventsTruncated: true,
      steeringEpisodes: 4,
      steeringEpisodesTruncated: true,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    // `turnItems` is projected from the same bounded rows, so the fallback is
    // prefix-derived where `session.turns` (read off session metadata) is not —
    // and it is `eventsTruncated`, the flag scoped to THAT read, which says so.
    expect(explanationOf(container)).toContain(
      `Turns and steering episodes were ${TRACE_PREFIX_COUNTED_NOTE}`
    );
  });

  /**
   * ISS-5636 (whitlockk): the counterfactual the per-derivation split exists for. A
   * bounded raw-event read does NOT make every folded scalar a prefix count, so
   * a row that qualified them off one read-scoped flag mislabels the ones the
   * cap never touched — the opposite defect, in the same sentence.
   */
  it("leaves a whole-run steer count unhedged even when the raw-event read was cut", () => {
    const session = createAgentSessionDetailFixture({
      // The producer read past its ceiling AND still counted this session's
      // steering off inputs the ceiling does not bound (a headless run's fixed
      // `0`, or a transcript-backed run's whole message stream) — so it emitted
      // `eventsTruncated` WITHOUT `steeringEpisodesTruncated`.
      eventsTruncated: true,
      steeringEpisodes: 4,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("4 steers");
    // Nothing to say about this row at all: no counter is missing and none is a
    // prefix, so it renders no explained (focusable) value rather than a hedge.
    expect(container.querySelector("button")).toBeNull();
  });

  it("states a missing counter and a truncated one in the same row", () => {
    // No turn count from EITHER source (so "turns" is missing outright) while
    // the steer count IS shown and IS prefix-derived. Both sentences are live,
    // and neither substitutes for the other: one says a counter is missing, the
    // other that a counter on screen covers less than the run.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 4,
      steeringEpisodesTruncated: true,
      turnItems: undefined,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(explanationOf(container)).toContain(
      "Turns were not recorded for this session"
    );
    expect(explanationOf(container)).toContain(
      `Steering episodes were ${TRACE_PREFIX_COUNTED_NOTE}`
    );
  });

  it("says nothing about truncation when nothing measured survived to qualify", () => {
    const session = createAgentSessionDetailFixture({
      eventsTruncated: true,
      steeringEpisodes: null,
      turnItems: undefined,
      turns: null,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    // The other side of the pair above: with no steer count and no turn count
    // there is no shown number left to describe, so the row states the absence
    // once rather than hedging a value it is not rendering.
    expect(explanationOf(container)).toContain(
      "Turns and steering episodes were not recorded for this session"
    );
    expect(explanationOf(container)).not.toContain(TRACE_PREFIX_COUNTED_NOTE);
  });

  it("says nothing about truncation when the producer served the whole stream", () => {
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 4,
      toolCallsTotal: 310,
      turns: 7,
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    // Absence is the flag's only encoding of "complete", and the cloud producer
    // never sets it — so a cloud-read row must stay an unhedged statement.
    expect(container.querySelector("button")).toBeNull();
  });

  it("treats an empty transcript as a measured zero, not an unknown", () => {
    // The other side of the boundary above: an EMPTY `turnItems` array is
    // evidence — the transcript was read and held no turns — so "0 turns" is a
    // true statement here and must not be softened into a dash.
    const session = createAgentSessionDetailFixture({
      steeringEpisodes: 3,
      turns: null,
      turnItems: [],
    });
    const { container } = render(<SessionWorkProperty session={session} />);

    expect(container.textContent).toContain("0 turns");
    expect(emptyGlyphElements(container)).toHaveLength(0);
  });
});

describe("PLN-2169 M2: the Autonomy row mounts the shared value", () => {
  it("draws the value's measured score under the Autonomy label", () => {
    const session = createAgentSessionDetailFixture({ autonomy: 92 });
    const { container } = render(<SessionAutonomyProperty session={session} />);

    expect(container.textContent).toContain("Autonomy");
    expect(container.textContent).toContain("High autonomy | 92/100");
  });
});
