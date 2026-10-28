// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { TableCustomFieldType } from "@repo/design-system/components/ui/table-add-field-dialog";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "../../fixtures";
import {
  type ArtifactListColumnExtension,
  columnWidthBounds,
  RELATED_SESSIONS_COLUMN_ID,
} from "../artifact-list-model";
import {
  artifactIds,
  lastToast,
  listRow,
  renderListController,
} from "./support/list-controller-harness";

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: toastSuccess },
}));

const DEFAULT_TOOLTIP = "Optional column header tool tip...";
const OWNER_TOOLTIP =
  "The single accountable owner. Distinct from collaborators and contributors.";
const UNDO = "Undo";

const issue = listRow("i", {
  kind: ArtifactKind.Issue,
  slug: "ISS-1",
  status: ArtifactStatus.Todo,
});
const session = listRow("s", {
  kind: ArtifactKind.Session,
  slug: "SES-1",
  status: ArtifactStatus.Active,
});

const extraColumn: ArtifactListColumnExtension = {
  id: "extra",
  kind: ColumnFieldKind.Custom,
  label: "Extra",
  renderCell: () => null,
  width: columnWidthBounds(90),
};

function find(
  artifacts: readonly GenericArtifact[],
  id: string
): GenericArtifact | undefined {
  return artifacts.find((artifact) => artifact.id === id);
}

function renderRows(artifacts: GenericArtifact[] = [issue, session]) {
  return renderListController({ artifacts, onOpenArtifact: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("list controller status changes", () => {
  it("moves only the named editable row, clears its raw status, and restores it through Undo", () => {
    const { result } = renderRows([{ ...issue, statusRaw: "TODO" }, session]);

    act(() => result.current.changeArtifactStatus("i", ArtifactStatus.Done));

    expect(find(result.current.artifacts, "i")).toMatchObject({
      status: ArtifactStatus.Done,
      statusRaw: undefined,
    });
    expect(find(result.current.artifacts, "s")).toEqual(session);
    expect(lastToast(toastSuccess)).toMatchObject({
      actionLabel: UNDO,
      message: "ISS-1 moved to Done",
    });

    act(() => lastToast(toastSuccess).undo?.());
    expect(find(result.current.artifacts, "i")).toMatchObject({
      status: ArtifactStatus.Todo,
      statusRaw: "TODO",
    });
    expect(find(result.current.artifacts, "s")).toEqual(session);
  });

  it("ignores an unknown row, an unchanged status and a read-only row", () => {
    const { result } = renderRows();

    act(() => {
      result.current.changeArtifactStatus("missing", ArtifactStatus.Done);
      result.current.changeArtifactStatus("i", ArtifactStatus.Todo);
      result.current.changeArtifactStatus("s", ArtifactStatus.Completed);
    });

    expect(find(result.current.artifacts, "s")?.status).toBe(
      ArtifactStatus.Active
    );
    expect(find(result.current.artifacts, "i")?.status).toBe(
      ArtifactStatus.Todo
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("list controller group drops", () => {
  it("names the new status when a drop changes it", () => {
    const { result } = renderRows();

    act(() =>
      result.current.applyGroupDrop("i", "status", ARTIFACT_STATUS_ROOT.Done)
    );

    expect(find(result.current.artifacts, "i")?.status).toBe(
      ArtifactStatus.Done
    );
    expect(lastToast(toastSuccess).message).toBe("ISS-1 moved to Done");
  });

  it("names the status when a drop into the same band only drops the raw status", () => {
    const { result } = renderRows([{ ...issue, statusRaw: "TODO" }]);

    act(() =>
      result.current.applyGroupDrop("i", "status", ARTIFACT_STATUS_ROOT.Todo)
    );

    expect(find(result.current.artifacts, "i")).toMatchObject({
      status: ArtifactStatus.Todo,
      statusRaw: undefined,
    });
    expect(lastToast(toastSuccess).message).toBe("ISS-1 moved to Todo");
  });

  it("says Moved for a non-status drop and restores the row through Undo", () => {
    const { result } = renderRows();

    act(() =>
      result.current.applyGroupDrop("i", "owner", "Sam Chen", "stage", "Build")
    );

    expect(find(result.current.artifacts, "i")).toMatchObject({
      creationValues: { stage: "Build" },
      owner: "Sam Chen",
      ownerInitials: "SC",
    });
    expect(lastToast(toastSuccess).message).toBe("Moved");

    act(() => lastToast(toastSuccess).undo?.());
    expect(find(result.current.artifacts, "i")).toMatchObject({
      owner: issue.owner,
      ownerInitials: issue.ownerInitials,
    });
  });

  it("ignores an unknown row and a destination the row cannot take", () => {
    const { result } = renderRows();

    act(() => {
      result.current.applyGroupDrop("missing", "owner", "Sam Chen");
      result.current.applyGroupDrop("i", "owner", "Nobody");
      result.current.applyGroupDrop("s", "status", ARTIFACT_STATUS_ROOT.Done);
    });

    expect(result.current.artifacts).toEqual([issue, session]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("list controller row marks", () => {
  it("favorites and unfavorites a row", () => {
    const { result } = renderRows();

    act(() => result.current.setArtifactFavorite("i", true));
    expect(result.current.favoriteArtifactIds.has("i")).toBe(true);

    act(() => result.current.setArtifactFavorite("i", false));
    expect(result.current.favoriteArtifactIds.has("i")).toBe(false);
  });
});

describe("list controller columns", () => {
  it("slots Related Sessions before Comments unless it is excluded", () => {
    const withSessions = renderListController({
      additionalColumns: [extraColumn],
      artifacts: [issue],
      onOpenArtifact: vi.fn(),
    }).result;
    expect(
      withSessions.current.configuredColumns.map((column) => column.id)
    ).toEqual([
      "owner",
      "collaborators",
      "status",
      RELATED_SESSIONS_COLUMN_ID,
      "comments",
      "updated",
      "currentVersion",
      "tags",
      "extra",
    ]);
    expect(
      withSessions.current.extensionColumns.map((column) => column.id)
    ).toEqual([RELATED_SESSIONS_COLUMN_ID, "extra"]);

    const without = renderListController({
      additionalColumns: [extraColumn],
      artifacts: [issue],
      excludedColumnIds: [RELATED_SESSIONS_COLUMN_ID, "tags"],
      onOpenArtifact: vi.fn(),
    }).result;
    expect(
      without.current.configuredColumns.map((column) => column.id)
    ).toEqual([
      "owner",
      "collaborators",
      "status",
      "comments",
      "updated",
      "currentVersion",
      "extra",
    ]);
    expect(without.current.extensionColumns.map((column) => column.id)).toEqual(
      ["extra"]
    );
  });

  it("keeps a column's own tooltip and gives the rest the placeholder", () => {
    const { result } = renderRows();
    const tooltips = new Map(
      result.current.gridColumns.map((column) => [column.id, column.tooltip])
    );

    expect(tooltips.get("owner")).toBe(OWNER_TOOLTIP);
    expect(tooltips.get("status")).toBe(DEFAULT_TOOLTIP);
  });

  it("marks which built-in columns can be filtered and grouped", () => {
    const { result } = renderListController({
      artifacts: [issue],
      defaultVisibleColumnIds: ["status", "updated", "tags", "collaborators"],
      onOpenArtifact: vi.fn(),
    });
    const byId = new Map(
      result.current.gridColumns.map((column) => [column.id, column])
    );

    expect(byId.get("status")).toMatchObject({
      filterable: true,
      groupable: true,
    });
    expect(byId.get("updated")?.filterable).toBe(true);
    expect(byId.get("tags")?.filterable).toBe(true);
    expect(byId.get("collaborators")?.filterable).not.toBe(true);
  });

  it("offers an extension column's filter group to its header", () => {
    const { result } = renderListController({
      additionalColumns: [
        { ...extraColumn, filterValues: () => ["x"], filterable: true },
      ],
      artifacts: [issue],
      onOpenArtifact: vi.fn(),
    });

    expect(
      result.current.columnFilterGroups.map((group) => group.id)
    ).toContain("extra");
  });

  it("opens a created artifact by default and not when the host opts out", () => {
    expect(renderRows().result.current.openCreatedArtifactAfterCreate).toBe(
      true
    );
    expect(
      renderListController({
        artifacts: [issue],
        onOpenArtifact: vi.fn(),
        openCreatedArtifactAfterCreate: false,
      }).result.current.openCreatedArtifactAfterCreate
    ).toBe(false);
  });

  it("renders a user-added field with the capabilities its type allows", () => {
    const { result } = renderRows();

    act(() => {
      result.current.setCustomFields([
        { id: "pick", label: "Pick", type: TableCustomFieldType.SingleSelect },
        { id: "many", label: "Many", type: TableCustomFieldType.MultiSelect },
      ]);
      result.current.setVisibleColumnIds(new Set(["pick", "many"]));
    });

    const byId = new Map(
      result.current.gridColumns.map((column) => [column.id, column])
    );
    expect([...byId.keys()]).toEqual(["pick", "many"]);
    expect(byId.get("pick")).toMatchObject({
      filterable: true,
      groupable: true,
      sortable: true,
    });
    expect(byId.get("many")).toMatchObject({
      groupable: false,
      sortable: false,
    });
  });

  it("applies two moves batched into one update", () => {
    const { result } = renderListController({
      artifacts: [issue],
      defaultVisibleColumnIds: ["owner", "status", "tags"],
      onOpenArtifact: vi.fn(),
    });

    act(() => {
      result.current.moveVisibleColumn("tags", "left");
      result.current.moveVisibleColumn("tags", "left");
    });

    expect(result.current.columnLayout.columnOrder).toEqual([
      "tags",
      "owner",
      "status",
    ]);
  });
});

describe("list controller host sync", () => {
  it("replaces its rows from props only when the host listens for changes", () => {
    const onArtifactsChange = vi.fn();
    const listening = renderListController({
      artifacts: [issue],
      onArtifactsChange,
      onOpenArtifact: vi.fn(),
    });
    listening.rerender({
      artifacts: [session],
      onArtifactsChange,
      onOpenArtifact: vi.fn(),
    });
    expect(artifactIds(listening.result.current.artifacts)).toEqual(["s"]);

    const deaf = renderListController({
      artifacts: [issue],
      onOpenArtifact: vi.fn(),
    });
    deaf.rerender({ artifacts: [session], onOpenArtifact: vi.fn() });
    // pins current behavior; looks odd because a host without onArtifactsChange cannot push new rows after mount
    expect(artifactIds(deaf.result.current.artifacts)).toEqual(["i"]);
  });

  it("reports a replaced row list to the host", async () => {
    const onArtifactsChange = vi.fn();
    const { result } = renderListController({
      artifacts: [issue],
      onArtifactsChange,
      onOpenArtifact: vi.fn(),
    });

    act(() => result.current.setArtifacts([session]));

    await waitFor(() =>
      expect(onArtifactsChange).toHaveBeenCalledWith([session])
    );
  });
});
