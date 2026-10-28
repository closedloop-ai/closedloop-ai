/**
 * ISS-7259: Claude launch-attribution capture, asserted through the production
 * parser entry point.
 *
 * Every fixture here states a DISTINCTIVE value. A transcript that omitted
 * `attributionSkill` would make "the facet is populated" pass whether or not the
 * parser reads the field at all, so the assertions pin the exact string the
 * fixture carried rather than merely that something arrived.
 */
import { describe, expect, it } from "vitest";
import {
  LaunchThreadSource,
  MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS,
} from "../launch-attribution";
import { parseClaudeTranscript } from "./parse-claude";
import { assistantLine, userLine } from "./parse-claude.test-fixtures";

describe("parseClaudeTranscript — harnessLaunchAttribution", () => {
  it("captures the first attributionSkill and the turn's promptSource", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine({ promptSource: "typed" }),
        assistantLine({ attributionSkill: "cl-produce" }),
      ],
      { sessionId: "attribution-basic" }
    );

    // Whole-object equality, not key-by-key: a key-by-key check would stay green
    // if the parser also stamped a member it should not have.
    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 1,
      firstAttributedRecordIndex: 2,
      observedRecordCount: 2,
      promptSource: "typed",
    });
  });

  it("keeps the FIRST skill and counts the rest, so one value is not read as the only value", async () => {
    const session = await parseClaudeTranscript(
      [
        assistantLine({ attributionSkill: "cl-produce" }),
        // A repeat of the first must not inflate the count — the question is how
        // many DISTINCT skills ran, not how many turns were attributed.
        assistantLine({ attributionSkill: "cl-produce" }),
        // The sequence must END on a DIFFERENT skill than it starts on, or
        // last-wins would produce the same answer and this assertion would be
        // satisfied by the very implementation it exists to rule out.
        assistantLine({ attributionSkill: "code-review:start" }),
      ],
      { sessionId: "attribution-multi" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 2,
      firstAttributedRecordIndex: 1,
      observedRecordCount: 3,
    });
  });

  it("omits the facet entirely when the transcript attributes nothing", async () => {
    // The positive sibling of the assertions above, and the property that keeps
    // every unattributed session's metadata blob byte-identical.
    const session = await parseClaudeTranscript([userLine(), assistantLine()], {
      sessionId: "attribution-absent",
    });

    expect(session?.harnessLaunchAttribution).toBeUndefined();
    expect(session && "harnessLaunchAttribution" in session).toBe(false);
  });

  it("records promptSource alone when no skill was attributed", async () => {
    const session = await parseClaudeTranscript(
      [userLine({ promptSource: "sdk" }), assistantLine()],
      { sessionId: "attribution-prompt-only" }
    );

    // `observedSkillCount` must be ABSENT rather than 0: a zero would read as
    // "we looked and found no skills", which is a different claim from "no skill
    // attribution was stated".
    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      promptSource: "sdk",
    });
  });

  it("ignores a non-string attributionSkill instead of persisting it", async () => {
    // Reachable at this trust boundary: the value comes from transcript JSON.
    const session = await parseClaudeTranscript(
      [assistantLine({ attributionSkill: { name: "cl-produce" } })],
      { sessionId: "attribution-malformed" }
    );

    expect(session?.harnessLaunchAttribution).toBeUndefined();
  });

  it("omits the facet when the ONLY attributed skill is too long to name", async () => {
    // The count and the name are a documented pair — `observedSkillCount` is
    // "present whenever firstAttributedSkill is". Capping the string without
    // gating the number inverted that: the record asserted a skill was observed
    // and then could not say which, and a reader cannot tell that from a genuine
    // count. Nothing nameable was stated here, so the honest record is no record.
    const session = await parseClaudeTranscript(
      [
        assistantLine({
          attributionSkill: "x".repeat(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1),
        }),
      ],
      { sessionId: "attribution-overlong-only" }
    );

    expect(session?.harnessLaunchAttribution).toBeUndefined();
    expect(session && "harnessLaunchAttribution" in session).toBe(false);
  });

  it("keeps a skill named at exactly the cap", async () => {
    // Positive control: the fix must drop the unnameable value, not the field.
    // Without this, gating the pair by rejecting every skill would pass.
    const atCap = "x".repeat(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS);
    const session = await parseClaudeTranscript(
      [assistantLine({ attributionSkill: atCap })],
      { sessionId: "attribution-at-cap" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: atCap,
      observedSkillCount: 1,
      firstAttributedRecordIndex: 1,
      observedRecordCount: 1,
    });
  });

  it("names the first RECORDABLE skill when an earlier one is too long, and positions it there", async () => {
    // The discriminating case between the two available remedies. Dropping the
    // count alongside the name would lose the fact that a nameable skill ran at
    // all; excluding the unnameable value at the source lets the record name the
    // real skill AND keeps the count measuring exactly what it can name — so the
    // count is 1, not 2.
    // ISS-7508: the same exclusion has to move the POSITION with the name. The
    // skipped record still occupies an ordinal (it was read), but it must not
    // DONATE that ordinal to the skill that replaced it — an index of 1 here
    // would report `cl-produce` as the session's opening attribution when the
    // record that actually stated it was the second one.
    const session = await parseClaudeTranscript(
      [
        assistantLine({
          attributionSkill: "x".repeat(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1),
        }),
        assistantLine({ attributionSkill: "cl-produce" }),
      ],
      { sessionId: "attribution-overlong-then-valid" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 1,
      firstAttributedRecordIndex: 2,
      observedRecordCount: 2,
    });
  });

  it("positions a skill attributed deep inside the session, with the transcript length as its denominator", async () => {
    // ISS-7508's whole reason to exist, and the corpus's normal case: not one of
    // 105 scanned transcripts attributed a skill on its first record, and the two
    // dossiers the ticket cites first attribute at records 251/381 and 146/413.
    // The expected 5 and 9 are written out by hand rather than derived from the
    // fixture array or from any production helper — a `lines.length` here would
    // restate whatever the parser counted and stay green if it counted the wrong
    // thing. The duplication IS the test.
    const session = await parseClaudeTranscript(
      [
        userLine(),
        assistantLine(),
        userLine(),
        assistantLine(),
        // Record 5 of 9.
        assistantLine({ attributionSkill: "cl-produce" }),
        userLine(),
        assistantLine(),
        userLine(),
        assistantLine(),
      ],
      { sessionId: "attribution-deep" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 1,
      firstAttributedRecordIndex: 5,
      observedRecordCount: 9,
    });
  });

  it("reports an index of 1 when the very first record carried the skill", async () => {
    // The discriminating sibling of the deep case: 1 has to be REPRESENTABLE and
    // distinguishable from "deep in", or the member cannot answer the only
    // question it was added for. It also separates the index from the count,
    // which a fixture whose skill sits on its last record would not.
    const session = await parseClaudeTranscript(
      [
        assistantLine({ attributionSkill: "cl-produce" }),
        userLine(),
        assistantLine(),
      ],
      { sessionId: "attribution-first-record" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 1,
      firstAttributedRecordIndex: 1,
      observedRecordCount: 3,
    });
  });

  it("emits neither position member on a facet that named no skill", async () => {
    // ISS-7508 co-presence, asserted on a facet that EXISTS — the absent-facet
    // test above cannot see this, because a missing facet omits every member for
    // a reason that has nothing to do with the position pair. A transcript length
    // stamped here would be a number about a skill this session never attributed.
    const session = await parseClaudeTranscript(
      [userLine({ promptSource: "sdk" }), assistantLine(), userLine()],
      { sessionId: "attribution-positions-without-skill" }
    );
    const facet = session?.harnessLaunchAttribution;

    expect(facet).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      promptSource: "sdk",
    });
    // `in` rather than a value check: the facet's contract is OMISSION, and a key
    // present with an undefined value satisfies `toEqual` while breaking it.
    expect(facet && "firstAttributedRecordIndex" in facet).toBe(false);
    expect(facet && "observedRecordCount" in facet).toBe(false);
  });
});

/**
 * ISS-7508: `observedRecordCount`'s own contract says it counts "the records
 * that reached the session-attribute pass", so a blank, malformed, or replayed
 * line is absent from BOTH the count and the index. That invariant is what makes
 * "record 251 of 381" a statement about the transcript rather than about the
 * file's byte layout, and nothing exercised it.
 */
describe("parseClaudeTranscript — position excludes lines the scan skips", () => {
  it("counts neither malformed nor replayed nor blank lines toward the position", async () => {
    const replayed = assistantLine({
      uuid: "u-replay",
      attributionSkill: "cl-produce",
    });
    const session = await parseClaudeTranscript(
      [
        // Four lines the scan drops BEFORE the attribute pass. If any of them
        // were counted, both numbers below would be larger.
        "{ not json at all",
        "null",
        '["a", "list", "is", "legal", "json"]',
        "   ",
        userLine({ uuid: "u-1" }),
        replayed,
        // A verbatim replay of the line above — the harness rewrites earlier
        // lines on resume/compaction, and a replay must not consume an ordinal.
        replayed,
        assistantLine({ uuid: "u-2" }),
      ],
      { sessionId: "attribution-skipped-lines" }
    );

    // Hand-counted: three records survive (u-1, u-replay, u-2), the skill sits
    // on the second of them. Literals, not derived from the input array.
    expect(session?.harnessLaunchAttribution?.firstAttributedRecordIndex).toBe(
      2
    );
    expect(session?.harnessLaunchAttribution?.observedRecordCount).toBe(3);
  });

  it("counts every well-formed line when none are skipped", async () => {
    // Positive sibling for the case above: without it, an implementation that
    // counted nothing at all would satisfy the exclusion assertions.
    const session = await parseClaudeTranscript(
      [
        userLine({ uuid: "v-1" }),
        assistantLine({ uuid: "v-2", attributionSkill: "cl-produce" }),
        assistantLine({ uuid: "v-3" }),
      ],
      { sessionId: "attribution-no-skips" }
    );

    expect(session?.harnessLaunchAttribution?.firstAttributedRecordIndex).toBe(
      2
    );
    expect(session?.harnessLaunchAttribution?.observedRecordCount).toBe(3);
  });

  it("keeps the index at or below the count on a skip-heavy transcript", async () => {
    // The documented invariant itself, on the shape most likely to break it: the
    // skipped lines sit AFTER the attributed record, so an index taken from a
    // raw line counter would overshoot a count that excluded them.
    const session = await parseClaudeTranscript(
      [
        assistantLine({ uuid: "w-1", attributionSkill: "cl-produce" }),
        "}{",
        "42",
        assistantLine({ uuid: "w-2" }),
      ],
      { sessionId: "attribution-trailing-skips" }
    );

    const facet = session?.harnessLaunchAttribution;
    expect(facet?.firstAttributedRecordIndex).toBe(1);
    expect(facet?.observedRecordCount).toBe(2);
  });
});
