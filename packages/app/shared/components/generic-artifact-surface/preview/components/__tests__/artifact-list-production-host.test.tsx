// @vitest-environment jsdom
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GenericArtifactStatus } from "../../../generic-artifact-status";
import { ArtifactKind } from "../../fixtures";
import { useGenericArtifactListController } from "../artifact-list-shell-controller";
import { artifactSavedViewRecordSchema } from "../artifact-saved-views";
import { GenericArtifactListView } from "../artifact-shells";
import {
  listRow,
  renderListController,
} from "./support/list-controller-harness";

const rows = [
  listRow("one", {
    kind: ArtifactKind.Document,
    owner: "Ada",
    ownerId: "ada-1",
  }),
  listRow("two", {
    kind: ArtifactKind.Document,
    owner: "Ada",
    ownerId: "ada-2",
  }),
];
const referenceRows = rows.slice(0, 1);
const EXECUTED_MENU_ITEM = /Executed$/;
const referenceWrites = vi.fn();
const reconciliationWrites = vi.fn();
let reconciliationController:
  | ReturnType<typeof useGenericArtifactListController>
  | undefined;
beforeEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  reconciliationWrites.mockClear();
  reconciliationController = undefined;
  referenceWrites.mockClear();
});
function MountedHost() {
  const controller = useGenericArtifactListController({
    artifacts: rows,
    onOpenArtifact: vi.fn(),
    controlledArtifacts: true,
    defaultVisibleColumnIds: ["owner", "status"],
    showAddFieldButton: true,
  });
  return (
    <GenericArtifactListView
      controller={controller}
      host={{
        search: { onChange: vi.fn(), value: "" },
        summary: <div>Canonical metrics</div>,
        creation: <div>Real field dialog</div>,
        bulkActions: null,
        pagination: <div>Authoritative pagination</div>,
        renderCell: (column, row) => (
          <span>
            {column}:{row.id}
          </span>
        ),
        renderLead: (row) => <span>Production {row.title}</span>,
      }}
    />
  );
}

function MountedReferenceList() {
  const controller = useGenericArtifactListController({
    artifacts: referenceRows,
    controlledArtifacts: true,
    onArtifactsChange: referenceWrites,
    onOpenArtifact: vi.fn(),
  });
  return <GenericArtifactListView controller={controller} host={{}} />;
}

function ReconciliationHost() {
  const controller = useGenericArtifactListController({
    artifacts: rows,
    onOpenArtifact: vi.fn(),
    controlledArtifacts: true,
  });
  reconciliationController = controller;
  return (
    <GenericArtifactListView
      controller={{
        ...controller,
        reconcileSelection: (renderedRows) => {
          reconciliationWrites(renderedRows);
          controller.reconcileSelection(renderedRows);
        },
      }}
      host={{}}
    />
  );
}
describe("production ports on exact prototype renderer", () => {
  it("[DT-24] keeps the reference narrow status editable with a compact trigger", async () => {
    const user = userEvent.setup();
    const restoreWidth = stubResponsiveNarrowViewport(true).restore;
    try {
      render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
          })}
        >
          <MountedReferenceList />
        </FeatureFlagAdapterProvider>
      );

      const row = document.querySelector('[data-grid-row-id="one"]');
      if (!(row instanceof HTMLElement)) {
        throw new Error("Reference row was not rendered");
      }
      const status = within(row).getByRole("button", { name: "In review" });
      expect(status).toHaveClass("h-7", "w-7");
      expect(within(row).getByRole("link")).toHaveClass("flex-1");
      expect(within(row).getByText("one")).toHaveClass(
        "min-w-0",
        "flex-1",
        "truncate"
      );
      await user.click(status);
      await user.click(
        await screen.findByRole("menuitem", {
          name: EXECUTED_MENU_ITEM,
        })
      );
      await waitFor(() => expect(referenceWrites).toHaveBeenCalledTimes(1));
      expect(referenceWrites.mock.calls[0]?.[0][0]).toMatchObject({
        id: "one",
        status: GenericArtifactStatus.Completed,
      });
    } finally {
      restoreWidth();
    }
  });

  it("retains reference toolbar and grid while using host-owned cells and dialogs", () => {
    render(<MountedHost />);
    for (const text of [
      "7d",
      "30d",
      "60d",
      "90d",
      "All",
      "Canonical metrics",
      "Authoritative pagination",
      "Real field dialog",
      "Production one",
      "owner:one",
    ]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByRole("button", { name: "Add field" }).length).toBe(2);
    expect(screen.getByLabelText("Filter items")).toBeTruthy();
  });
  it("writes selection reconciliation exactly once when board replaces the grid", () => {
    render(<ReconciliationHost />);
    if (!reconciliationController) {
      throw new Error("Artifact List reconciliation host did not mount");
    }
    act(() =>
      reconciliationController?.setSelectedArtifactIds(new Set([rows[0]!.id]))
    );
    reconciliationWrites.mockClear();

    fireEvent.click(screen.getAllByRole("radio", { name: "Board view" })[0]!);

    expect(reconciliationWrites).toHaveBeenCalledExactlyOnceWith([]);
    expect(reconciliationController.selectedArtifactIds).toEqual(new Set());
  });
  it("uses persisted identity for Mine even when people share a display name", () => {
    const hook = renderListController({
      artifacts: rows,
      onOpenArtifact: vi.fn(),
      currentUser: { id: "ada-2", name: "Ada" },
    });
    act(() =>
      hook.result.current.setFilters((state) => ({ ...state, mineOnly: true }))
    );
    expect(hook.result.current.sortedArtifacts.map((row) => row.id)).toEqual([
      "two",
    ]);
  });
  it("restores org-scoped columns, metrics and widths without carrying them to another org", async () => {
    const props = {
      artifacts: rows,
      onOpenArtifact: vi.fn(),
      persistenceKey: "org-a",
      defaultVisibleColumnIds: ["owner", "status"],
    };
    const hook = renderListController(props);
    act(() => {
      hook.result.current.setVisibleColumnIds(new Set(["status"]));
      hook.result.current.setVisibleMetricKeys(new Set(["estimatedSpend"]));
      hook.result.current.setColumnOrder(["status", "owner"]);
      hook.result.current.setColumnWidths({ status: 240 });
    });
    await waitFor(() =>
      expect(hook.result.current.columnWidths.status).toBe(240)
    );
    hook.unmount();
    const restored = renderListController(props);
    expect([...restored.result.current.visibleColumnIds]).toEqual(["status"]);
    expect(restored.result.current.columnWidths.status).toBe(240);
    expect([...restored.result.current.visibleMetricKeys]).toEqual([
      "estimatedSpend",
    ]);
    restored.unmount();
    window.history.replaceState({}, "", "/");
    const isolated = renderListController({
      ...props,
      persistenceKey: "org-b",
    });
    expect([...isolated.result.current.visibleColumnIds]).toEqual([
      "owner",
      "status",
    ]);
    expect(isolated.result.current.columnWidths.status).toBeUndefined();
    expect([...isolated.result.current.visibleMetricKeys]).toEqual(
      isolated.result.current.summaryMetricDefinitions.map(
        (metric) => metric.key
      )
    );
  });
  it("uses actual identity owner groups and the canonical unassigned group, without fixture people", () => {
    const hook = renderListController({
      artifacts: [
        ...rows,
        listRow("unassigned", { ownerId: null, owner: "Unassigned" }),
      ],
      onOpenArtifact: vi.fn(),
    });
    act(() => hook.result.current.setGroupBy("owner"));
    expect(
      hook.result.current.groupedArtifacts?.map((group) => group.key)
    ).toEqual(["ada-1", "ada-2", "No value"]);
    expect(
      hook.result.current.groupedArtifacts?.find(
        (group) => group.key === "No value"
      )?.label
    ).toBe("Unassigned");
  });
  it("persists saved views with actual selection instead of reporting a transient save", async () => {
    const props = {
      artifacts: rows,
      onOpenArtifact: vi.fn(),
      persistenceKey: "saved-view-org",
    };
    const hook = renderListController(props);
    act(() => hook.result.current.setVisibleColumnIds(new Set(["owner"])));
    act(() => {
      hook.result.current.setExtensionFilters({
        "document-type": { selectedValues: ["PRD"] },
      });
      hook.result.current.setCustomFieldFilters({ "custom-count": { min: 3 } });
    });
    act(() => hook.result.current.saveCurrentView("My document view"));
    await waitFor(() =>
      expect(
        hook.result.current.savedViews.some(
          (view) => view.name === "My document view"
        )
      ).toBe(true)
    );
    hook.unmount();
    const restored = renderListController(props);
    expect(
      restored.result.current.savedViews.some(
        (view) => view.name === "My document view"
      )
    ).toBe(true);
    const saved = restored.result.current.savedViews.find(
      (view) => view.name === "My document view"
    );
    if (!saved) {
      throw new Error("saved view missing");
    }
    act(() => restored.result.current.applySavedView(saved.id));
    expect(restored.result.current.extensionFilters).toEqual({
      "document-type": { selectedValues: ["PRD"] },
    });
    expect(restored.result.current.customFieldFilters).toEqual({
      "custom-count": { min: 3 },
    });
    expect(
      artifactSavedViewRecordSchema.safeParse({
        ...saved,
        state: { ...saved.state, dateRange: 30 },
      }).success
    ).toBe(false);
    expect(
      artifactSavedViewRecordSchema.safeParse({
        ...saved,
        state: {
          ...saved.state,
          filters: { ...saved.state.filters, updatedPreset: "unexpected" },
        },
      }).success
    ).toBe(false);
    const {
      extensionFilters: _extensions,
      customFieldFilters: _custom,
      ...legacyState
    } = saved.state;
    expect(
      artifactSavedViewRecordSchema.safeParse({ ...saved, state: legacyState })
        .success
    ).toBe(true);
  });
});
