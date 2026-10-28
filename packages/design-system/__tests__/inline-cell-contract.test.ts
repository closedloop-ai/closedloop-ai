import {
  classifyInlineCellCommitFailure,
  holdsInlineCellDraft,
  INLINE_CELL_EDITABILITY_SPEC,
  INLINE_CELL_VARIANT_SPEC,
  InlineCellAffordance,
  InlineCellCardinality,
  InlineCellCommit,
  InlineCellCommitFailure,
  type InlineCellContract,
  InlineCellEditability,
  InlineCellEntry,
  InlineCellSelectionKind,
  type InlineCellValue,
  InlineCellValueState,
  InlineCellVariant,
  type InlineCellVariantSpec,
  offersInlineCellEditor,
  opensInlineCellOverlay,
  resolveInlineCellSelection,
  resolveInlineCellSelections,
} from "@closedloop-ai/design-system/lib/inline-cell-contract";
import { describe, expect, it } from "vitest";

/**
 * ISS-9348. This file pins the three things the contract's acceptance criteria
 * claim: that one prop shape expresses every approved variant, that a value
 * arriving from outside this build degrades honestly, and that the interaction
 * model is stated per variant rather than defaulted into.
 *
 * The expectation tables below are written as LITERALS on purpose. Deriving them
 * from `InlineCellVariant` or `INLINE_CELL_VARIANT_SPEC` would make this file
 * agree with whatever the module currently says, so a variant silently given
 * another variant's interaction model would still be green.
 */

const WHOLE_CELL = ["whole-cell"];
const SINGLE = ["single"];
const MULTIPLE = ["multiple"];

const EXPECTED_VARIANT_SPEC = {
  text: {
    entry: "field",
    commit: "draft",
    affordances: WHOLE_CELL,
    cardinalities: SINGLE,
  },
  number: {
    entry: "field",
    commit: "draft",
    affordances: WHOLE_CELL,
    cardinalities: SINGLE,
  },
  date: {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: SINGLE,
  },
  // Custom fields store both forms: ENUM and MULTI_ENUM.
  enum: {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: ["single", "multiple"],
  },
  status: {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: SINGLE,
  },
  priority: {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: SINGLE,
  },
  person: {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: SINGLE,
  },
  "multi-person": {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: MULTIPLE,
  },
  // Documents routes a chip press to search, so its chips ride beside the
  // picker trigger rather than inside it.
  tag: {
    entry: "overlay",
    commit: "selection",
    affordances: ["whole-cell", "adjacent-control"],
    cardinalities: MULTIPLE,
  },
  // Custom fields store both forms: REFERENCE and REFERENCE_MULTI.
  reference: {
    entry: "overlay",
    commit: "selection",
    affordances: WHOLE_CELL,
    cardinalities: ["single", "multiple"],
  },
} as const;

const KNOWN_MEMBERS = ["urgent", "high", "low"] as const;

/**
 * Accepts any `InlineCellContract`, whatever its value type. Each construction
 * below is the compile-time half of the first acceptance criterion: if the shape
 * could not express a variant without an extra prop, this file would not build.
 */
function variantOf<TValue>(
  cell: InlineCellContract<TValue>
): InlineCellVariant {
  return cell.variant;
}

const noop = () => {
  // A commit that neither resolves a value nor refuses one.
};

describe("inline cell variant vocabulary", () => {
  it("states an interaction model for every approved variant", () => {
    for (const variant of Object.values(InlineCellVariant)) {
      expect(INLINE_CELL_VARIANT_SPEC[variant]).toEqual(
        EXPECTED_VARIANT_SPEC[variant]
      );
    }
  });

  it("covers the vocabulary and nothing else", () => {
    expect(Object.keys(INLINE_CELL_VARIANT_SPEC).sort()).toEqual(
      Object.keys(EXPECTED_VARIANT_SPEC).sort()
    );
  });

  it("admits the whole cell as the press target for every approved variant", () => {
    for (const variant of Object.values(InlineCellVariant)) {
      expect(INLINE_CELL_VARIANT_SPEC[variant].affordances).toContain(
        InlineCellAffordance.WholeCell
      );
    }
  });

  it("derives overlay entry and draft holding from the one table", () => {
    expect(opensInlineCellOverlay(InlineCellVariant.Text)).toBe(false);
    expect(opensInlineCellOverlay(InlineCellVariant.Priority)).toBe(true);
    expect(holdsInlineCellDraft(InlineCellVariant.Number)).toBe(true);
    // A picker has no uncommitted draft, so Escape has nothing to revert and
    // blur has nothing to write.
    expect(holdsInlineCellDraft(InlineCellVariant.Date)).toBe(false);
    expect(holdsInlineCellDraft(InlineCellVariant.Tag)).toBe(false);
  });

  it("admits a list only on the variants production stores as one", () => {
    const admitsList = Object.values(InlineCellVariant).filter((variant) => {
      const spec: InlineCellVariantSpec = INLINE_CELL_VARIANT_SPEC[variant];
      return spec.cardinalities.includes(InlineCellCardinality.Multiple);
    });
    expect(admitsList.sort()).toEqual([
      InlineCellVariant.Enum,
      InlineCellVariant.MultiPerson,
      InlineCellVariant.Reference,
      InlineCellVariant.Tag,
    ]);
  });
});

describe("one contract expresses every approved variant", () => {
  it("builds each variant from the same props with no variant-specific field", () => {
    const covered = [
      variantOf<string>({
        variant: InlineCellVariant.Text,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Name, row 1",
        value: { state: InlineCellValueState.Present, value: "a title" },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
      variantOf<number>({
        variant: InlineCellVariant.Number,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Estimate, row 1",
        value: { state: InlineCellValueState.Present, value: 3 },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
      variantOf<string>({
        variant: InlineCellVariant.Date,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Due date, row 1",
        value: { state: InlineCellValueState.Present, value: "2026-09-22" },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
      variantOf<string>({
        variant: InlineCellVariant.Enum,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Kind, row 1",
        value: { state: InlineCellValueState.Present, value: "one" },
        editability: InlineCellEditability.ReadOnly,
        onCommit: noop,
      }),
      variantOf<string>({
        variant: InlineCellVariant.Status,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Status, row 1",
        value: { state: InlineCellValueState.Present, value: "active" },
        editability: InlineCellEditability.Forbidden,
        onCommit: noop,
      }),
      variantOf<string>({
        variant: InlineCellVariant.Priority,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Priority, row 1",
        value: { state: InlineCellValueState.Empty },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
      variantOf<string>({
        variant: InlineCellVariant.Person,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Owner, row 1",
        value: { state: InlineCellValueState.Unavailable },
        editability: InlineCellEditability.Disabled,
        onCommit: noop,
      }),
      variantOf<readonly string[]>({
        variant: InlineCellVariant.MultiPerson,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Multiple,
        label: "Collaborators, row 1",
        value: { state: InlineCellValueState.Present, value: ["u1", "u2"] },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
      variantOf<readonly string[]>({
        variant: InlineCellVariant.Tag,
        affordance: InlineCellAffordance.AdjacentControl,
        cardinality: InlineCellCardinality.Multiple,
        label: "Tags, row 1",
        value: { state: InlineCellValueState.Present, value: ["t1"] },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
        onCancel: noop,
        onCommitFailure: noop,
      }),
      variantOf<readonly string[]>({
        variant: InlineCellVariant.Reference,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Multiple,
        label: "References, row 1",
        value: { state: InlineCellValueState.Loading },
        editability: InlineCellEditability.Disabled,
        onCommit: noop,
      }),
      // The second form of each variant that admits two cardinalities.
      variantOf<readonly string[]>({
        variant: InlineCellVariant.Enum,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Multiple,
        label: "Labels, row 1",
        value: { state: InlineCellValueState.Present, value: ["one", "two"] },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
      variantOf<string>({
        variant: InlineCellVariant.Reference,
        affordance: InlineCellAffordance.WholeCell,
        cardinality: InlineCellCardinality.Single,
        label: "Parent, row 1",
        value: { state: InlineCellValueState.Present, value: "r1" },
        editability: InlineCellEditability.Editable,
        onCommit: noop,
      }),
    ];

    expect([...new Set(covered)].sort()).toEqual(
      [...Object.values(InlineCellVariant)].sort()
    );
  });

  it("cannot carry a value while claiming not to have one", () => {
    const stillLoading: InlineCellValue<string> = {
      state: InlineCellValueState.Loading,
      // @ts-expect-error a value beside a non-Present state is the stale-render
      // lie this union exists to make unrepresentable. Deleting the union's
      // discriminant turns this line green and fails `tsc` on the directive.
      value: "a value the reader would see as live",
    };
    expect(stillLoading.state).toBe(InlineCellValueState.Loading);
  });

  it("cannot claim a value while carrying none", () => {
    const presentButNull: InlineCellValue<string | null> = {
      state: InlineCellValueState.Present,
      // @ts-expect-error nullable field data must arrive as Empty, not as a
      // Present null; widening Present's payload back to TValue fails `tsc` on
      // this directive.
      value: null,
    };
    expect(presentButNull.state).toBe(InlineCellValueState.Present);
  });

  it("cannot pair a variant with a form its spec does not admit", () => {
    // @ts-expect-error `person` holds one member; a list is `multi-person`.
    const listOnSinglePerson: InlineCellContract<readonly string[]> = {
      variant: InlineCellVariant.Person,
      affordance: InlineCellAffordance.WholeCell,
      cardinality: InlineCellCardinality.Multiple,
      label: "Owner, row 1",
      value: { state: InlineCellValueState.Empty },
      editability: InlineCellEditability.Editable,
      onCommit: noop,
    };
    // @ts-expect-error only `tag` admits an adjacent control.
    const adjacentText: InlineCellContract<string> = {
      variant: InlineCellVariant.Text,
      affordance: InlineCellAffordance.AdjacentControl,
      cardinality: InlineCellCardinality.Single,
      label: "Name, row 1",
      value: { state: InlineCellValueState.Empty },
      editability: InlineCellEditability.Editable,
      onCommit: noop,
    };
    expect([listOnSinglePerson.variant, adjacentText.variant]).toEqual([
      InlineCellVariant.Person,
      InlineCellVariant.Text,
    ]);
  });
});

describe("editability states stay distinguishable", () => {
  it("offers an editor only when editable", () => {
    expect(offersInlineCellEditor(InlineCellEditability.Editable)).toBe(true);
    expect(offersInlineCellEditor(InlineCellEditability.ReadOnly)).toBe(false);
    expect(offersInlineCellEditor(InlineCellEditability.Disabled)).toBe(false);
    expect(offersInlineCellEditor(InlineCellEditability.Forbidden)).toBe(false);
  });

  it("marks only the transient blocker as transient", () => {
    // Read-only and forbidden both need something to CHANGE before this viewer
    // edits this row; disabled does not. This axis separates disabled from the
    // other two and nothing more — read-only and forbidden give the same answer
    // here, and a consumer tells them apart by the member itself.
    expect(
      INLINE_CELL_EDITABILITY_SPEC[InlineCellEditability.Disabled].transient
    ).toBe(true);
    expect(
      INLINE_CELL_EDITABILITY_SPEC[InlineCellEditability.ReadOnly].transient
    ).toBe(false);
    expect(
      INLINE_CELL_EDITABILITY_SPEC[InlineCellEditability.Forbidden].transient
    ).toBe(false);
    // The fourth member is the one a partial assertion drops: nothing else in
    // the module reads `Editable.transient`, so omitting it here lets a flip to
    // `true` survive the whole suite.
    expect(
      INLINE_CELL_EDITABILITY_SPEC[InlineCellEditability.Editable].transient
    ).toBe(false);
  });

  it("covers the editability vocabulary and nothing else", () => {
    expect(Object.keys(INLINE_CELL_EDITABILITY_SPEC).sort()).toEqual(
      ["disabled", "editable", "forbidden", "read-only"].sort()
    );
  });
});

describe("member ids arriving from outside this build", () => {
  it("keeps a member only a newer peer knows, as itself", () => {
    // The version-skew case: a peer wrote a member this build has never heard
    // of. It must not become a default member and must not vanish.
    expect(resolveInlineCellSelection("blocker", KNOWN_MEMBERS)).toEqual({
      kind: InlineCellSelectionKind.Unknown,
      memberId: "blocker",
    });
  });

  it("resolves a known member", () => {
    expect(resolveInlineCellSelection("high", KNOWN_MEMBERS)).toEqual({
      kind: InlineCellSelectionKind.Known,
      memberId: "high",
    });
  });

  it("reads the repo's spellings of absence as absence", () => {
    for (const raw of [null, undefined, ""]) {
      expect(resolveInlineCellSelection(raw, KNOWN_MEMBERS)).toEqual({
        kind: InlineCellSelectionKind.Absent,
      });
    }
  });

  it("refuses shapes that cannot be a member id", () => {
    // A blank-but-not-empty string has no honest reading: calling it absent
    // claims nobody set a value, and calling it unknown renders whitespace as
    // one. Same for every non-string shape a wire payload can carry.
    for (const raw of [" ", "\t", 0, 7, Number.NaN, true, {}, [], new Date()]) {
      expect(resolveInlineCellSelection(raw, KNOWN_MEMBERS)).toEqual({
        kind: InlineCellSelectionKind.Malformed,
      });
    }
  });

  it("treats a missing list as no members", () => {
    expect(resolveInlineCellSelections(null, KNOWN_MEMBERS)).toEqual([]);
    expect(resolveInlineCellSelections(undefined, KNOWN_MEMBERS)).toEqual([]);
    expect(resolveInlineCellSelections([], KNOWN_MEMBERS)).toEqual([]);
  });

  it("does not report a present non-list as an empty one", () => {
    // "Something is here and it is wrong" and "nothing is here" are different
    // claims, and only one of them is true.
    expect(resolveInlineCellSelections("high", KNOWN_MEMBERS)).toEqual([
      { kind: InlineCellSelectionKind.Malformed },
    ]);
    expect(resolveInlineCellSelections({ id: "high" }, KNOWN_MEMBERS)).toEqual([
      { kind: InlineCellSelectionKind.Malformed },
    ]);
  });

  it("keeps one entry per member id, at its first occurrence", () => {
    // A duplicate is not a distinct member, so drawing it twice would show a
    // chip the stored list does not hold.
    expect(
      resolveInlineCellSelections(
        ["high", "blocker", "high", "blocker", 7, 7, "", ""],
        KNOWN_MEMBERS
      )
    ).toEqual([
      { kind: InlineCellSelectionKind.Known, memberId: "high" },
      { kind: InlineCellSelectionKind.Unknown, memberId: "blocker" },
      { kind: InlineCellSelectionKind.Malformed },
      { kind: InlineCellSelectionKind.Malformed },
      { kind: InlineCellSelectionKind.Absent },
      { kind: InlineCellSelectionKind.Absent },
    ]);
  });

  it("reports every entry of a mixed list, in order, dropping none", () => {
    expect(
      resolveInlineCellSelections(["high", "blocker", 7, ""], KNOWN_MEMBERS)
    ).toEqual([
      { kind: InlineCellSelectionKind.Known, memberId: "high" },
      { kind: InlineCellSelectionKind.Unknown, memberId: "blocker" },
      { kind: InlineCellSelectionKind.Malformed },
      { kind: InlineCellSelectionKind.Absent },
    ]);
  });
});

describe("a refused commit is classified, never trusted", () => {
  it("keeps a reason this build declares", () => {
    expect(
      classifyInlineCellCommitFailure(InlineCellCommitFailure.Conflict)
    ).toBe(InlineCellCommitFailure.Conflict);
    expect(
      classifyInlineCellCommitFailure(InlineCellCommitFailure.Validation)
    ).toBe(InlineCellCommitFailure.Validation);
  });

  it("degrades an unrecognised reason to the generic refusal", () => {
    for (const reason of [
      "precondition_failed",
      undefined,
      null,
      500,
      new Error("boom"),
      { code: "conflict" },
    ]) {
      expect(classifyInlineCellCommitFailure(reason)).toBe(
        InlineCellCommitFailure.Rejected
      );
    }
  });
});

describe("entry vocabulary", () => {
  it("has exactly the two entries the interaction model branches on", () => {
    expect(Object.values(InlineCellEntry).sort()).toEqual(["field", "overlay"]);
    expect(Object.values(InlineCellCommit).sort()).toEqual([
      "draft",
      "selection",
    ]);
  });
});
