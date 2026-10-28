import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import {
  extractSessionLaunchAttribution,
  formatAttributedSkill,
} from "../session-launch-attribution-view";

/**
 * ISS-7259 — the read-side coercion behind the session-detail launch-attribution
 * rows.
 *
 * These are the rules the PANEL cannot observe. A number the panel only ever
 * renders inside the skill row disappears with that row whether or not the
 * extractor dropped it, so asserting it through a render proves nothing; the
 * co-presence guard is only visible here, on the extractor's own return value.
 */

/**
 * The full shape, written out as a literal rather than derived from the type or
 * from `LaunchThreadSource`. A fixture built from the module under test stays
 * green when a member is renamed or removed — the duplication IS the test.
 */
const EMPTY_VIEW = {
  threadSource: null,
  agentRole: null,
  agentNickname: null,
  depth: null,
  firstAttributedSkill: null,
  observedSkillCount: null,
  firstAttributedRecordIndex: null,
  observedRecordCount: null,
  promptSource: null,
};

describe("extractSessionLaunchAttribution (ISS-7259)", () => {
  /**
   * THE case this file exists for. An orphan `observedSkillCount: 3` asserts
   * three skills were observed while the view can name none of them, and a
   * reader cannot tell that from a genuine count. The numbers go with the name.
   */
  it("drops every skill-dependent number when the skill name is unusable", () => {
    const view = extractSessionLaunchAttribution({
      harnessLaunchAttribution: {
        firstAttributedSkill: "s".repeat(129),
        observedSkillCount: 3,
        firstAttributedRecordIndex: 251,
        observedRecordCount: 381,
        promptSource: "sdk",
      },
    });

    // Whole-object equality, not key-by-key: a newly added member that this rule
    // forgets to cover fails here instead of slipping through unasserted.
    expect(view).toEqual({ ...EMPTY_VIEW, promptSource: "sdk" });
  });

  /** The positive control — the same numbers survive a usable name. */
  it("keeps the skill-dependent numbers when the skill name is usable", () => {
    const view = extractSessionLaunchAttribution({
      harnessLaunchAttribution: {
        firstAttributedSkill: "cl-produce",
        observedSkillCount: 3,
        firstAttributedRecordIndex: 251,
        observedRecordCount: 381,
        promptSource: "sdk",
      },
    });

    expect(view).toEqual({
      ...EMPTY_VIEW,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 3,
      firstAttributedRecordIndex: 251,
      observedRecordCount: 381,
      promptSource: "sdk",
    });
  });

  /**
   * The CROSS-FIELD case, which no per-number bound can see. `{ index: 251,
   * count: 3 }` clears `positiveInteger` on both halves and would render
   * `(record 251 of 3)` — an attribution positioned past the end of its own
   * transcript, reading as a late attribution in a tiny session. The worker
   * boundary rejects this shape on the way in, which protects nothing here: the
   * reader parses a cloud-synced, untyped blob a version-skewed producer or a
   * hand edit reaches without passing through any producer.
   *
   * The degrade is the ABSENCE of the qualifier, not a repaired number, so the
   * skill and its count survive and only the impossible position goes.
   */
  it("drops both position members when the index is past the scan count", () => {
    const view = extractSessionLaunchAttribution({
      harnessLaunchAttribution: {
        firstAttributedSkill: "cl-produce",
        observedSkillCount: 3,
        firstAttributedRecordIndex: 251,
        observedRecordCount: 3,
      },
    });

    expect(view).toEqual({
      ...EMPTY_VIEW,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 3,
    });
  });

  /**
   * The same blob through the FORMATTER — the assertion that names what a reader
   * would otherwise see. Asserting the nulls alone would stay green if the
   * formatter grew its own fallback for a half-pair and printed a position from
   * one number.
   */
  it("renders no record position for an index past the scan count", () => {
    const view = extractSessionLaunchAttribution({
      harnessLaunchAttribution: {
        firstAttributedSkill: "cl-produce",
        observedSkillCount: 3,
        firstAttributedRecordIndex: 251,
        observedRecordCount: 3,
      },
    });
    if (view === null) {
      throw new Error("the skill name alone must yield a view");
    }

    const formatted = formatAttributedSkill(view);

    // Exact equality, not a `not.toContain("251")`: a formatter that printed
    // `record 251 of 251` would pass a substring check on the count.
    expect(formatted?.value).toBe("cl-produce");
    expect(formatted?.explanation).toContain("1 of 3 skills");
  });

  /**
   * Half a pair, the other shape the producer refuses to emit. An ordinal with
   * no denominator is unreadable — record 251 is late in a 381-record session
   * and early in a 4000-record one — so the surviving half is dropped rather
   * than rendered against a denominator the reader has to invent.
   */
  it("drops a record index that arrives without its scan count", () => {
    const view = extractSessionLaunchAttribution({
      harnessLaunchAttribution: {
        firstAttributedSkill: "cl-produce",
        firstAttributedRecordIndex: 251,
      },
    });

    expect(view).toEqual({
      ...EMPTY_VIEW,
      firstAttributedSkill: "cl-produce",
    });
  });

  /**
   * A facet whose only member is the spawn word Claude always sends carries no
   * fact at all. Returning a view here would put an empty row group on every
   * Claude session.
   */
  it("returns null for a facet stating only the unstated spawn word", () => {
    expect(
      extractSessionLaunchAttribution({
        harnessLaunchAttribution: { threadSource: "unstated" },
      })
    ).toBeNull();
  });

  /** `unknown` is a stated fact — this build is behind — and must survive. */
  it("keeps an unrecognized spawn word", () => {
    expect(
      extractSessionLaunchAttribution({
        harnessLaunchAttribution: { threadSource: "unknown" },
      })
    ).toEqual({ ...EMPTY_VIEW, threadSource: "unknown" });
  });

  /**
   * THE version-skew case. A word OUTSIDE the union — what a newer producer or a
   * renamed upstream value looks like from here — must normalize to `unknown`,
   * not to null. Null is the no-row path, which means "the harness never said",
   * so collapsing to it would make a build that is behind indistinguishable from
   * a harness that stayed silent. `"unknown"` is inside any whitelist and so
   * cannot catch this; `"scheduled"` is the case that can.
   */
  it("normalizes a spawn word outside the union to unknown, not to absent", () => {
    expect(
      extractSessionLaunchAttribution({
        harnessLaunchAttribution: { threadSource: "scheduled" },
      })
    ).toEqual({ ...EMPTY_VIEW, threadSource: "unknown" });
  });

  /**
   * A user-started thread. The other stated word, asserted so the `User` member
   * has a case of its own rather than riding on the subagent fixtures.
   */
  it("keeps a user-started spawn word", () => {
    expect(
      extractSessionLaunchAttribution({
        harnessLaunchAttribution: { threadSource: "user" },
      })
    ).toEqual({ ...EMPTY_VIEW, threadSource: "user" });
  });

  /**
   * `promptSource` as the ONLY stated fact — the branch where it alone has to
   * carry `hasAnyStatedMember`. Every other fixture pairs it with a skill, which
   * would keep this green even if promptSource stopped counting as a fact.
   */
  it("returns a view when the prompt source is the only stated member", () => {
    expect(
      extractSessionLaunchAttribution({
        harnessLaunchAttribution: { promptSource: "typed" },
      })
    ).toEqual({ ...EMPTY_VIEW, promptSource: "typed" });
  });

  /**
   * Depth is a hierarchy LEVEL, so `0` is a real value (a root thread) while a
   * negative or fractional one is corrupt. A truthiness check would erase the
   * zero; the capture side hit exactly that defect and had it fixed in review.
   */
  it("keeps a zero depth and rejects a negative or fractional one", () => {
    const readDepth = (depth: JsonValue) =>
      extractSessionLaunchAttribution({
        harnessLaunchAttribution: { threadSource: "subagent", depth },
      })?.depth;

    expect(readDepth(0)).toBe(0);
    expect(readDepth(-1)).toBeNull();
    expect(readDepth(1.5)).toBeNull();
  });

  /** Every pre-ISS-7259 payload, and a blob that is not an object at all. */
  it.each<JsonObject | null>([
    null,
    {},
    { harnessLaunchAttribution: "nonsense" },
  ])(
    "returns null when the blob carries no readable facet (%j)",
    (metadata) => {
      expect(extractSessionLaunchAttribution(metadata)).toBeNull();
    }
  );
});
