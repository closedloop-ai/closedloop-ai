import { describe, expect, it } from "vitest";
import {
  buildHarnessLaunchAttribution,
  LaunchThreadSource,
  MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS,
  normalizeLaunchThreadSource,
} from "./launch-attribution";

/**
 * ISS-7259. The member list is written out by hand rather than derived from the
 * const object under test: deriving it would make this assertion restate whatever
 * the module currently exports, so deleting a member would keep it green. The
 * duplication IS the test — it is what makes a removed member fail here, and a
 * removed member is a value already persisted in metadata blobs and already
 * accepted by the `.strict()` worker boundary.
 */
const EXPECTED_THREAD_SOURCES = ["user", "subagent", "unstated", "unknown"];

describe("LaunchThreadSource", () => {
  it("exposes exactly the four members the persistence boundary accepts", () => {
    expect(Object.values(LaunchThreadSource)).toEqual(EXPECTED_THREAD_SOURCES);
  });
});

describe("normalizeLaunchThreadSource", () => {
  it("maps each harness spelling onto its member", () => {
    expect(normalizeLaunchThreadSource("user")).toBe(LaunchThreadSource.User);
    expect(normalizeLaunchThreadSource("subagent")).toBe(
      LaunchThreadSource.Subagent
    );
  });

  it("reports an unrecognised value as Unknown, not as Unstated", () => {
    // The distinction this asserts is the whole point of having both members:
    // a harness that renames `subagent` must not become indistinguishable from
    // one that never stamped a spawn word at all.
    expect(normalizeLaunchThreadSource("orchestrator")).toBe(
      LaunchThreadSource.Unknown
    );
    expect(normalizeLaunchThreadSource("")).toBe(LaunchThreadSource.Unstated);
    expect(normalizeLaunchThreadSource(undefined)).toBe(
      LaunchThreadSource.Unstated
    );
  });

  it("degrades a malformed non-string to Unstated instead of throwing", () => {
    // Reachable: this value comes from transcript JSON, which the type system
    // does not constrain.
    expect(normalizeLaunchThreadSource(7)).toBe(LaunchThreadSource.Unstated);
    expect(normalizeLaunchThreadSource(null)).toBe(LaunchThreadSource.Unstated);
    expect(normalizeLaunchThreadSource({ thread_source: "user" })).toBe(
      LaunchThreadSource.Unstated
    );
  });
});

describe("buildHarnessLaunchAttribution", () => {
  it("returns undefined when nothing was captured", () => {
    expect(buildHarnessLaunchAttribution({})).toBeUndefined();
  });

  it("does not manufacture a facet from a bare Unstated spawn word", () => {
    // If it did, every session in the corpus would gain a metadata key that
    // states nothing, and unattributed sessions would stop round-tripping
    // byte-identically.
    expect(
      buildHarnessLaunchAttribution({
        threadSource: LaunchThreadSource.Unstated,
      })
    ).toBeUndefined();
  });

  it("emits the whole facet, with Unstated filled in, for a Claude capture", () => {
    expect(
      buildHarnessLaunchAttribution({
        firstAttributedSkill: "cl-produce",
        observedSkillCount: 2,
        promptSource: "typed",
      })
    ).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 2,
      promptSource: "typed",
    });
  });

  it("never emits an orphan observedSkillCount when the skill name is dropped", () => {
    // `observedSkillCount` is documented as present whenever
    // `firstAttributedSkill` is, and this is the shared choke point BOTH parsers
    // route through — so the invariant is enforced where it cannot be bypassed
    // by a future producer, not only at the Claude accumulator that feeds it.
    // A count with no name asserts a skill was observed and cannot say which.
    expect(
      buildHarnessLaunchAttribution({
        firstAttributedSkill: "x".repeat(
          MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1
        ),
        observedSkillCount: 1,
      })
    ).toBeUndefined();
  });

  it("drops an orphan count but keeps the rest of the facet", () => {
    // The count must not take unrelated members down with it: dropping the pair
    // is a repair of one fact, not a reason to discard the whole record.
    expect(
      buildHarnessLaunchAttribution({
        threadSource: LaunchThreadSource.Subagent,
        firstAttributedSkill: "x".repeat(
          MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1
        ),
        observedSkillCount: 3,
        promptSource: "typed",
      })
    ).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      promptSource: "typed",
    });
  });

  it("omits absent members rather than serializing them as null", () => {
    const facet = buildHarnessLaunchAttribution({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "review-soul",
      agentNickname: undefined,
      parentThreadId: "",
    });

    // The desktop → cloud contract is omission: a version-skewed reader must be
    // able to tell "not captured" from "captured as empty".
    expect(facet).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "review-soul",
    });
    expect(facet && "agentNickname" in facet).toBe(false);
    expect(facet && "parentThreadId" in facet).toBe(false);
  });

  it("drops a string longer than the identifier cap, keeping its siblings", () => {
    const facet = buildHarnessLaunchAttribution({
      threadSource: LaunchThreadSource.Subagent,
      firstAttributedSkill: "x".repeat(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1),
      agentRole: "review-soul",
    });

    // Dropped, not truncated: a clipped identifier is a DIFFERENT identifier,
    // and a wrong attribution is worse than a missing one.
    expect(facet).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "review-soul",
    });
  });

  it("keeps a string exactly at the cap, so the bound is inclusive", () => {
    // The positive sibling: without it, a cap of 0 would pass the test above.
    const atCap = "x".repeat(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS);
    expect(
      buildHarnessLaunchAttribution({
        threadSource: LaunchThreadSource.Subagent,
        firstAttributedSkill: atCap,
      })
    ).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      firstAttributedSkill: atCap,
    });
  });

  it("never emits the position pair without the skill it positions", () => {
    // ISS-7508. The index and its denominator are numbers ABOUT a skill, so the
    // cap that drops an unnameable name has to drop them too — exactly as it
    // drops `observedSkillCount`. An orphan "record 5 of 9" asserts that
    // something was attributed there and cannot say what, which no reader can
    // tell from a genuine position.
    expect(
      buildHarnessLaunchAttribution({
        firstAttributedSkill: "x".repeat(
          MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1
        ),
        firstAttributedRecordIndex: 5,
        observedRecordCount: 9,
      })
    ).toBeUndefined();
  });

  it("keeps the position pair alongside a skill it can name", () => {
    // The positive sibling on the same shape: the guard above must drop the pair
    // for want of a NAME, not reject the members outright. Without this, a
    // builder that never emitted either would pass the negative case.
    expect(
      buildHarnessLaunchAttribution({
        firstAttributedSkill: "cl-produce",
        observedSkillCount: 1,
        firstAttributedRecordIndex: 5,
        observedRecordCount: 9,
      })
    ).toEqual({
      threadSource: LaunchThreadSource.Unstated,
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 1,
      firstAttributedRecordIndex: 5,
      observedRecordCount: 9,
    });
  });

  it("drops an orphan position pair without taking the rest of the facet with it", () => {
    // Same repair rule the orphan count follows: losing one fact is not a reason
    // to discard a Codex spawn word that was stated independently of it.
    const facet = buildHarnessLaunchAttribution({
      threadSource: LaunchThreadSource.Subagent,
      firstAttributedRecordIndex: 5,
      observedRecordCount: 9,
      agentRole: "review-soul",
    });

    expect(facet).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "review-soul",
    });
    expect(facet && "firstAttributedRecordIndex" in facet).toBe(false);
    expect(facet && "observedRecordCount" in facet).toBe(false);
  });

  it("keeps a zero depth, which is a value and not an absence", () => {
    expect(
      buildHarnessLaunchAttribution({
        threadSource: LaunchThreadSource.Subagent,
        depth: 0,
      })
    ).toEqual({ threadSource: LaunchThreadSource.Subagent, depth: 0 });
  });
});
