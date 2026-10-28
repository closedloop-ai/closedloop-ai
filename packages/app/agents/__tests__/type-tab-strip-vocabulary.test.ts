import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { EXPECTED_TYPE_TAB_SEGMENTS } from "./type-tab-strip-vocabulary";

/**
 * The staleness half of the ISS-6271 guard.
 *
 * `type-tab-strip-vocabulary.ts` restates the strip on purpose, so that
 * `agents-grouped-list.permalink.test.tsx` compares the rendered strip against
 * an oracle production cannot move. That independence is what lets it go red on
 * a renamed `?kind=` value — and it is also the one thing a derived fixture
 * could never do, so it is not up for consolidation.
 *
 * What independence does NOT give you is a promise that a hand-written value is
 * still a kind at all. This closes that separately: it never supplies the
 * expectation, it only refuses to let the pin name a wire value the canonical
 * enum no longer carries. Importing `AgentComponentKind` INTO the fixture would
 * buy the same check by making the pin unable to fail, which is the trade this
 * file exists to avoid.
 */
const CANONICAL_KIND_VALUES: readonly string[] =
  Object.values(AgentComponentKind);

/** The strip's leading `All` segment is a sentinel, not a kind. */
const ALL_SEGMENT_VALUE = "all";

describe("type-tab strip vocabulary (ISS-6271)", () => {
  it("pins no kind value the canonical AgentComponentKind set has retired", () => {
    const pinnedKindValues = EXPECTED_TYPE_TAB_SEGMENTS.filter(
      (segment) => segment.value !== ALL_SEGMENT_VALUE
    ).map((segment) => segment.value);
    const retired = pinnedKindValues.filter(
      (value) => !CANONICAL_KIND_VALUES.includes(value)
    );

    expect(retired).toEqual([]);
  });
});
