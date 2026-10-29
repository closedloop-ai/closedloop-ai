import { TableBulkActionBar } from "@closedloop-ai/design-system/components/ui/table-bulk-action-bar";
import {
  type TableBulkActionDescriptor,
  type TableBulkActionOption,
  TableBulkActions,
  TableBulkActionUndo,
  type TableBulkPickerDescriptor,
  type TableBulkSelectionControls,
} from "@closedloop-ai/design-system/components/ui/table-bulk-actions";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StarIcon, TagIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-8942 — bulk actions as an extensible contract.
 *
 * Every case here drives the real rail: a descriptor list goes in, controls come
 * out, and a handler is asserted from the test body afterwards.
 */

const ROW_IDS = ["row-1", "row-2", "row-3"];
const TAG_NAME = /^Tag$/;
const TAG_AS_REVIEWED_NAME = /^Tag as reviewed$/;
const CREATE_ROW_NAME = /^Create “Brand new”$/;

function renderRail(
  actions: readonly TableBulkActionDescriptor[],
  overrides: {
    rowIds?: readonly string[];
    selection?: Partial<TableBulkSelectionControls>;
  } = {}
) {
  const selection: TableBulkSelectionControls = {
    clear: overrides.selection?.clear ?? vi.fn(),
    retain: overrides.selection?.retain ?? vi.fn(),
  };
  render(
    <TableBulkActionBar
      actionLabel="3 rows selected"
      actions={
        <TableBulkActions
          actions={actions}
          rowIds={overrides.rowIds ?? ROW_IDS}
          selection={selection}
        />
      }
    />
  );
  return {
    selection,
    toolbar: screen.getByRole("toolbar", { name: "3 rows selected" }),
  };
}

function favoriteAction(
  onSelect: (
    rowIds: readonly string[],
    selection: TableBulkSelectionControls
  ) => void
): TableBulkActionDescriptor {
  return {
    icon: <StarIcon />,
    id: "favorite",
    kind: "command",
    undo: TableBulkActionUndo.NotImplemented,
    label: "Favorite rows",
    onSelect,
  };
}

describe("TableBulkActions — the extension point", () => {
  it("renders one control per descriptor, so a new action is one more entry", () => {
    const { toolbar } = renderRail([
      favoriteAction(() => undefined),
      {
        icon: <TagIcon />,
        id: "archive",
        kind: "command",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Archive rows",
        onSelect: () => undefined,
      },
    ]);

    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Favorite rows", "Archive rows"]);
  });

  it("keeps two actions whose names share a prefix separately reachable", () => {
    const { toolbar } = renderRail([
      {
        icon: <TagIcon />,
        id: "tag",
        kind: "command",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Tag",
        onSelect: () => undefined,
      },
      {
        icon: <TagIcon />,
        id: "tag-reviewed",
        kind: "command",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Tag as reviewed",
        onSelect: () => undefined,
      },
    ]);

    expect(
      within(toolbar).getByRole("button", { name: TAG_NAME })
    ).toHaveAttribute("aria-label", "Tag");
    expect(
      within(toolbar).getByRole("button", { name: TAG_AS_REVIEWED_NAME })
    ).toHaveAttribute("aria-label", "Tag as reviewed");
  });

  it("leaves an action the host cannot offer ABSENT rather than dead", () => {
    const { toolbar } = renderRail([favoriteAction(() => undefined)]);
    // The positive half: an action that IS offered is present and operable.
    expect(
      within(toolbar).getByRole("button", { name: "Favorite rows" })
    ).toBeEnabled();
    // The withheld one is not in the list at all — no disabled stand-in.
    expect(
      within(toolbar).queryByRole("button", { name: "Archive rows" })
    ).toBe(null);
  });

  it("disables only an action whose OWN mutation is in flight", () => {
    const { toolbar } = renderRail([
      { ...favoriteAction(() => undefined), isPending: true },
      {
        icon: <TagIcon />,
        id: "archive",
        kind: "command",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Archive rows",
        onSelect: () => undefined,
      },
    ]);

    expect(
      within(toolbar).getByRole("button", { name: "Favorite rows" })
    ).toBeDisabled();
    expect(
      within(toolbar).getByRole("button", { name: "Archive rows" })
    ).toBeEnabled();
  });

  it("hands a handler the SELECTED row ids and nothing it derived itself", () => {
    const onSelect = vi.fn();
    // A collapsed group band's hidden rows are not in the selection, so they
    // are not in `rowIds` — the rail never widens what the reader picked.
    const { toolbar } = renderRail([favoriteAction(onSelect)], {
      rowIds: ["parent-1"],
    });

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Favorite rows" })
    );

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toEqual(["parent-1"]);
  });

  it("lets an action clear or narrow the selection it acted on", () => {
    const clear = vi.fn();
    const retain = vi.fn();
    const { toolbar } = renderRail(
      [
        favoriteAction((_rowIds, selection) => selection.clear()),
        {
          icon: <TagIcon />,
          id: "archive",
          kind: "command",
          undo: TableBulkActionUndo.NotImplemented,
          label: "Archive rows",
          onSelect: (_rowIds, selection) => selection.retain(["row-3"]),
        },
      ],
      { selection: { clear, retain } }
    );

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Favorite rows" })
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(retain).not.toHaveBeenCalled();

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Archive rows" })
    );
    expect(retain).toHaveBeenCalledWith(["row-3"]);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("TableBulkActions — the picker kind", () => {
  const pickerAction = (
    onSelect: (
      rowIds: readonly string[],
      option: TableBulkActionOption,
      selection: TableBulkSelectionControls
    ) => Promise<boolean> | boolean
  ): TableBulkPickerDescriptor => ({
    emptyLabel: "No matches",
    icon: <TagIcon />,
    id: "tags",
    kind: "picker",
    undo: TableBulkActionUndo.NotImplemented,
    label: "Add tag",
    onSelect,
    options: [
      { id: "prototype", label: "Prototype" },
      { id: "sessions", label: "Sessions" },
    ],
    search: { label: "Search add tag", placeholder: "Search..." },
  });

  it("applies the chosen option against the selection and closes", async () => {
    const onSelect = vi.fn(
      (
        _rowIds: readonly string[],
        _option: TableBulkActionOption,
        _selection: TableBulkSelectionControls
      ) => true
    );
    const { toolbar } = renderRail([pickerAction(onSelect)]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));
    fireEvent.click(await screen.findByRole("button", { name: "Prototype" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toEqual(ROW_IDS);
    expect(onSelect.mock.calls[0]?.[1]).toMatchObject({ id: "prototype" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Prototype" })).toBe(null)
    );
  });

  it("stays open when the action reports it did not land", async () => {
    const onSelect = vi.fn(() => false);
    const { toolbar } = renderRail([pickerAction(onSelect)]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Sessions" })).toBeVisible();
  });

  it("offers a create row only when the descriptor can create AND names it", async () => {
    const { toolbar } = renderRail([
      {
        ...pickerAction(() => true),
        createOptionLabel: (query) => `Create “${query}”`,
        id: "creatable",
        onCreateOption: () => true,
      },
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Brand new" },
    });

    expect(
      await screen.findByRole("button", { name: CREATE_ROW_NAME })
    ).toBeVisible();
  });

  it("offers NO create row for a descriptor with no create seam", async () => {
    const { toolbar } = renderRail([pickerAction(() => true)]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Brand new" },
    });

    // The same query that grows a create row above grows only the honest
    // "no matches" sentence here.
    expect(screen.queryByRole("button", { name: CREATE_ROW_NAME })).toBe(null);
    expect(screen.getByText("No matches")).toBeVisible();
  });

  it("offers NO create row when nothing would name it", async () => {
    const { toolbar } = renderRail([
      {
        ...pickerAction(() => true),
        id: "unnamed",
        onCreateOption: () => true,
      },
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "Brand new" },
    });

    expect(screen.queryByRole("button", { name: CREATE_ROW_NAME })).toBe(null);
    expect(screen.getByText("No matches")).toBeVisible();
  });

  it("names the option row from its label when the body is icon-only", async () => {
    const onSelect = vi.fn(
      (
        _rowIds: readonly string[],
        _option: TableBulkActionOption,
        _selection: TableBulkSelectionControls
      ) => true
    );
    const { toolbar } = renderRail([
      {
        ...pickerAction(onSelect),
        options: [
          { content: <TagIcon />, id: "prototype", label: "Prototype" },
          { content: <TagIcon />, id: "sessions", label: "Sessions" },
        ],
      },
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));

    // A body of pure glyph announces nothing; the option's label is the only
    // thing that tells the two rows apart, so it has to be the accessible name.
    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    expect(onSelect.mock.calls[0]?.[1]).toMatchObject({ id: "sessions" });
  });

  it("names the search field, and grows none for a descriptor without one", async () => {
    const { toolbar } = renderRail([pickerAction(() => true)]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));

    expect(
      await screen.findByRole("textbox", { name: "Search add tag" })
    ).toBeVisible();
  });

  it("grows no search field for a descriptor that carries no search", async () => {
    const { toolbar } = renderRail([
      { ...pickerAction(() => true), search: undefined },
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));

    // Positive control on the same selector: the option rows prove the popover
    // opened, so the missing textbox is the omission and not an unmounted list.
    expect(
      await screen.findByRole("button", { name: "Prototype" })
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBe(null);
  });

  it("says so when nothing matches instead of showing an empty list", async () => {
    const { toolbar } = renderRail([
      {
        emptyLabel: "No tags available",
        icon: <TagIcon />,
        id: "tags",
        kind: "picker",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Add tag",
        onSelect: () => true,
        options: [],
      },
    ]);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Add tag" }));

    expect(await screen.findByText("No tags available")).toBeVisible();
  });
});

describe("TableBulkActions — a host whose bar is not the rail", () => {
  it("uses a descriptor's own chrome when it carries one, and the rail's otherwise", () => {
    const onSelect = vi.fn();
    const { toolbar } = renderRail([
      {
        ...favoriteAction(onSelect),
        render: ({ rowIds, selection }) => (
          <button onClick={() => onSelect(rowIds, selection)} type="button">
            Favorite (host chrome)
          </button>
        ),
      },
      {
        icon: <TagIcon />,
        id: "archive",
        kind: "command",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Archive rows",
        onSelect: () => undefined,
      },
    ]);

    // The overridden one renders the host's control, not the rail's icon button.
    expect(
      within(toolbar).getByRole("button", { name: "Favorite (host chrome)" })
    ).toBeVisible();
    expect(
      within(toolbar).queryByRole("button", { name: "Favorite rows" })
    ).toBe(null);
    // Its sibling, with no override, still gets the rail's control.
    expect(
      within(toolbar).getByRole("button", { name: "Archive rows" })
    ).toBeVisible();

    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Favorite (host chrome)" })
    );
    expect(onSelect.mock.calls[0]?.[0]).toEqual(ROW_IDS);
  });

  it("renders NOTHING for a host whose own chrome renders nothing", () => {
    const { toolbar } = renderRail([
      { ...favoriteAction(() => undefined), render: () => null },
      {
        icon: <TagIcon />,
        id: "archive",
        kind: "command",
        undo: TableBulkActionUndo.NotImplemented,
        label: "Archive rows",
        onSelect: () => undefined,
      },
    ]);

    // A host that deliberately renders nothing must not get the rail's control
    // back as a silent fallback; its sibling still proves the rail renders.
    expect(
      within(toolbar).queryByRole("button", { name: "Favorite rows" })
    ).toBe(null);
    expect(
      within(toolbar).getByRole("button", { name: "Archive rows" })
    ).toBeVisible();
  });
});

describe("TableBulkActionUndo (ISS-10161)", () => {
  /*
   * The field is REQUIRED on every descriptor, and `tsc` is what enforces that
   * — every construction site in this file and in the five production
   * producers had to answer it, and nothing below tries to re-prove that at
   * runtime. What this block guards is the vocabulary itself: that the three
   * states stay three distinct, deliberate answers.
   */

  it("keeps the three states distinct, so none can quietly alias another", () => {
    const values = Object.values(TableBulkActionUndo);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toHaveLength(3);
  });

  it("fails when a new state is added without a meaning for it", () => {
    /*
     * Enforced twice, not once. A member added to `TableBulkActionUndo` without
     * a key here fails `tsc`, and it also reds THIS case: vitest transpiles
     * without typechecking, so the key count is measured against the union's
     * own and a fourth state fails it on its own (verified — "expected […] to
     * have a length of 4 but got 3"). What the runtime half cannot catch is a
     * key MISSPELLED rather than missing — the count still matches, and `tsc`
     * is what rejects it.
     *
     * The field exists because undo was previously decided by SILENCE, and a
     * fourth state that nothing had to acknowledge would reintroduce it.
     */
    const meaning: Record<TableBulkActionUndo, string> = {
      [TableBulkActionUndo.Supported]: "offers a way back",
      [TableBulkActionUndo.Unsupported]: "deliberately withheld",
      [TableBulkActionUndo.NotImplemented]: "a gap, not a decision",
    };
    expect(Object.keys(meaning)).toHaveLength(
      Object.values(TableBulkActionUndo).length
    );
  });

  it("separates a withheld undo from an unbuilt one", () => {
    /*
     * The distinction this field exists for. A destructive action that will
     * never offer undo and a reversible action whose undo nobody wrote are not
     * the same fact, and a boolean would have collapsed them — which is exactly
     * how undo came to be per-host by omission in the first place.
     */
    expect(TableBulkActionUndo.Unsupported).not.toBe(
      TableBulkActionUndo.NotImplemented
    );
  });
});
