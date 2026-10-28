import { resolveColumnLayout } from "@closedloop-ai/design-system/lib/column-layout";
import {
  ColumnAlignment,
  type ColumnDefinition,
  ColumnFieldKind,
  ColumnPriority,
  createColumnRegistry,
} from "@closedloop-ai/design-system/lib/column-registry";
import { describe, expect, it } from "vitest";

/**
 * ISS-9313. `resolveColumnLayout` is the one place a declaration set and a view
 * state become a rendered layout, so what these settle is that the four facts a
 * host used to keep apart — the column array, the track string, the hidden set
 * and the capability lists — cannot come apart here.
 *
 * Widths, capability defaults and alignment defaults are written as LITERALS.
 * Deriving them from `COLUMN_KIND_POLICY` or the capability-defaults record
 * would make this file agree with whatever those currently say, so flipping a
 * default could not fail it.
 */

/** The floor `clampColumnWidth` applies, written out rather than imported. */
const MIN_WIDTH_PX = 60;
/** `Number` is the one kind whose declared alignment default is not `start`. */
const NUMBER_KIND_ALIGNMENT = ColumnAlignment.End;

const DEFINITIONS: ColumnDefinition[] = [
  {
    id: "name",
    label: "Name",
    kind: ColumnFieldKind.Text,
    width: { default: 200 },
  },
  {
    id: "cost",
    label: "Cost",
    kind: ColumnFieldKind.Number,
    width: { default: 120 },
  },
  {
    id: "status",
    label: "Status",
    kind: ColumnFieldKind.Choice,
    width: { default: 140 },
  },
];

describe("resolveColumnLayout — columns and their tracks", () => {
  it("emits one track per rendered column, in the same order", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS));

    expect(layout.columnOrder).toEqual(["name", "cost", "status"]);
    expect(layout.gridTemplateColumns).toBe("200px 120px 140px");
    expect(layout.columns.map((column) => column.id)).toEqual(
      layout.columnOrder
    );
  });

  it("brackets the data tracks with the caller's own", () => {
    const layout = resolveColumnLayout(
      createColumnRegistry(DEFINITIONS),
      undefined,
      { leadingTracks: ["36px", "240px"], trailingTracks: ["48px"] }
    );

    expect(layout.gridTemplateColumns).toBe(
      "36px 240px 200px 120px 140px 48px"
    );
  });

  it("reorders the columns and their tracks together", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      columnOrder: ["status", "name", "cost"],
    });

    expect(layout.columnOrder).toEqual(["status", "name", "cost"]);
    expect(layout.gridTemplateColumns).toBe("140px 200px 120px");
  });

  it("discards a stored id the registry never had rather than painting a track", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      columnOrder: ["status", "retired-column", "name", "cost"],
    });

    expect(layout.columnOrder).not.toContain("retired-column");
    expect(layout.columnOrder).toEqual(["status", "name", "cost"]);
    expect(layout.gridTemplateColumns.split(" ")).toHaveLength(3);
  });

  it("falls back to the shared floor for a column declaring no width", () => {
    const layout = resolveColumnLayout(
      createColumnRegistry([
        { id: "flag", label: "Flag", kind: ColumnFieldKind.Text },
      ])
    );

    expect(layout.gridTemplateColumns).toBe(`${MIN_WIDTH_PX}px`);
  });

  it("does not let priority filter, reorder or resize selected columns", () => {
    const prioritized: ColumnDefinition[] = [
      {
        ...DEFINITIONS[0],
        priority: ColumnPriority.Low,
      },
      {
        ...DEFINITIONS[1],
        priority: ColumnPriority.Essential,
      },
      {
        ...DEFINITIONS[2],
        priority: ColumnPriority.High,
      },
    ];

    const layout = resolveColumnLayout(createColumnRegistry(prioritized));

    expect(layout.columnOrder).toEqual(["name", "cost", "status"]);
    expect(layout.columns.map((column) => column.id)).toEqual(
      layout.columnOrder
    );
    expect(layout.gridTemplateColumns).toBe("200px 120px 140px");
  });
});

describe("resolveColumnLayout — width overrides", () => {
  it("takes the caller's override over the declared default", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      columnWidths: { cost: 300 },
    });

    expect(layout.columnWidths.cost).toBe(300);
    expect(layout.columnWidths.name).toBe(200);
    expect(layout.gridTemplateColumns).toBe("200px 300px 140px");
  });

  it("ignores an override for an id the registry never had", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      columnWidths: { "retired-column": 900 },
    });

    expect(layout.columnWidths).not.toHaveProperty("retired-column");
    expect(layout.gridTemplateColumns).toBe("200px 120px 140px");
  });

  it("clamps an override below the shared floor", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      columnWidths: { cost: 4 },
    });

    expect(layout.columnWidths.cost).toBe(MIN_WIDTH_PX);
  });

  /**
   * whitlockk cid 3961205935. The shared floor is not the only bound a REGISTRY
   * column has. An override restored from an older view state reached
   * `applyColumnWidths`, which answers to `MIN_COLUMN_WIDTH_PX` alone, so a
   * column declaring `{ min: 100, max: 200 }` painted a track its own
   * declaration forbids — and the track string was generated from that width,
   * so the layout disagreed with the bounds it had just been handed.
   */
  it("holds an override up to the column's own declared floor", () => {
    const layout = resolveColumnLayout(createColumnRegistry(BOUNDED), {
      columnWidths: { bounded: 80 },
    });

    expect(layout.columnWidths.bounded).toBe(100);
    expect(layout.gridTemplateColumns).toBe("100px");
  });

  it("holds an override down to the column's own declared ceiling", () => {
    const layout = resolveColumnLayout(createColumnRegistry(BOUNDED), {
      columnWidths: { bounded: 300 },
    });

    expect(layout.columnWidths.bounded).toBe(200);
    expect(layout.gridTemplateColumns).toBe("200px");
  });

  it("leaves an override inside the declared bounds exactly where it is", () => {
    const layout = resolveColumnLayout(createColumnRegistry(BOUNDED), {
      columnWidths: { bounded: 150 },
    });

    expect(layout.columnWidths.bounded).toBe(150);
  });
});

/** One column whose own bounds are narrower than the shared floor's range. */
const BOUNDED: ColumnDefinition[] = [
  {
    id: "bounded",
    label: "Bounded",
    kind: ColumnFieldKind.Number,
    width: { min: 100, default: 150, max: 200 },
  },
];

/**
 * marisolashgrove cid 3961273888. `columnOrder` is the VISIBLE order, so that is
 * what the header emits back — and persisting it verbatim drops every hidden
 * column's remembered slot. `toPersistedColumnOrder` is the write-back every v2
 * host re-derives beside its own table today.
 */
describe("resolveColumnLayout — the order round trip", () => {
  it("keeps a hidden column in its own slot rather than at the end", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      hiddenColumnIds: ["cost"],
    });

    expect(layout.columnOrder).toEqual(["name", "status"]);
    // The header emits the visible order it was given, reordered.
    expect(layout.toPersistedColumnOrder(["status", "name"])).toEqual([
      "status",
      "cost",
      "name",
    ]);
  });

  it("is a fixed point for a visible order nobody moved", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS));

    expect(layout.toPersistedColumnOrder(layout.columnOrder)).toEqual([
      "name",
      "cost",
      "status",
    ]);
  });

  it("merges onto the order the view state already holds, not declaration order", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      columnOrder: ["status", "cost", "name"],
      hiddenColumnIds: ["cost"],
    });

    expect(layout.columnOrder).toEqual(["status", "name"]);
    // `cost` was moved to the middle before it was hidden; it stays there.
    expect(layout.toPersistedColumnOrder(["name", "status"])).toEqual([
      "name",
      "cost",
      "status",
    ]);
  });
});

describe("resolveColumnLayout — visibility", () => {
  it("hides the ids the view state names, and their tracks with them", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      hiddenColumnIds: ["cost"],
    });

    expect(layout.hiddenColumnIds).toEqual(["cost"]);
    expect(layout.columnOrder).toEqual(["name", "status"]);
    expect(layout.gridTemplateColumns).toBe("200px 140px");
  });

  it("refuses to hide a column declared unhideable, however the view state asks", () => {
    const layout = resolveColumnLayout(
      createColumnRegistry([
        {
          id: "name",
          label: "Name",
          kind: ColumnFieldKind.Text,
          hideable: false,
        },
        { id: "cost", label: "Cost", kind: ColumnFieldKind.Number },
      ]),
      { hiddenColumnIds: ["name", "cost"] }
    );

    expect(layout.hiddenColumnIds).toEqual(["cost"]);
    expect(layout.columnOrder).toEqual(["name"]);
  });

  it("applies defaultHidden only when the view state holds no opinion", () => {
    const registry = createColumnRegistry([
      { id: "name", label: "Name", kind: ColumnFieldKind.Text },
      {
        id: "cost",
        label: "Cost",
        kind: ColumnFieldKind.Number,
        defaultHidden: true,
      },
    ]);

    expect(resolveColumnLayout(registry).columnOrder).toEqual(["name"]);
    // An EMPTY array is a user who explicitly showed everything, which is not
    // the same as no opinion at all.
    expect(
      resolveColumnLayout(registry, { hiddenColumnIds: [] }).columnOrder
    ).toEqual(["name", "cost"]);
  });
});

describe("resolveColumnLayout — capabilities", () => {
  it("reports every column movable and resizable when none opts out", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS));

    expect(layout.movableColumnIds).toEqual(["name", "cost", "status"]);
    expect(layout.resizableColumnIds).toEqual(["name", "cost", "status"]);
  });

  it("drops a column from the capability list it declared away, and no other", () => {
    const layout = resolveColumnLayout(
      createColumnRegistry([
        {
          id: "name",
          label: "Name",
          kind: ColumnFieldKind.Text,
          movable: false,
        },
        {
          id: "cost",
          label: "Cost",
          kind: ColumnFieldKind.Number,
          resizable: false,
        },
        { id: "status", label: "Status", kind: ColumnFieldKind.Choice },
      ])
    );

    expect(layout.movableColumnIds).toEqual(["cost", "status"]);
    expect(layout.resizableColumnIds).toEqual(["name", "status"]);
    // Neither capability removes the column itself.
    expect(layout.columnOrder).toEqual(["name", "cost", "status"]);
  });

  it("reports capabilities for the visible columns only", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS), {
      hiddenColumnIds: ["cost"],
    });

    expect(layout.movableColumnIds).not.toContain("cost");
    expect(layout.resizableColumnIds).not.toContain("cost");
  });
});

describe("resolveColumnLayout — alignment reaches the render prop", () => {
  it("resolves a number column to its kind's end alignment and text to start", () => {
    const layout = resolveColumnLayout(createColumnRegistry(DEFINITIONS));
    const byId = new Map(layout.columns.map((column) => [column.id, column]));

    expect(byId.get("cost")?.align).toBe(NUMBER_KIND_ALIGNMENT);
    expect(byId.get("name")?.align).toBe(ColumnAlignment.Start);
  });

  it("prefers a column's own declaration over its kind default", () => {
    const layout = resolveColumnLayout(
      createColumnRegistry([
        {
          id: "cost",
          label: "Cost",
          kind: ColumnFieldKind.Number,
          align: ColumnAlignment.Start,
        },
      ])
    );

    expect(layout.columns[0]?.align).toBe(ColumnAlignment.Start);
  });

  it("carries the accessible name of a deliberately unlabelled column", () => {
    const layout = resolveColumnLayout(
      createColumnRegistry([
        {
          id: "actions",
          label: "",
          ariaLabel: "Row actions",
          kind: ColumnFieldKind.Custom,
        },
      ])
    );

    expect(layout.columns[0]?.ariaLabel).toBe("Row actions");
  });
});
