/**
 * ISS-9329: the project all-artifacts surface is `ArtifactBulkActionBar`'s
 * production host, behind the closed-by-default `artifact-bulk-action-bar` key.
 *
 * Driven through `DocumentsSelectionBar` rather than the rail directly, because
 * the thing the ticket asks for is a REAL ROUTE reaching the bar: rendering the
 * rail on its own would stay green if the selection bar stopped choosing it.
 */

import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { BULK_PRIORITY_ACTION_ID } from "@repo/app/documents/components/table/bulk-priority-picker";
import { BULK_STATUS_ACTION_ID } from "@repo/app/documents/components/table/bulk-status-picker";
import {
  type DocumentsBulkActionDescriptor,
  DocumentsBulkActionId,
} from "@repo/app/documents/components/table/documents-bulk-action-ids";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { BULK_TAG_ACTION_ID } from "@repo/app/tags/lib/bulk-tag-labels";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `useFeatureFlagEnabledOptional` returns a plain boolean and answers `false`
// with no provider mounted, so `false` here is the real closed state rather
// than a stand-in for an unresolved one.
const railGate = vi.hoisted(() => ({ enabled: false }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => railGate.enabled,
}));

/**
 * Stand-ins for the three mutation descriptors, carrying the pickers' OWN
 * exported ids and shipped labels. The real hooks read tags and mutate through
 * react-query and have their own coverage; what is under test here is which bar
 * the surface mounts and what reaches that bar. Stubbing them to `[]` would
 * have been the cheaper mock and a worse one — the rail would then never carry
 * a mutation control, so nothing here would notice if it stopped rendering them.
 */
const MUTATION_STUBS = vi.hoisted(() => [
  { id: "bulk-status", label: "Change Status" },
  { id: "bulk-priority", label: "Change Priority" },
  { id: "bulk-tag", label: "Add Tag" },
]);

vi.mock("@repo/app/documents/components/table/documents-bulk-actions", () => ({
  DocumentsBulkActions: () => <div data-testid="closed-gate-bulk-actions" />,
  useDocumentsBulkActionDescriptors: () =>
    MUTATION_STUBS.map((stub) => ({
      icon: null,
      id: stub.id,
      kind: "command" as const,
      label: stub.label,
      onSelect: () => undefined,
      undo: "not_implemented" as const,
    })),
}));
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [] }),
}));

import {
  DOCUMENTS_RAIL_ACTION_PERMISSIONS,
  DOCUMENTS_RAIL_DELETE_ACTION_ID,
  DOCUMENTS_RAIL_MERGE_ACTION_ID,
  DOCUMENTS_RAIL_MOVE_ACTION_ID,
  DOCUMENTS_RAIL_SESSION_AUTH_ONLY,
  DocumentsRailActionId,
  documentsRailActions,
} from "@repo/app/documents/components/table/documents-bulk-rail";
import { DocumentsSelectionBar } from "@repo/app/documents/components/table/documents-selection-bar";

const SELECTED_IDS = ["artifact-1", "artifact-2"];

function selectionBar(
  selectedIds: readonly string[],
  handlers: Handlers,
  manualPlacementEnabled = false
) {
  return (
    <DocumentsSelectionBar
      canBulkDelete={true}
      canBulkMove={true}
      canMerge={true}
      canUseDocumentActions={true}
      manualPlacementEnabled={manualPlacementEnabled}
      onBulkDelete={handlers.onBulkDelete}
      onBulkMove={handlers.onBulkMove}
      onClear={vi.fn()}
      onMerge={handlers.onMerge}
      onRetain={vi.fn()}
      selectedIds={[...selectedIds]}
      selectedRows={selectedIds.map((id) => makeArtifact({ id }))}
    />
  );
}

function renderSelectionBar(
  selectedIds: readonly string[] = SELECTED_IDS,
  manualPlacementEnabled = false
) {
  const handlers = {
    onBulkDelete: vi.fn(),
    onBulkMove: vi.fn(),
    onMerge: vi.fn(),
  };
  const { rerender } = render(
    selectionBar(selectedIds, handlers, manualPlacementEnabled),
    { wrapper: testQueryWrapper }
  );
  return {
    ...handlers,
    // Re-renders the SAME tree, which is the whole point of the announcement
    // cases below: a fresh `render` would mount a new region and prove nothing
    // about what a live region says while it is already in the document.
    select: (next: readonly string[]) =>
      rerender(selectionBar(next, handlers, manualPlacementEnabled)),
  };
}

describe("legacy selection bar layout", () => {
  it("retains the pre-manual-ordering inline spacing when the rail is off", () => {
    const { container } = render(
      selectionBar(SELECTED_IDS, {
        onBulkDelete: vi.fn(),
        onBulkMove: vi.fn(),
        onMerge: vi.fn(),
      })
    );
    const surface = container.querySelector(".pointer-events-auto");
    expect(surface).toHaveClass("gap-4");
    expect(surface).not.toHaveClass("flex-wrap");
  });
});

type Handlers = {
  onBulkDelete: () => void;
  onBulkMove: () => void;
  onMerge: () => void;
};

beforeEach(() => {
  railGate.enabled = false;
});

describe("ISS-9329 — the project surface hosts the artifact bulk bar", () => {
  it("mounts the shared artifact bar when the gate is open", () => {
    railGate.enabled = true;
    renderSelectionBar();

    expect(
      screen.getByRole("toolbar", { name: "2 artifacts selected" })
    ).toBeTruthy();
  });

  it("renders the existing selection bar and no artifact rail while the gate is closed", () => {
    renderSelectionBar(SELECTED_IDS, true);

    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear Selected" })).toBeTruthy();
    expect(screen.getByTestId("closed-gate-bulk-actions")).toBeTruthy();
    expect(screen.getByText("2 items selected").parentElement).toHaveClass(
      "max-w-full",
      "flex-wrap"
    );
    expect(
      screen.getByRole("button", { name: "Clear Selected" }).parentElement
    ).toHaveClass("min-w-0", "flex-wrap");
  });

  it("carries merge, move and delete onto the rail, so opening the gate removes nothing", () => {
    railGate.enabled = true;
    renderSelectionBar();
    const toolbar = screen.getByRole("toolbar");

    // The old controls remain, and the two shared actions reach the rail.
    for (const label of [
      "Change Status",
      "Change Priority",
      "Add Tag",
      "Favorite",
      "Assign owner",
      "Merge",
      "Move to Project",
      "Delete",
    ]) {
      const control = screen.getByRole("button", { name: label });
      // Inside the rail specifically: a control rendered beside it would
      // satisfy a bare name lookup while the rail itself was empty.
      expect(toolbar.contains(control)).toBe(true);
    }
  });

  it("states the selected count where a screen reader can hear it", () => {
    railGate.enabled = true;
    renderSelectionBar();

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 artifacts selected"
    );
  });

  it("announces the first selection, because the region is mounted before it", () => {
    railGate.enabled = true;
    const { select } = renderSelectionBar([]);

    // 0 -> 1 is the transition the rail could not make: mounted WITH the first
    // selection, the region arrives already holding the sentence and a live
    // region announces nothing it did not change.
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("No artifacts selected");
    expect(screen.queryByRole("toolbar")).toBeNull();

    select(["artifact-1"]);

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("1 artifact selected");
    expect(screen.getByRole("toolbar")).toBeTruthy();
  });

  it("announces the cleared state, because the region outlives the rail", () => {
    railGate.enabled = true;
    const { select } = renderSelectionBar();
    const region = screen.getByRole("status");

    select([]);

    // The rail is gone and the region is the same node, still speaking: the
    // clear is the other moment a region unmounting with the bar loses.
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("No artifacts selected");
  });

  it("routes the rail's Delete through the surface's confirmation request, never a mutation", async () => {
    railGate.enabled = true;
    const { onBulkDelete, onBulkMove, onMerge } = renderSelectionBar();

    // Scoped to the rail, not the document: the closed-gate bar carries its own
    // "Delete" wired to the same handler, so a bare name lookup stays green even
    // when the rail never mounted.
    const rail = within(screen.getByRole("toolbar"));
    await userEvent.click(rail.getByRole("button", { name: "Delete" }));

    // `onBulkDelete` is `requestBulkDelete`, which opens the surface's delete
    // confirmation dialog (DOC-36 R8: the one destructive action confirms
    // before it runs). Its siblings prove the click was not a blanket fan-out.
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
    expect(onBulkMove).not.toHaveBeenCalled();
    expect(onMerge).not.toHaveBeenCalled();
  });
});

describe("ISS-9329 AC4 — every control on the rail states its permission", () => {
  // Built from the pickers' own exported id constants, so a picker that renamed
  // its id breaks this rather than quietly falling out of the audit. The three
  // are the real mutation descriptors the rail carries; the production hook is
  // mocked away above, so they are supplied here instead of being invented.
  const mutationStubs: readonly DocumentsBulkActionDescriptor[] = Object.values(
    DocumentsBulkActionId
  ).map((id) => ({
    icon: null,
    id,
    kind: "command",
    label: id,
    onSelect: () => undefined,
    undo: TableBulkActionUndo.NotImplemented,
  }));

  // `vi.hoisted` runs before imports, so the mock's ids have to be literals.
  // This is what stops that from becoming a second, drifting copy: rename a
  // picker's id and the mounted-rail cases above go red here rather than
  // silently rendering a control the rail no longer recognises.
  it("mocks the mutation descriptors under the pickers' real ids", () => {
    expect(MUTATION_STUBS.map((stub) => stub.id)).toEqual([
      BULK_STATUS_ACTION_ID,
      BULK_PRIORITY_ACTION_ID,
      BULK_TAG_ACTION_ID,
    ]);
  });

  it("produces only ids the permission table declares", () => {
    const actions = documentsRailActions({
      canBulkDelete: true,
      canBulkMove: true,
      canMerge: true,
      mutations: mutationStubs,
      onBulkDelete: () => undefined,
      onBulkMove: () => undefined,
      onMerge: () => undefined,
    });

    // Length first: an empty list would satisfy a loop over nothing, which is
    // exactly what a rail that stopped producing actions would return.
    expect(actions).toHaveLength(6);
    // A MISSING rule is a tsc error: the table is an exhaustive Record over
    // `DocumentsRailActionId`, whose mutation half is spread from the hook's own
    // closed union. What tsc does not state is the SIZE of the set a reader
    // actually gets, so that is what this pins — six controls, every id
    // declared, none of them dropped on the way onto the rail.
    const declared = new Set<string>(Object.values(DocumentsRailActionId));
    expect(declared.size).toBe(8);
    for (const action of actions) {
      expect(declared.has(action.id)).toBe(true);
    }
  });

  it("assigns delete the delete scope and the rest write per DOC-36 R16, and states merge has no API-key path", () => {
    expect(
      DOCUMENTS_RAIL_ACTION_PERMISSIONS[DOCUMENTS_RAIL_DELETE_ACTION_ID]
    ).toBe(ApiKeyScope.Delete);
    expect(
      DOCUMENTS_RAIL_ACTION_PERMISSIONS[DOCUMENTS_RAIL_MOVE_ACTION_ID]
    ).toBe(ApiKeyScope.Write);
    expect(DOCUMENTS_RAIL_ACTION_PERMISSIONS[BULK_STATUS_ACTION_ID]).toBe(
      ApiKeyScope.Write
    );
    // ISS-11795: merge is session-only, so no scope can be stated for it.
    expect(
      DOCUMENTS_RAIL_ACTION_PERMISSIONS[DOCUMENTS_RAIL_MERGE_ACTION_ID]
    ).toBe(DOCUMENTS_RAIL_SESSION_AUTH_ONLY);
  });

  it("declares delete un-undoable, because it is confirmed beforehand instead", () => {
    const [deleteAction] = documentsRailActions({
      canBulkDelete: true,
      canBulkMove: false,
      canMerge: false,
      mutations: [],
      onBulkDelete: () => undefined,
      onBulkMove: () => undefined,
      onMerge: () => undefined,
    });

    expect(deleteAction.id).toBe(DOCUMENTS_RAIL_DELETE_ACTION_ID);
    expect(deleteAction.undo).toBe(TableBulkActionUndo.Unsupported);
  });
});

function testQueryWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}
