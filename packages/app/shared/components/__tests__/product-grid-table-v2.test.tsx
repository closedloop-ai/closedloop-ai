import {
  ProductGridTableListSurface,
  ProductGridTableV2,
} from "@repo/app/shared/components/product-grid-table-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  GridContextualAction,
  GridInteractionContract,
} from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridTableListSurface } from "@repo/design-system/components/ui/grid-table-list-surface";
import { GRID_TABLE_V2_NARROW_LEADING_LABEL } from "@repo/design-system/components/ui/grid-table-v2";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string; status: string };

const ROW: Row = { id: "row-1", name: "Alpha", status: "Active" };
const FAILED_GROUP_LABEL = /Failed/;
const originalVisualViewport = Object.getOwnPropertyDescriptor(
  globalThis.window,
  "visualViewport"
);

afterEach(() => {
  if (originalVisualViewport) {
    Object.defineProperty(
      globalThis.window,
      "visualViewport",
      originalVisualViewport
    );
    return;
  }
  Reflect.deleteProperty(globalThis.window, "visualViewport");
});

describe("PRD-727 rollout boundary", () => {
  it("keeps captured-main cards when the shared web/Desktop flag is off", () => {
    renderGrid([], true, "compact");

    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByTestId("compatibility-card")).toHaveTextContent(
      "Alpha:Status"
    );
  });

  it("keeps the flag-on grid when card compatibility does not opt in", () => {
    renderGrid([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY], true, "compact");

    expect(screen.getByRole("grid")).toBeVisible();
    expect(screen.queryByTestId("compatibility-card")).toBeNull();
  });

  it("renders opt-in compatibility cards in compact mode with the flag on", () => {
    renderGrid([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY], true, "compact", true);

    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByTestId("compatibility-card")).toHaveTextContent(
      "Alpha:Status"
    );
  });

  it("renders the grid in expanded mode even when cards opt in", () => {
    renderGrid([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY], true, "expanded", true);

    expect(screen.getByRole("grid")).toBeVisible();
    expect(screen.queryByTestId("compatibility-card")).toBeNull();
  });

  it("reports post-collapse visible cards to the selection host while the flag is off", () => {
    const inactiveRow: Row = {
      id: "row-2",
      name: "Beta",
      status: "Inactive",
    };
    const onRenderedItemsChange = vi.fn();
    renderWithFlags(
      <ProductGridTableV2<Row>
        cardCompatibility={{
          render: (row) => <div>{row.name}</div>,
        }}
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(12rem, 1fr) 8rem"
        groups={[
          { key: "failed", label: "Failed", items: [ROW] },
          { key: "inactive", label: "Inactive", items: [inactiveRow] },
        ]}
        items={[ROW, inactiveRow]}
        leadingLabel="Artifact"
        mode="compact"
        onRenderedItemsChange={onRenderedItemsChange}
        renderCell={(_columnId, row) => row.status}
        renderLead={(row) => row.name}
      />,
      []
    );

    expect(onRenderedItemsChange).toHaveBeenLastCalledWith([ROW, inactiveRow]);
    fireEvent.click(screen.getByRole("button", { name: FAILED_GROUP_LABEL }));
    expect(onRenderedItemsChange).toHaveBeenLastCalledWith([inactiveRow]);
    expect(screen.queryByText(ROW.name)).toBeNull();
    expect(screen.getByText(inactiveRow.name)).toBeVisible();
  });

  it("switches the flag-on production grid when browser zoom narrows the visual viewport", () => {
    const viewport = installVisualViewport(1280);
    renderGrid([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);

    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    act(() => {
      viewport.width = 640;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(
      screen.getByRole("columnheader", {
        name: GRID_TABLE_V2_NARROW_LEADING_LABEL,
      })
    ).toBeVisible();
  });

  it("preserves an in-progress row editor and focus across both auto-width transitions", () => {
    const viewport = installVisualViewport(1280);
    renderWithFlags(
      <ProductGridTableV2<Row>
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(12rem, 1fr) 8rem"
        items={[ROW]}
        leadingLabel="Artifact"
        mode="auto"
        renderCell={(_columnId, row) => row.status}
        renderLead={(row) => (
          <input aria-label="Rename" defaultValue={row.name} />
        )}
      />,
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]
    );
    const editor = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Rename",
    });
    fireEvent.change(editor, { target: { value: "Unsubmitted draft" } });
    editor.focus();

    act(() => {
      viewport.width = 640;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("textbox", { name: "Rename" })).toBe(editor);
    expect(editor).toHaveValue("Unsubmitted draft");
    expect(document.activeElement).toBe(editor);
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);

    act(() => {
      viewport.width = 1280;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("textbox", { name: "Rename" })).toBe(editor);
    expect(editor).toHaveValue("Unsubmitted draft");
    expect(document.activeElement).toBe(editor);
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("keeps the row editor mounted when the narrow lead gains its utility and selection siblings", () => {
    const viewport = installVisualViewport(1280);
    renderWithFlags(
      <ProductGridTableV2<Row>
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(12rem, 1fr) 8rem"
        isRowSelected={() => false}
        items={[ROW]}
        leadingLabel="Artifact"
        mode="auto"
        onRowSelectionToggle={vi.fn()}
        renderCell={(_columnId, row) => row.status}
        renderLead={(row) => (
          <input aria-label="Rename" defaultValue={row.name} />
        )}
        renderLeadingUtility={() => <span>utility</span>}
      />,
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]
    );
    const editor = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Rename",
    });
    fireEvent.change(editor, { target: { value: "Unsubmitted draft" } });
    editor.focus();

    act(() => {
      viewport.width = 640;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("checkbox", { name: "Select row" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Rename" })).toBe(editor);
    expect(editor).toHaveValue("Unsubmitted draft");
    expect(document.activeElement).toBe(editor);

    act(() => {
      viewport.width = 1280;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Rename" })).toBe(editor);
    expect(editor).toHaveValue("Unsubmitted draft");
    expect(document.activeElement).toBe(editor);
  });

  it("keeps the flag-on grid wide when the effective viewport remains wide", () => {
    installVisualViewport(1280);
    renderGrid([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);

    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
  });

  it("preserves generic header select-all across the adoption flag", () => {
    const onSelectAll = vi.fn();
    const table = (
      <ProductGridTableV2<Row>
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(12rem, 1fr) 8rem"
        items={[ROW]}
        leadingLabel="Artifact"
        mode="expanded"
        onSelectAll={onSelectAll}
        renderCell={(_columnId, row) => row.status}
        renderLead={(row) => row.name}
        showSelectAll
      />
    );

    const flagOff = renderWithFlags(table, []);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(onSelectAll).toHaveBeenCalledOnce();
    flagOff.unmount();

    renderWithFlags(table, [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);
    expect(screen.getByRole("checkbox", { name: "Select all" })).toBeVisible();
  });

  it("preserves an explicit expanded mode at a narrow viewport", () => {
    installVisualViewport(390);
    renderGrid([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY], false, "expanded");

    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
  });

  it("keeps captured-main cards for an unrelated flag at narrow width", () => {
    installVisualViewport(640);
    renderGrid(["responsive-narrow-grid-view"], true, "compact");

    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByTestId("compatibility-card")).toBeVisible();
  });

  it("keeps the composed surface in its captured-main compact mode while the flag is off", () => {
    renderWithFlags(
      <ProductGridTableListSurface
        mode="compact"
        table={(mode) => <div>{`table:${mode}`}</div>}
        toolbar={(mode) => <div>{`toolbar:${mode}`}</div>}
      />,
      []
    );

    expect(screen.getByText("table:compact")).toBeVisible();
    expect(screen.getByText("toolbar:compact")).toBeVisible();
  });

  it("renders the flag-off list with the same DOM as the direct shared surface", () => {
    const props = {
      table: (mode: "auto" | "compact" | "expanded") => (
        <div>{`table:${mode}`}</div>
      ),
      toolbar: (mode: "auto" | "compact" | "expanded") => (
        <div>{`toolbar:${mode}`}</div>
      ),
    };
    const direct = render(<GridTableListSurface {...props} />);
    const directMarkup = direct.container.innerHTML;
    direct.unmount();

    const adapted = renderWithFlags(
      <ProductGridTableListSurface {...props} />,
      []
    );
    expect(adapted.container.innerHTML).toBe(directMarkup);
  });
});

describe("ProductGridTableV2 interaction contract", () => {
  it("inherits an enabled ancestor contract without duplicating its marker", () => {
    const { container } = renderWithFlags(
      <GridInteractionContract state={GridInteractionState.Loading}>
        <ProductGridTableV2<Row>
          columns={[{ id: "status", label: "Status" }]}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(200px, 1fr) 120px"
          items={[ROW]}
          leadingLabel="Artifact"
          renderCell={(_columnId, row) => row.status}
          renderLead={(row) => row.name}
        />
      </GridInteractionContract>,
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]
    );

    expect(
      container.querySelectorAll(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).toHaveLength(1);
    expect(container.firstElementChild).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Loading
    );
    expect(container.querySelector('[role="grid"]')).not.toBeNull();
  });

  it("publishes its own state under a bare ancestor contract", () => {
    const { container } = renderWithFlags(
      <GridInteractionContract>
        <ProductGridTableV2<Row>
          columns={[{ id: "status", label: "Status" }]}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(200px, 1fr) 120px"
          interactionState={GridInteractionState.Loading}
          items={[ROW]}
          leadingLabel="Artifact"
          renderCell={(_columnId, row) => row.status}
          renderLead={(row) => row.name}
        />
      </GridInteractionContract>,
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]
    );

    expect(
      container.querySelectorAll("[data-grid-interaction-contract]")
    ).toHaveLength(1);
    const published = container.querySelector(
      `[data-interaction-state="${GridInteractionState.Loading}"]`
    );
    expect(published).toHaveAttribute("aria-busy", "true");
    expect(published?.querySelector('[role="grid"]')).not.toBeNull();
  });

  it("applies the mastered contract for the exact adoption key", () => {
    const { container } = renderInteractionGrid([
      GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
    ]);
    expect(
      container.querySelector(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).not.toBeNull();
  });

  it("activates the contract when missing adoption resolves enabled", () => {
    const missing = renderInteractionGrid([]);
    expect(
      missing.container.querySelector("[data-grid-interaction-contract]")
    ).toBeNull();
    missing.rerender(
      interactionGridWithFlags([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY])
    );
    expect(missing.container.querySelector('[role="grid"]')).not.toBeNull();
    expect(
      missing.container.querySelector("[data-grid-interaction-contract]")
    ).toHaveAttribute("data-grid-interaction-contract", "pointer-hover");
  });

  it("suppresses legacy contextual opacity only inside the enabled contract", () => {
    const enabled = renderInteractionGrid(
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      undefined,
      true
    );
    const disabled = renderInteractionGrid([], undefined, true);
    expect(
      enabled.container.querySelector("[data-grid-contextual-action]")
    ).not.toHaveClass("opacity-0");
    expect(
      disabled.container.querySelector("[data-grid-contextual-action]")
    ).toHaveClass("opacity-0");
  });

  it("keeps the contract marker off for the wrong adoption key", () => {
    const wrong = renderInteractionGrid(
      ["gridview-adoption-typo"],
      GridInteractionState.Error
    );
    expect(wrong.container.firstElementChild).toHaveAttribute("role", "grid");
    expect(
      wrong.container.querySelector("[data-grid-interaction-contract]")
    ).toBeNull();
    expect(wrong.container.firstElementChild).not.toHaveAttribute(
      "data-interaction-state"
    );
    expect(wrong.container.firstElementChild).not.toHaveAttribute(
      "aria-invalid"
    );
    expect(wrong.container.firstElementChild).not.toHaveAttribute("aria-busy");
  });

  it("publishes a supplied domain-free state only on the mastered path", () => {
    const loading = renderInteractionGrid(
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      GridInteractionState.Loading
    );
    const wrapper = loading.container.firstElementChild;
    expect(wrapper).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Loading
    );
    expect(wrapper).toHaveAttribute("aria-busy", "true");
    expect(wrapper).not.toHaveAttribute("aria-invalid");
    loading.rerender(
      interactionGridWithFlags([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY])
    );
    expect(loading.container.firstElementChild).toBe(wrapper);
    expect(wrapper).not.toHaveAttribute("data-interaction-state");
    expect(wrapper).not.toHaveAttribute("aria-busy");
    expect(wrapper).not.toHaveAttribute("aria-invalid");
  });
});

function renderInteractionGrid(
  enabledFlags: readonly string[],
  interactionState?: GridInteractionState,
  renderLegacyAction = false
) {
  return render(
    interactionGridWithFlags(enabledFlags, interactionState, renderLegacyAction)
  );
}

function interactionGridWithFlags(
  enabledFlags: readonly string[],
  interactionState?: GridInteractionState,
  renderLegacyAction = false
) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ProductGridTableV2<Row>
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(200px, 1fr) 120px"
        interactionState={interactionState}
        items={[ROW]}
        leadingLabel="Artifact"
        renderCell={(_columnId, row) =>
          renderLegacyAction ? (
            <GridContextualAction asChild legacyReveal="row">
              <button type="button">Edit</button>
            </GridContextualAction>
          ) : (
            row.status
          )
        }
        renderLead={(row) => row.name}
      />
    </FeatureFlagAdapterProvider>
  );
}

function renderGrid(
  enabledFlags: string[],
  withCompatibility = false,
  mode: "auto" | "compact" | "expanded" = "auto",
  alwaysActive = false
) {
  return renderWithFlags(
    <ProductGridTableV2<Row>
      cardCompatibility={
        withCompatibility
          ? {
              ...(alwaysActive ? { alwaysActive: true as const } : {}),
              render: (row, columns) => (
                <div data-testid="compatibility-card">
                  {`${row.name}:${columns[0]?.label}`}
                </div>
              ),
            }
          : undefined
      }
      columns={[{ id: "status", label: "Status" }]}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(12rem, 1fr) 8rem"
      items={[ROW]}
      leadingLabel="Artifact"
      mode={mode}
      renderCell={(_columnId, row) => row.status}
      renderLead={(row) => row.name}
    />,
    enabledFlags
  );
}

function installVisualViewport(width: number) {
  const viewport = Object.assign(new EventTarget(), { width });
  Object.defineProperty(globalThis.window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

function renderWithFlags(node: ReactNode, enabledFlags: string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      {node}
    </FeatureFlagAdapterProvider>
  );
}
