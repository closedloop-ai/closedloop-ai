import { describe, expect, it } from "vitest";
import { phaseLoopbackSchema } from "@/lib/desktop-agent-sessions-trace-schema";
import {
  JsonArrayIncompleteReason,
  mergeJsonArrayIncompleteness,
  parseCompleteJsonArrayOrEmpty,
  parseJsonArray,
  readJsonArray,
  toMetadata,
} from "./coercion";

const READABLE_FIRST = {
  from: "plan",
  to: "build",
  label: "replan",
  depth: 1,
};
const READABLE_LAST = {
  from: "ship",
  to: "test",
  label: "reopen",
  depth: 2,
};
/** Fails `phaseLoopbackSchema`: `to`, `label`, and `depth` are all required. */
const UNREADABLE_MEMBER = { from: "build" };

/**
 * ISS-6978. The MIXED array is the test: a fixture whose members are all
 * readable, or all unreadable, passes with or without the member-by-member
 * read.
 */
describe("readJsonArray", () => {
  it("keeps the readable members either side of an unreadable one", () => {
    const read = readJsonArray(
      [READABLE_FIRST, UNREADABLE_MEMBER, READABLE_LAST],
      phaseLoopbackSchema
    );

    expect(read.members).toEqual([READABLE_FIRST, READABLE_LAST]);
    expect(read.incomplete).toEqual({
      reason: JsonArrayIncompleteReason.UnreadableMembers,
      unreadableMembers: 1,
    });
  });

  it("omits the incompleteness report when every member is readable", () => {
    const read = readJsonArray(
      [READABLE_FIRST, READABLE_LAST],
      phaseLoopbackSchema
    );

    expect(read.members).toEqual([READABLE_FIRST, READABLE_LAST]);
    expect(Object.hasOwn(read, "incomplete")).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["stored empty", []],
  ])("reads %s as empty AND whole", (_label, value) => {
    const read = readJsonArray(value, phaseLoopbackSchema);

    expect(read.members).toEqual([]);
    expect(Object.hasOwn(read, "incomplete")).toBe(false);
  });

  it.each([
    ["a string", "not-json"],
    ["an object", { from: "plan" }],
    ["a number", 0],
  ])("reports %s as unreadable with NO member count", (_label, value) => {
    const read = readJsonArray(value, phaseLoopbackSchema);

    expect(read.members).toEqual([]);
    expect(read.incomplete).toEqual({
      reason: JsonArrayIncompleteReason.UnreadableValue,
    });
    // The count is unknowable here. It must be ABSENT, never `0` and never
    // `null`: both would read as "nothing was lost" at a call site.
    expect(Object.hasOwn(read.incomplete ?? {}, "unreadableMembers")).toBe(
      false
    );
  });

  it("catches an unknowable loss with the same truthy predicate as a counted one", () => {
    const counted = readJsonArray(
      [READABLE_FIRST, UNREADABLE_MEMBER],
      phaseLoopbackSchema
    );
    const unknowable = readJsonArray("not-json", phaseLoopbackSchema);
    const whole = readJsonArray([READABLE_FIRST], phaseLoopbackSchema);

    // One predicate, three verdicts. A bare `number | null` signal would make
    // `unknowable` — the worst case — the one that reads as complete.
    expect(
      [counted, unknowable, whole].map((read) => Boolean(read.incomplete))
    ).toEqual([true, true, false]);
  });
});

describe("parseJsonArray", () => {
  it("serves the readable members of a partially corrupt persisted array", () => {
    expect(
      parseJsonArray(
        [READABLE_FIRST, UNREADABLE_MEMBER, READABLE_LAST],
        phaseLoopbackSchema
      )
    ).toEqual([READABLE_FIRST, READABLE_LAST]);
  });

  it("still reads an absent column as empty", () => {
    expect(parseJsonArray(null, phaseLoopbackSchema)).toEqual([]);
  });
});

describe("parseCompleteJsonArrayOrEmpty", () => {
  it("discards the readable members, which is why its four call sites are named", () => {
    // The deliberate ISS-6978 exception: `activityBuckets`, `markers`,
    // `throttles`, and `phases` need empty to mean "run the derived fallback".
    // If this ever matches `parseJsonArray`, the escalated product decision was
    // made by accident.
    expect(
      parseCompleteJsonArrayOrEmpty(
        [READABLE_FIRST, UNREADABLE_MEMBER, READABLE_LAST],
        phaseLoopbackSchema
      )
    ).toEqual([]);
  });

  it("returns every member when the array is whole", () => {
    expect(
      parseCompleteJsonArrayOrEmpty(
        [READABLE_FIRST, READABLE_LAST],
        phaseLoopbackSchema
      )
    ).toEqual([READABLE_FIRST, READABLE_LAST]);
  });
});

/**
 * ISS-7062: the population-wide fold, lifted here from the agent-roster
 * analytics so the two cannot drift.
 */
describe("mergeJsonArrayIncompleteness", () => {
  const members = (unreadableMembers: number) =>
    ({
      reason: JsonArrayIncompleteReason.UnreadableMembers,
      unreadableMembers,
    }) as const;
  const unknowable = {
    reason: JsonArrayIncompleteReason.UnreadableValue,
  } as const;

  it("sums the lost members across records", () => {
    expect(mergeJsonArrayIncompleteness(members(2), members(3))).toEqual({
      reason: JsonArrayIncompleteReason.UnreadableMembers,
      unreadableMembers: 5,
    });
  });

  it("adopts the first incompleteness when there is no running total", () => {
    expect(mergeJsonArrayIncompleteness(undefined, members(2))).toEqual(
      members(2)
    );
  });

  it("lets an unknowable loss ABSORB, from either side and permanently", () => {
    // Once one blob was not an array the population-wide count is unknowable.
    // Summing past it, or letting a later countable record reset it, would
    // publish a total that understates the real loss.
    expect(mergeJsonArrayIncompleteness(members(4), unknowable)).toEqual(
      unknowable
    );
    expect(mergeJsonArrayIncompleteness(unknowable, members(4))).toEqual(
      unknowable
    );
    expect(mergeJsonArrayIncompleteness(unknowable, unknowable)).toEqual(
      unknowable
    );
  });
});

/**
 * ISS-10177. `toMetadata` rebuilt the STORED blob through `z.record` on every
 * detail read, so an own `__proto__` key was dropped again here even once the
 * ingest boundary preserved it — the two sites lose it independently, which is
 * why each owns a regression rather than sharing one.
 *
 * Fixtures come from `JSON.parse`, not object literals: a quoted `"__proto__"`
 * in a literal is the prototype-setter form and creates no own key to preserve.
 */
describe("toMetadata preserves a __proto__ key (ISS-10177)", () => {
  it("keeps a top-level __proto__ alongside ordinary keys", () => {
    const stored = JSON.parse('{"a":1,"__proto__":{"deep":1}}');

    const result = toMetadata(stored);

    // The key SET, not a non-null result: the drop returned a perfectly valid
    // object, so asserting "not null" is the false green here.
    expect(Object.keys(result ?? {}).sort()).toEqual(["__proto__", "a"]);
    // biome-ignore lint/suspicious/noProto: ISS-10177 regression — the hostile key IS the subject under test
    expect(result?.__proto__).toEqual({ deep: 1 });
    // Consumers spread this blob, so it must come back normally-prototyped.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("keeps a NESTED __proto__, which a top-level-only guard would miss", () => {
    const stored = JSON.parse('{"outer":{"__proto__":{"deep":1},"keep":2}}');

    const result = toMetadata(stored);

    // Measured before the fix, this returned {"outer":{"keep":2}} — the value
    // schema recursed through z.record for every nested object.
    expect(result).toEqual(
      JSON.parse('{"outer":{"__proto__":{"deep":1},"keep":2}}')
    );
    const outer = result?.outer as Record<string, unknown>;
    expect(Object.keys(outer).sort()).toEqual(["__proto__", "keep"]);
  });

  it("still rejects a non-object into null", () => {
    expect(toMetadata("a string")).toBeNull();
    expect(toMetadata([1, 2, 3])).toBeNull();
    expect(toMetadata(null)).toBeNull();
  });
});
