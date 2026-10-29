import {
  createStoryDataTransfer,
  fireStoryDrag,
} from "@repo/app/shared/storybook/story-drag";
import { Alert, AlertTitle } from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  GridContextualAction,
  GridInteractionContract,
} from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridRowDragHandle } from "@repo/design-system/components/ui/grid-row-drag-handle";
import {
  GridTableV2,
  type GridTableV2Column,
} from "@repo/design-system/components/ui/grid-table-v2";
import { InlineNameCell } from "@repo/design-system/components/ui/inline-name-cell";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  TableCellValueState,
  TableIdentityCell,
  TableTextCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { GRID_ROW_DRAG_TYPE } from "@repo/design-system/lib/grid-table-v2-group-drop";
import { GridTableV2Mode } from "@repo/design-system/lib/grid-table-v2-types";
import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircleIcon, CircleDotIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

const PointerContractState = {
  Default: "default",
  Selected: "selected",
  Editing: "editing",
  Dragging: "dragging",
  DragOver: "drag-over",
  Disabled: "disabled",
  Loading: "loading",
  Error: "error",
} as const;
type PointerContractState =
  (typeof PointerContractState)[keyof typeof PointerContractState];

const CONTRACT_ROW_ID = "ISS-9354";
const CONTRACT_ROW_NAME = "Pointer and hover contract";
const EDIT_NAME_LABEL = `Edit artifact name for ${CONTRACT_ROW_ID}`;
const RENAMED_ROW_NAME = "Pointer, cursor and hover contract";

const meta = {
  title: "Primitives/Data Display/Grid Interaction Contract",
  tags: ["stable", "autodocs"],
  component: PointerContractDemo,
  args: {
    narrow: false,
    revealActions: false,
    state: PointerContractState.Default,
  },
  argTypes: {
    narrow: { control: "boolean" },
    revealActions: { control: "boolean" },
    state: {
      control: { type: "select" },
      options: [
        "default",
        "selected",
        "editing",
        "dragging",
        "drag-over",
        "disabled",
        "loading",
        "error",
      ],
    },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PointerContractDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: { state: PointerContractState.Loading },
  play: async ({ canvasElement }) => {
    const contract = getInteractionContract(canvasElement);
    const row = getContractRow(canvasElement);
    await expect(contract).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Loading
    );
    await expect(contract).toHaveAttribute("aria-busy", "true");
    const skeleton = within(row).getByTestId("pointer-contract-loading");
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute("data-slot", "skeleton");
    await expect(skeleton).toHaveClass("bg-accent", "animate-pulse");
    await expect(within(row).queryAllByRole("button")).toHaveLength(0);
  },
};

export const ErrorState: Story = {
  args: { state: PointerContractState.Error },
  name: "Error",
  play: async ({ canvasElement }) => {
    const contract = getInteractionContract(canvasElement);
    const row = getContractRow(canvasElement);
    await expect(contract).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Error
    );
    await expect(contract).not.toHaveAttribute("aria-busy");
    const alert = within(row).getByRole("alert");
    await expect(alert.closest('[role="gridcell"]')).not.toBeNull();
    await expect(alert).toHaveClass("bg-destructive/12");
    await expect(within(alert).getByText(CONTRACT_ROW_NAME)).toBeVisible();
    await expect(alert.querySelector("svg")).toBeVisible();
    await expectContractRing(row);
  },
};

/**
 * `revealActions` holds the drag handle open. The name's edit control is
 * Inline Name Cell's own, so it shows the contract's real reveal: it appears
 * once the row holds focus.
 */
export const Hover: Story = {
  args: { revealActions: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const action = canvas.getByRole("button", { name: EDIT_NAME_LABEL });
    await expect(action).toHaveAttribute("data-grid-contextual-action", "");
    const handle = canvas.getByRole("button", {
      name: `Drag to reorder ${CONTRACT_ROW_ID}`,
    });
    await expect(handle).toHaveAttribute("data-grid-contextual-action", "");
    await expect(handle).toHaveAttribute("data-state", "open");
    handle.focus();
    // Painted only where the stylesheet applies (a real browser, not jsdom).
    if (isLaidOut(action)) {
      await waitFor(() => expect(getComputedStyle(action).opacity).toBe("1"));
    }
  },
};

/**
 * The grid takes one tab stop (its active cell); the next Tab reaches the
 * row's drag handle, which draws the shared focus ring.
 */
export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = getContractRow(canvasElement);
    await userEvent.tab();
    await expect(row.contains(document.activeElement)).toBe(true);
    await userEvent.tab();
    await expect(
      canvas.getByRole("button", { name: `Drag to reorder ${CONTRACT_ROW_ID}` })
    ).toHaveFocus();
  },
};

export const Selected: Story = {
  args: { state: PointerContractState.Selected },
  play: async ({ canvasElement }) => {
    const row = getContractRow(canvasElement);
    await expect(row).toHaveAttribute("data-state", "selected");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveClass("bg-primary/10");
    await expectContractRing(row);
    const marker = within(row).getByRole("checkbox", {
      name: CONTRACT_ROW_NAME,
    });
    await expect(marker).toBeChecked();
    await expect(marker).toHaveAttribute("aria-readonly", "true");
    await expect(
      marker.querySelector('[data-slot="checkbox-indicator"]')
    ).toBeVisible();
  },
};

/**
 * The pencil opens the name editor; Enter commits the draft, the row shows the
 * new name, and the pencil opens it again on the committed value.
 */
export const Editing: Story = {
  args: { state: PointerContractState.Editing },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = getContractRow(canvasElement);
    await expect(getInteractionContract(canvasElement)).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Editing
    );
    await userEvent.click(
      canvas.getByRole("button", { name: EDIT_NAME_LABEL })
    );
    const editor = canvas.getByRole("textbox", { name: EDIT_NAME_LABEL });
    await userEvent.click(editor);
    await expect(editor).toHaveFocus();
    await userEvent.clear(editor);
    await userEvent.type(editor, `${RENAMED_ROW_NAME}{Enter}`);
    await waitFor(() =>
      expect(
        canvas.queryByRole("textbox", { name: EDIT_NAME_LABEL })
      ).toBeNull()
    );
    await expect(within(row).getByText(RENAMED_ROW_NAME)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: EDIT_NAME_LABEL })
    );
    const reopened = canvas.getByRole("textbox", { name: EDIT_NAME_LABEL });
    await expect(reopened).toHaveFocus();
    await expect(reopened).toHaveValue(RENAMED_ROW_NAME);
  },
};

/** Eligible title whitespace starts the same row drag as the visible handle. */
export const Dragging: Story = {
  args: { state: PointerContractState.Dragging },
  play: async ({ canvasElement }) => {
    const row = getContractRow(canvasElement);
    const handle = within(row).getByRole("button", {
      name: `Drag to reorder ${CONTRACT_ROW_ID}`,
    });
    await expect(handle).toBeVisible();
    const titleDragOrigin = within(row).getByTestId(
      "pointer-contract-title-drag-origin"
    );
    const dataTransfer = createStoryDataTransfer();
    fireStoryDrag(titleDragOrigin, "dragstart", 0, 0, dataTransfer);
    await expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe(
      CONTRACT_ROW_ID
    );
    await waitFor(() =>
      expect(row).toHaveAttribute(
        "data-interaction-state",
        GridInteractionState.Dragging
      )
    );
  },
};

export const DragOver: Story = {
  args: { state: PointerContractState.DragOver },
};

export const Disabled: Story = {
  args: { state: PointerContractState.Disabled },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};

export const Narrow: Story = {
  args: {
    narrow: true,
    revealActions: true,
    state: PointerContractState.Default,
  },
  globals: { viewport: { value: "390-844" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cards = canvasElement.querySelectorAll<HTMLElement>(
      "[data-grid-card-id]"
    );
    await expect(cards).toHaveLength(CARD_COUNT);
    const firstCard = cards.item(0);
    if (!firstCard) {
      throw new Error("compact grid did not render its first card");
    }
    const firstAction = within(firstCard).getByRole("button", {
      name: EDIT_NAME_LABEL,
    });
    await expect(firstCard).toHaveClass("group/row");
    await expect(firstAction).toHaveAttribute(
      "data-grid-contextual-action",
      ""
    );
    await expect(
      firstAction.closest('[data-grid-interaction-contract="pointer-hover"]')
    ).not.toBeNull();
    await expect(firstAction).toHaveAttribute("data-state", "open");
    await userEvent.click(firstAction);
    await expect(
      canvas.getByTestId("pointer-contract-activation")
    ).toHaveTextContent("1");
  },
};

function PointerContractDemo({
  narrow,
  revealActions,
  state,
}: {
  narrow: boolean;
  revealActions: boolean;
  state: PointerContractState;
}) {
  if (narrow) {
    return <PointerContractCards revealActions={revealActions} state={state} />;
  }
  return <PointerContractGrid revealActions={revealActions} state={state} />;
}

function PointerContractGrid({
  revealActions,
  state,
}: {
  revealActions: boolean;
  state: PointerContractState;
}) {
  const [rows, setRows] = useState<readonly GridStoryRow[]>(WIDE_ROWS);
  const rename = (next: string) => {
    setRows((current) =>
      current.map((row) =>
        row.id === CONTRACT_ROW_ID ? { ...row, name: next } : row
      )
    );
  };
  const lead = (row: GridStoryRow) => {
    if (state === PointerContractState.Loading) {
      return (
        <Skeleton
          aria-hidden="true"
          className="h-5 w-full"
          data-testid={
            row.id === CONTRACT_ROW_ID ? "pointer-contract-loading" : undefined
          }
        />
      );
    }
    if (state === PointerContractState.Error) {
      return (
        <Alert variant="error">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>{row.name}</AlertTitle>
        </Alert>
      );
    }
    return (
      <PointerContractLead
        disabled={state === PointerContractState.Disabled}
        onRename={rename}
        revealActions={revealActions}
        row={row}
        selected={
          state === PointerContractState.Selected && row.id === CONTRACT_ROW_ID
        }
      />
    );
  };
  return (
    <GridInteractionContract state={resolveState(state)}>
      <div className="p-6">
        <GridTableV2<GridStoryRow>
          canDragRow={() => state !== PointerContractState.Disabled}
          columns={GRID_COLUMNS}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(320px, 1fr) minmax(200px, 1fr)"
          isRowSelected={
            state === PointerContractState.Selected
              ? (row) => row.id === CONTRACT_ROW_ID
              : undefined
          }
          items={[...rows]}
          leadingLabel="Name"
          mode={GridTableV2Mode.Expanded}
          onRowDrop={(source, target, placement) =>
            setRows((current) => moveRow(current, source, target, placement))
          }
          renderCell={(_columnId, row) =>
            state === PointerContractState.Loading ? (
              <TableTextCell state={TableCellValueState.Loading} />
            ) : (
              <TableTextCell value={row.summary} />
            )
          }
          renderLead={lead}
        />
        <div
          className="mt-4 rounded-md border p-4"
          data-interaction-state={
            state === PointerContractState.DragOver
              ? GridInteractionState.DragOver
              : undefined
          }
          data-testid="pointer-contract-band"
        >
          Done
        </div>
      </div>
    </GridInteractionContract>
  );
}

function PointerContractLead({
  disabled,
  onRename,
  revealActions,
  row,
  selected,
}: {
  disabled: boolean;
  onRename: (next: string) => void;
  revealActions: boolean;
  row: GridStoryRow;
  selected: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {selected ? (
        <Checkbox aria-label={row.name} aria-readonly checked />
      ) : null}
      <GridRowDragHandle
        aria-label={`Drag to reorder ${row.id}`}
        data-state={revealActions ? "open" : undefined}
        disabled={disabled}
      />
      <InlineNameCell
        className="min-w-0 flex-1"
        label={`Edit artifact name for ${row.id}`}
        onCommit={onRename}
        renderValue={(shown) => (
          <span data-testid="pointer-contract-title-drag-origin">
            <TableIdentityCell
              disabled={disabled}
              icon={CircleDotIcon}
              selected={selected}
              slug={row.id}
              title={shown}
            />
          </span>
        )}
        value={row.name}
      />
    </div>
  );
}

function PointerContractCards({
  revealActions,
  state,
}: {
  revealActions: boolean;
  state: PointerContractState;
}) {
  const [activations, setActivations] = useState(0);
  const [rowActivations, setRowActivations] = useState(0);
  return (
    <GridInteractionContract state={resolveState(state)}>
      <div className="mx-auto max-w-sm p-4">
        <span className="sr-only" data-testid="pointer-contract-activation">
          {activations}
        </span>
        <span className="sr-only" data-testid="pointer-contract-row-activation">
          {rowActivations}
        </span>
        <div
          className="h-64 space-y-3 overflow-y-auto"
          data-touch-scroll-region=""
        >
          <GridTableV2<GridStoryRow>
            cardRender={(row) => (
              <PointerContractCard
                onActivate={() => setActivations((count) => count + 1)}
                revealActions={revealActions}
                row={row}
              />
            )}
            columns={GRID_COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns="minmax(200px, 1fr) minmax(160px, 1fr)"
            items={[...CARD_ROWS]}
            leadingLabel="Name"
            mode={GridTableV2Mode.Compact}
            onRowClick={() => setRowActivations((count) => count + 1)}
            renderCell={(_columnId, row) => (
              <TableTextCell value={row.summary} />
            )}
            renderLead={(row) => (
              <TableIdentityCell
                icon={CircleDotIcon}
                slug={row.id}
                title={row.name}
              />
            )}
          />
        </div>
      </div>
    </GridInteractionContract>
  );
}

function PointerContractCard({
  onActivate,
  revealActions,
  row,
}: {
  onActivate: () => void;
  revealActions: boolean;
  row: GridStoryRow;
}) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <TableIdentityCell
          icon={CircleDotIcon}
          slug={row.id}
          title={row.name}
        />
        <GridContextualAction asChild open={revealActions}>
          <Button
            aria-label={`Edit artifact name for ${CONTRACT_ROW_ID}`}
            onClick={onActivate}
            size="icon-sm"
            variant="ghost"
          >
            <PencilIcon aria-hidden="true" />
          </Button>
        </GridContextualAction>
      </div>
    </div>
  );
}

type GridStoryRow = { id: string; name: string; summary: string };

const GRID_COLUMNS: readonly GridTableV2Column[] = [
  { id: "summary", label: "Summary" },
];

function resolveState(
  state: PointerContractState
): GridInteractionState | undefined {
  if (state === PointerContractState.Loading) {
    return GridInteractionState.Loading;
  }
  if (state === PointerContractState.Error) {
    return GridInteractionState.Error;
  }
  if (state === PointerContractState.Editing) {
    return GridInteractionState.Editing;
  }
  return undefined;
}

/** Moves `source` beside `target`; the handle has no "inside" for a flat list. */
function moveRow(
  rows: readonly GridStoryRow[],
  source: GridStoryRow,
  target: GridStoryRow,
  placement: "before" | "inside" | "after"
): readonly GridStoryRow[] {
  const rest = rows.filter((row) => row.id !== source.id);
  const targetIndex = rest.findIndex((row) => row.id === target.id);
  if (targetIndex === -1) {
    return rows;
  }
  const insertAt = placement === "before" ? targetIndex : targetIndex + 1;
  return [...rest.slice(0, insertAt), source, ...rest.slice(insertAt)];
}

function getInteractionContract(canvasElement: HTMLElement): HTMLElement {
  const contract = canvasElement.querySelector<HTMLElement>(
    '[data-grid-interaction-contract="pointer-hover"]'
  );
  if (!contract) {
    throw new Error("pointer contract wrapper did not render");
  }
  return contract;
}

/**
 * The contract's stylesheet draws the row's ring as an inset box shadow. It is
 * painted only where the stylesheet applies (a real browser, not jsdom).
 */
async function expectContractRing(row: HTMLElement) {
  if (isLaidOut(row)) {
    await expect(getComputedStyle(row).boxShadow).toMatch(INSET_SHADOW_PATTERN);
  }
}

function isLaidOut(element: HTMLElement): boolean {
  return element.getBoundingClientRect().width > 0;
}

const INSET_SHADOW_PATTERN = /inset/;

function getContractRow(canvasElement: HTMLElement): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${CONTRACT_ROW_ID}"]`
  );
  if (!row) {
    throw new Error("the contract row did not render");
  }
  return row;
}

const WIDE_ROWS: readonly GridStoryRow[] = [
  {
    id: CONTRACT_ROW_ID,
    name: CONTRACT_ROW_NAME,
    summary: "Rows, cards and their contextual actions",
  },
  {
    id: "ISS-9355",
    name: "Row drag handle",
    summary: "The six-dot reorder affordance",
  },
];

const CARD_IDS = [
  "card-1",
  "card-2",
  "card-3",
  "card-4",
  "card-5",
  "card-6",
  "card-7",
  "card-8",
] as const;
const CARD_ROWS: readonly GridStoryRow[] = CARD_IDS.map((id, index) => ({
  id,
  name: `Pointer contract card ${index + 1}`,
  summary: "A card in the compact grid",
}));
const CARD_COUNT = CARD_IDS.length;
