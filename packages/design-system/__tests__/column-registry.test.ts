import {
  COLUMN_KIND_POLICY,
  ColumnAlignment,
  type ColumnDefinition,
  ColumnFieldKind,
  ColumnPriority,
  ColumnRegistryIssueCode,
  createColumnRegistry,
  resolveColumnAlignment,
  resolveColumnCapabilities,
  resolveColumnDefaultWidth,
  validateColumnDefinitions,
} from "@closedloop-ai/design-system/lib/column-registry";
import { describe, expect, it } from "vitest";

/**
 * ISS-9446. The registry is the DECLARATION layer above `GridTableV2Column`,
 * and its whole job is refusing declaration sets that would render a broken
 * table — a duplicate id that makes persisted view state ambiguous, an unnamed
 * header, a width floor below the one the resize handles clamp to, a grouping
 * capability on a continuous value.
 *
 * The kind and policy tables below are written as LITERALS on purpose. Deriving
 * the expectation from `ColumnFieldKind` or `COLUMN_KIND_POLICY` would make this
 * file agree with whatever the module currently says, so deleting a kind or
 * flipping a policy row could never fail it. The duplication is the test.
 */

const EXPECTED_KINDS = [
  "text",
  "number",
  "date",
  "choice",
  "choice-list",
  "person",
  "person-list",
  "reference",
  "custom",
];

const EXPECTED_POLICY: Record<
  string,
  { groupable: boolean; defaultAlign: string }
> = {
  text: { groupable: false, defaultAlign: "start" },
  number: { groupable: false, defaultAlign: "end" },
  date: { groupable: false, defaultAlign: "start" },
  choice: { groupable: true, defaultAlign: "start" },
  "choice-list": { groupable: true, defaultAlign: "start" },
  person: { groupable: true, defaultAlign: "start" },
  "person-list": { groupable: true, defaultAlign: "start" },
  reference: { groupable: true, defaultAlign: "start" },
  custom: { groupable: true, defaultAlign: "start" },
};

/**
 * The shared resize floor, restated rather than imported. There is only ONE
 * such constant — the registry clamps against the same `MIN_COLUMN_WIDTH_PX`
 * the resize handles use — so this literal is not guarding against two values
 * drifting apart. What it buys is a tripwire: changing the shared floor has to
 * be a deliberate edit here too, rather than silently redefining what every
 * assertion below means.
 */
const RESIZE_FLOOR_PX = 60;

/** The message `createColumnRegistry` throws for a repeated column id. */
const DUPLICATE_ID_MESSAGE = /name.*declared more than once/;

function textColumn(
  overrides: Partial<ColumnDefinition> = {}
): ColumnDefinition {
  return {
    id: "name",
    label: "Name",
    kind: ColumnFieldKind.Text,
    ...overrides,
  };
}

function codesFrom(definitions: ColumnDefinition[]): string[] {
  return validateColumnDefinitions(definitions).map((issue) => issue.code);
}

describe("column kind and policy vocabulary", () => {
  it("declares exactly the nine field kinds the contract names", () => {
    expect([...Object.values(ColumnFieldKind)].sort()).toEqual(
      [...EXPECTED_KINDS].sort()
    );
  });

  it("carries a policy row for every kind, matching the contract", () => {
    // Read through a string-keyed view so the expectations above can stay
    // literals rather than being typed by the union under test.
    const policyByKind: Record<
      string,
      { groupable: boolean; defaultAlign: string }
    > = COLUMN_KIND_POLICY;
    expect([...Object.keys(policyByKind)].sort()).toEqual(
      [...EXPECTED_KINDS].sort()
    );
    for (const kind of EXPECTED_KINDS) {
      expect({ kind, ...policyByKind[kind] }).toEqual({
        kind,
        ...EXPECTED_POLICY[kind],
      });
    }
  });

  it("declares the alignment and priority vocabularies", () => {
    expect([...Object.values(ColumnAlignment)].sort()).toEqual([
      "center",
      "end",
      "start",
    ]);
    expect([...Object.values(ColumnPriority)].sort()).toEqual([
      "essential",
      "high",
      "low",
      "medium",
    ]);
  });
});

describe("validateColumnDefinitions", () => {
  it("accepts a well-formed set", () => {
    expect(
      validateColumnDefinitions([
        textColumn(),
        {
          id: "status",
          label: "Status",
          kind: ColumnFieldKind.Choice,
          groupable: true,
          filterable: true,
        },
        {
          id: "loc",
          label: "Lines",
          kind: ColumnFieldKind.Number,
          width: { min: 80, default: 120, max: 240 },
        },
      ])
    ).toEqual([]);
  });

  it("reports a duplicate id once per repeat after the first", () => {
    const duplicatesIn = (definitions: ColumnDefinition[]) =>
      validateColumnDefinitions(definitions).filter(
        (issue) => issue.code === ColumnRegistryIssueCode.DuplicateId
      );
    const twice = duplicatesIn([textColumn(), textColumn({ label: "Again" })]);
    expect(twice).toHaveLength(1);
    expect(twice[0].columnId).toBe("name");
    // Three copies are two repeats, not one — the first declaration is the
    // keeper and every later one is its own problem to fix.
    expect(
      duplicatesIn([textColumn(), textColumn(), textColumn()])
    ).toHaveLength(2);
  });

  it("rejects an id with surrounding whitespace, which evades duplicate detection", () => {
    expect(codesFrom([textColumn({ id: " name" })])).toContain("blank-id");
    expect(codesFrom([textColumn({ id: "name " })])).toContain("blank-id");
    expect(codesFrom([textColumn({ id: "name" })])).toEqual([]);
    // The defect the rule exists for: without it these two are distinct ids
    // that no reader and no persisted `columnOrder` entry would tell apart.
    const issues = validateColumnDefinitions([
      textColumn(),
      textColumn({ id: " name" }),
    ]);
    expect(
      issues.some((issue) => issue.code === ColumnRegistryIssueCode.DuplicateId)
    ).toBe(false);
  });

  it("rejects a blank id and reports it by index", () => {
    const issues = validateColumnDefinitions([
      textColumn(),
      textColumn({ id: "   " }),
    ]);
    const blank = issues.find(
      (issue) => issue.code === ColumnRegistryIssueCode.BlankId
    );
    expect(blank?.columnId).toBe("#1");
  });

  it("rejects a blank label with no ariaLabel, and accepts one with", () => {
    expect(codesFrom([textColumn({ label: "" })])).toContain(
      "missing-accessible-name"
    );
    expect(
      codesFrom([textColumn({ label: "", ariaLabel: "Row actions" })])
    ).toEqual([]);
    expect(codesFrom([textColumn({ label: "", ariaLabel: "  " })])).toContain(
      "missing-accessible-name"
    );
  });

  it("refuses groupable on a continuous or free-form kind", () => {
    expect(
      codesFrom([textColumn({ kind: ColumnFieldKind.Text, groupable: true })])
    ).toContain("unsupported-capability");
    expect(
      codesFrom([textColumn({ kind: ColumnFieldKind.Number, groupable: true })])
    ).toContain("unsupported-capability");
    expect(
      codesFrom([textColumn({ kind: ColumnFieldKind.Date, groupable: true })])
    ).toContain("unsupported-capability");
  });

  it("permits groupable on a banded kind", () => {
    expect(
      codesFrom([textColumn({ kind: ColumnFieldKind.Choice, groupable: true })])
    ).toEqual([]);
    expect(
      codesFrom([textColumn({ kind: ColumnFieldKind.Person, groupable: true })])
    ).toEqual([]);
  });

  it("refuses any declared bound below the shared resize floor", () => {
    for (const width of [
      { min: RESIZE_FLOOR_PX - 1 },
      { default: RESIZE_FLOOR_PX - 1 },
      { max: RESIZE_FLOOR_PX - 1 },
    ]) {
      expect(codesFrom([textColumn({ width })])).toContain(
        "invalid-width-bounds"
      );
    }
    expect(
      codesFrom([
        textColumn({
          width: {
            min: RESIZE_FLOOR_PX,
            default: RESIZE_FLOOR_PX,
            max: RESIZE_FLOOR_PX,
          },
        }),
      ])
    ).toEqual([]);
  });

  it("refuses inverted bounds and a default outside them", () => {
    expect(
      codesFrom([textColumn({ width: { min: 200, max: 100 } })])
    ).toContain("invalid-width-bounds");
    expect(
      codesFrom([textColumn({ width: { min: 100, default: 90, max: 300 } })])
    ).toContain("invalid-width-bounds");
    expect(
      codesFrom([textColumn({ width: { min: 100, default: 400, max: 300 } })])
    ).toContain("invalid-width-bounds");
  });

  it("refuses a non-finite or non-positive width without also inventing a bounds error", () => {
    const issues = validateColumnDefinitions([
      textColumn({ width: { min: Number.NaN } }),
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(["invalid-width-bounds"]);
    expect(codesFrom([textColumn({ width: { default: 0 } })])).toEqual([
      "invalid-width-bounds",
    ]);
    expect(
      codesFrom([textColumn({ width: { max: Number.POSITIVE_INFINITY } })])
    ).toEqual(["invalid-width-bounds"]);
  });

  it("refuses a magnitude past the safe integer range", () => {
    // Finite AND an integer, so neither the finiteness gate nor
    // `Number.isInteger` refuses it — only a safe-integer check does.
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(Number.isFinite(unsafe) && Number.isInteger(unsafe)).toBe(true);
    for (const width of [
      { min: unsafe },
      { min: 80, default: unsafe },
      { min: 80, max: unsafe },
    ]) {
      expect(codesFrom([textColumn({ width })])).toEqual([
        "invalid-width-bounds",
      ]);
    }
    expect(
      codesFrom([textColumn({ width: { max: Number.MAX_SAFE_INTEGER } })])
    ).toEqual([]);
  });

  it("refuses a fractional bound, which the resize path would round away", () => {
    expect(codesFrom([textColumn({ width: { min: 80.5 } })])).toContain(
      "invalid-width-bounds"
    );
    expect(
      codesFrom([textColumn({ width: { min: 80, default: 120.7 } })])
    ).toContain("invalid-width-bounds");
    expect(
      codesFrom([textColumn({ width: { min: 80, default: 120, max: 240.25 } })])
    ).toContain("invalid-width-bounds");
    expect(
      codesFrom([textColumn({ width: { min: 80, default: 120, max: 240 } })])
    ).toEqual([]);
  });

  it("refuses a column that starts hidden and can never be shown", () => {
    expect(
      codesFrom([textColumn({ defaultHidden: true, hideable: false })])
    ).toContain("unreachable-column");
    expect(codesFrom([textColumn({ defaultHidden: true })])).toEqual([]);
    expect(codesFrom([textColumn({ hideable: false })])).toEqual([]);
  });

  it("reports every problem in one pass rather than stopping at the first", () => {
    const issues = validateColumnDefinitions([
      textColumn({
        id: "",
        label: "",
        kind: ColumnFieldKind.Number,
        groupable: true,
        width: { min: 10 },
      }),
    ]);
    expect([...issues.map((issue) => issue.code)].sort()).toEqual(
      [
        "blank-id",
        "invalid-width-bounds",
        "missing-accessible-name",
        "unsupported-capability",
      ].sort()
    );
    // Every issue from one column names that column the same way, so a reader
    // fixing a blank-id column is not sent looking for a second, unnamed one.
    expect([...new Set(issues.map((issue) => issue.columnId))]).toEqual(["#0"]);
  });

  it("names a blank-id column by index even when it is also a duplicate", () => {
    const issues = validateColumnDefinitions([
      textColumn({ id: "" }),
      textColumn({ id: "" }),
    ]);
    // The second blank column is both blank and a repeat. Reporting the repeat
    // under an empty columnId would send a reader hunting for a third, unnamed
    // column and render the throw message as a bare ": ".
    expect([...new Set(issues.map((issue) => issue.columnId))].sort()).toEqual([
      "#0",
      "#1",
    ]);
  });
});

describe("createColumnRegistry", () => {
  it("throws on an invalid set, naming the column and the reason", () => {
    expect(() =>
      createColumnRegistry([textColumn(), textColumn()])
    ).toThrowError(DUPLICATE_ID_MESSAGE);
  });

  it("looks a definition up by id and returns undefined for an unknown one", () => {
    const registry = createColumnRegistry([
      textColumn(),
      { id: "status", label: "Status", kind: ColumnFieldKind.Choice },
    ]);
    expect(registry.get("status")?.label).toBe("Status");
    expect(registry.get("retired-column")).toBeUndefined();
  });

  it("keeps declaration order and does not alias the caller's array", () => {
    const declarations = [
      textColumn(),
      { id: "status", label: "Status", kind: ColumnFieldKind.Choice },
    ];
    const registry = createColumnRegistry(declarations);
    declarations.push({
      id: "late",
      label: "Late",
      kind: ColumnFieldKind.Text,
    });
    expect(registry.definitions.map((column) => column.id)).toEqual([
      "name",
      "status",
    ]);
  });

  it("freezes the declarations it hands out, so nothing can desync byId from the render prop", () => {
    const source = textColumn({ width: { min: 80, default: 120 } });
    const registry = createColumnRegistry([source]);

    // Mutating the caller's own literal must not reach the registry: `byId` was
    // keyed at construction, so a live alias would answer to "name" while
    // toGridColumns() rendered "renamed".
    source.id = "renamed";
    source.label = "Renamed";
    expect(registry.get("name")?.label).toBe("Name");
    expect(registry.get("renamed")).toBeUndefined();
    expect(registry.toGridColumns()[0].id).toBe("name");

    // And the copy it hands back refuses the write outright rather than
    // silently forking the registry from itself.
    const held = registry.get("name");
    expect(() => {
      (held as ColumnDefinition).id = "renamed";
    }).toThrow(TypeError);
    expect(() => {
      (held?.width as { min: number }).min = 10;
    }).toThrow(TypeError);
    expect(registry.get("name")?.id).toBe("name");
    expect(resolveColumnDefaultWidth(registry.definitions[0])).toBe(120);
  });

  it("adapts to the grid render prop, dropping declaration-only fields", () => {
    const registry = createColumnRegistry([
      {
        id: "loc",
        label: "Lines",
        kind: ColumnFieldKind.Number,
        className: "tabular-nums",
        sortable: true,
        tooltip: "Lines changed",
        width: { min: 80, default: 120 },
        priority: ColumnPriority.Low,
        pinnable: true,
        movable: false,
      },
    ]);
    // `align` is carried and RESOLVED (ISS-9313): this column declares none, so
    // the adapter emits its kind's default rather than passing `undefined` on
    // for the renderer to guess at. `width`, `priority`, `pinnable` and
    // `movable` stay declaration-only — the render prop has nowhere to put them.
    expect(registry.toGridColumns()).toEqual([
      {
        id: "loc",
        label: "Lines",
        className: "tabular-nums",
        sortable: true,
        filterable: undefined,
        groupable: undefined,
        tooltip: "Lines changed",
        ariaLabel: undefined,
        align: ColumnAlignment.End,
      },
    ]);
  });

  it("carries the accessible name of a blank-label column through the adapter", () => {
    // The validator ACCEPTS this column because it declares an ariaLabel. If
    // the adapter dropped that field the set would still validate clean while
    // rendering the exact unnamed columnheader MissingAccessibleName refuses.
    const registry = createColumnRegistry([
      {
        id: "actions",
        label: "",
        kind: ColumnFieldKind.Custom,
        ariaLabel: "Row actions",
      },
    ]);
    expect(validateColumnDefinitions(registry.definitions)).toEqual([]);
    expect(registry.toGridColumns()[0].ariaLabel).toBe("Row actions");
  });
});

describe("resolveColumnAlignment", () => {
  it("uses the column's own declaration when it has one", () => {
    expect(
      resolveColumnAlignment(
        textColumn({
          kind: ColumnFieldKind.Number,
          align: ColumnAlignment.Center,
        })
      )
    ).toBe("center");
  });

  it("falls back to the kind's alignment, which right-aligns numbers", () => {
    expect(resolveColumnAlignment(textColumn())).toBe("start");
    expect(
      resolveColumnAlignment(textColumn({ kind: ColumnFieldKind.Number }))
    ).toBe("end");
  });
});

describe("resolveColumnDefaultWidth", () => {
  it("prefers the declared default, then the declared min", () => {
    expect(
      resolveColumnDefaultWidth(
        textColumn({ width: { min: 80, default: 200 } })
      )
    ).toBe(200);
    expect(resolveColumnDefaultWidth(textColumn({ width: { min: 80 } }))).toBe(
      80
    );
  });

  it("falls back to the shared floor, and never returns below it", () => {
    expect(resolveColumnDefaultWidth(textColumn())).toBe(RESIZE_FLOOR_PX);
    // Below-floor bounds are a validation error, but this resolver is exported
    // and takes a plain definition, so a caller can reach it without having run
    // the validator first. This case pins the SHARED floor only; the column's
    // own declared min and max are pinned by the next test.
    expect(
      resolveColumnDefaultWidth(textColumn({ width: { default: 10 } }))
    ).toBe(RESIZE_FLOOR_PX);
  });

  it("rounds a fractional declared width to a whole pixel", () => {
    expect(
      resolveColumnDefaultWidth(textColumn({ width: { default: 120.4 } }))
    ).toBe(120);
  });

  it("clamps to the column's own bounds, not only the shared floor", () => {
    // Both sets are validation errors, and both are reachable here: the
    // resolver is exported and takes a plain definition, so a caller can hand
    // it a declaration the validator never saw.
    expect(
      resolveColumnDefaultWidth(
        textColumn({ width: { min: 100, default: 400, max: 300 } })
      )
    ).toBe(300);
    expect(
      resolveColumnDefaultWidth(
        textColumn({ width: { min: 200, default: 100 } })
      )
    ).toBe(200);
    // The declared floor is applied last, so an inverted set resolves at least
    // as wide as its own minimum rather than narrower than it.
    expect(
      resolveColumnDefaultWidth(
        textColumn({ width: { min: 200, default: 150, max: 100 } })
      )
    ).toBe(200);
    // A valid set is untouched by either bound.
    expect(
      resolveColumnDefaultWidth(
        textColumn({ width: { min: 80, default: 120, max: 240 } })
      )
    ).toBe(120);
  });
});

describe("resolveColumnCapabilities", () => {
  it("applies the documented defaults, which three fields invert when read raw", () => {
    const definition = textColumn();
    // The defect this resolver exists for: the raw fields are `undefined`, so
    // every truthiness read gives the inverse of the documented default.
    expect(definition.hideable).toBeUndefined();
    expect(resolveColumnCapabilities(definition)).toEqual({
      hideable: true,
      movable: true,
      resizable: true,
      pinnable: false,
    });
  });

  it("prefers an explicit declaration at either polarity", () => {
    expect(
      resolveColumnCapabilities(
        textColumn({
          hideable: false,
          movable: false,
          resizable: false,
          pinnable: true,
        })
      )
    ).toEqual({
      hideable: false,
      movable: false,
      resizable: false,
      pinnable: true,
    });
  });

  it("is the same answer the unreachable-column rule acts on", () => {
    // The internal rule and the exported resolver must not drift: a column is
    // unreachable exactly when it starts hidden and resolves hideable:false.
    const stuck = textColumn({ defaultHidden: true, hideable: false });
    expect(resolveColumnCapabilities(stuck).hideable).toBe(false);
    expect(codesFrom([stuck])).toContain("unreachable-column");

    const fine = textColumn({ defaultHidden: true });
    expect(resolveColumnCapabilities(fine).hideable).toBe(true);
    expect(codesFrom([fine])).toEqual([]);
  });
});
