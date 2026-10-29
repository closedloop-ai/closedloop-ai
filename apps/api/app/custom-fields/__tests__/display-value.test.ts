/**
 * The read-side half of DISPLAY_VALUE_STRATEGY (ISS-7215), plus the PEOPLE name
 * derivation that moved here from `utils.test.ts` with the function it covers.
 *
 * No `@repo/database` mock, deliberately — `display-value.ts` must stay DB-free,
 * and `display-value-import-contract.test.ts` is the guard that says so.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import type { CustomFieldReferenceTarget } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  DISPLAY_VALUE_STRATEGY,
  DisplayValueStrategy,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import {
  formatPeopleDisplayValue,
  formatPersonName,
  formatReferenceDisplayValue,
  resolveDisplayValue,
} from "../display-value";

const user = (
  id: string,
  firstName: string | null,
  lastName: string | null
): BasicUser => ({
  id,
  email: `${id}@example.com`,
  firstName,
  lastName,
  avatarUrl: null,
});

const target = (
  id: string,
  slug: string | null
): CustomFieldReferenceTarget => ({
  id,
  slug,
  name: `${id} name`,
  artifactType: ArtifactType.Document,
  subtype: null,
  status: "OPEN",
});

const ADA = user("u1", "Ada", "Lovelace");
const ALAN = user("u2", "Alan", "Turing");

describe("formatPersonName", () => {
  it("renders 'First L.'", () => {
    expect(formatPersonName({ firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada L."
    );
  });

  it("uses the first name alone when there is no last name", () => {
    expect(formatPersonName({ firstName: "Ada", lastName: null })).toBe("Ada");
  });

  it("falls back to a last initial when there is no first name", () => {
    expect(formatPersonName({ firstName: null, lastName: "Lovelace" })).toBe(
      "L."
    );
  });

  it("treats a whitespace-only first name as absent", () => {
    expect(formatPersonName({ firstName: "   ", lastName: "Lovelace" })).toBe(
      "L."
    );
  });

  it("renders a person with neither name as the empty string", () => {
    expect(formatPersonName({ firstName: null, lastName: null })).toBe("");
  });
});

describe("formatPeopleDisplayValue", () => {
  it("joins multiple people in the order given", () => {
    expect(formatPeopleDisplayValue([ADA, ALAN])).toBe("Ada L., Alan T.");
  });

  it("preserves the caller's order rather than imposing one", () => {
    // The caller orders by the stored `peopleValueIds`; this function must not
    // sort, or the cached sort key and the rendered label would diverge.
    expect(formatPeopleDisplayValue([ALAN, ADA])).toBe("Alan T., Ada L.");
  });

  it("drops a person with neither name rather than rendering a stray comma", () => {
    expect(formatPeopleDisplayValue([user("u3", null, null), ADA])).toBe(
      "Ada L."
    );
  });

  it("renders an empty string for no people", () => {
    expect(formatPeopleDisplayValue([])).toBe("");
  });
});

describe("resolveDisplayValue — PEOPLE (ISS-7215)", () => {
  it("IGNORES the stored string and derives from the live users", () => {
    // The regression: a renamed user writes no `custom_field_values` row, so the
    // cached string keeps the old name forever. Asserting the EXACT derived
    // string is what makes this test load-bearing — `not.toBe("Ada B.")` would
    // also pass on "", which is what a People arm wired to the reference
    // formatter would return.
    expect(
      resolveDisplayValue(CustomFieldType.People, "Ada B.", [], [ADA])
    ).toBe("Ada L.");
  });

  it("returns an empty string once the named users no longer resolve", () => {
    // A user deleted or moved out of the org is dropped by `toValueDetail`, so
    // the value reads as absent rather than as a stale name — the same answer
    // REFERENCE gives for a deleted target.
    expect(resolveDisplayValue(CustomFieldType.People, "Ada L.", [], [])).toBe(
      ""
    );
  });

  it("does not fall through to the reference formatter", () => {
    // A People row's `referenceValues` is always empty, so a two-way branch on
    // `resolvesDisplayValueOnRead` would blank every PEOPLE value. Passing a
    // non-empty reference list proves the dispatch picked the People arm.
    expect(
      resolveDisplayValue(
        CustomFieldType.People,
        "STALE",
        [target("a", "ISS-A")],
        [ADA]
      )
    ).toBe("Ada L.");
  });
});

describe("resolveDisplayValue — reference types", () => {
  it("ignores the stored string for a reference field", () => {
    expect(
      resolveDisplayValue(
        CustomFieldType.Reference,
        "STALE-TITLE",
        [target("a", "ISS-A")],
        []
      )
    ).toBe("ISS-A");
  });

  it("joins multiple targets for a REFERENCE_MULTI field", () => {
    expect(
      resolveDisplayValue(
        CustomFieldType.ReferenceMulti,
        null,
        [target("a", "ISS-A"), target("b", "ISS-B")],
        []
      )
    ).toBe("ISS-A, ISS-B");
  });

  it("returns an empty string once a reference's targets are gone", () => {
    expect(
      resolveDisplayValue(
        CustomFieldType.Reference,
        "Deleted issue title",
        [],
        []
      )
    ).toBe("");
  });

  it("falls back to the name for a target with no slug", () => {
    expect(
      resolveDisplayValue(
        CustomFieldType.Reference,
        null,
        [target("a", null)],
        []
      )
    ).toBe("a name");
  });
});

describe("resolveDisplayValue — strategy agreement", () => {
  it("returns the stored string for every CachedOnWrite type and derives for every ResolvedOnRead one", () => {
    // Drives the PUBLIC function for EVERY member of the union rather than
    // inspecting the dispatch table, and iterates `Object.values` so a newly
    // added CustomFieldType is covered here the moment it exists rather than
    // waiting for someone to extend a hand-written list.
    for (const fieldType of Object.values(CustomFieldType)) {
      const resolved = resolveDisplayValue(fieldType, "STORED", [], [ADA]);
      if (
        DISPLAY_VALUE_STRATEGY[fieldType] === DisplayValueStrategy.CachedOnWrite
      ) {
        expect(resolved).toBe("STORED");
      } else {
        // `typeof` first, because `not.toBe("STORED")` passes on `null` and
        // `null` is REACHABLE: `DISPLAY_VALUE_RESOLVER` types its entries as
        // `DisplayValueResolver | null`, so a type declared ResolvedOnRead with
        // a null resolver entry compiles and falls through here green — the
        // exact hole this case exists to close (marisolashgrove review, cid
        // 3911851216). Asserting a string is what forces the two tables to
        // agree; the union of the two tables is not maintained by anything else.
        expect(typeof resolved).toBe("string");
        expect(resolved).not.toBe("STORED");
      }
    }
  });

  it("never returns the stored string for PEOPLE, whatever it holds", () => {
    expect(
      resolveDisplayValue(CustomFieldType.People, "anything at all", [], [ADA])
    ).toBe("Ada L.");
  });
});

describe("formatReferenceDisplayValue", () => {
  it("prefers the slug and falls back to the name", () => {
    expect(
      formatReferenceDisplayValue([target("a", "ISS-A"), target("b", null)])
    ).toBe("ISS-A, b name");
  });
});
