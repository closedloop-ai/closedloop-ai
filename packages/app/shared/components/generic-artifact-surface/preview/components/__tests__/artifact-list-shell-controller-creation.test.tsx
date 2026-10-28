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
import { defaultArtifactCreationConfig } from "../artifact-creation";
import { columnWidthBounds } from "../artifact-list-model";
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

type Controller = ReturnType<typeof renderListController>["result"];

const OUTSIDE_VIEW = /created outside the current view$/;
const UNDO = "Undo";

function rows(): GenericArtifact[] {
  return [listRow("a"), listRow("b", { owner: "Pascoe Birchall" })];
}

function threeRows(): GenericArtifact[] {
  return [...rows(), listRow("c", { owner: "Pascoe Birchall" })];
}

function created(result: Controller, slug: string): GenericArtifact {
  const artifact = result.current.artifacts.find(
    (candidate) => candidate.slug === slug
  );
  if (!artifact) {
    throw new Error(`missing created row ${slug}`);
  }
  return artifact;
}

function createInline(
  result: Controller,
  title: string,
  groupKey?: string,
  afterArtifactId?: string
) {
  act(() =>
    result.current.createInlineArtifact(title, groupKey, afterArtifactId)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("list controller title edits", () => {
  it("renames a row, announces it, and restores the old name through Undo", () => {
    const { result } = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });

    act(() => result.current.updateArtifactTitle("a", "  Renamed  "));

    expect(result.current.artifacts.map((artifact) => artifact.title)).toEqual([
      "Renamed",
      "b",
    ]);
    expect(lastToast(toastSuccess)).toMatchObject({
      actionLabel: UNDO,
      message: "Artifact name updated",
    });

    act(() => lastToast(toastSuccess).undo?.());
    expect(result.current.artifacts.map((artifact) => artifact.title)).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores an unknown row and a title that only differs by whitespace", () => {
    const { result } = renderListController({
      artifacts: rows(),
      inlineCreate: { enabled: true },
      onOpenArtifact: vi.fn(),
    });

    act(() =>
      result.current.updateArtifactTitle("missing", "x", {
        advanceToNewRow: true,
      })
    );
    act(() => result.current.updateArtifactTitle("a", " a "));

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(result.current.artifacts.map((artifact) => artifact.title)).toEqual([
      "a",
      "b",
    ]);
    expect(result.current.inlineDraftContext).toBeNull();
  });

  it("opens a draft after the edited row only when inline create is on and asked for", () => {
    const off = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    }).result;
    act(() =>
      off.current.updateArtifactTitle("a", "a", { advanceToNewRow: true })
    );
    expect(off.current.inlineDraftContext).toBeNull();

    const { result } = renderListController({
      artifacts: rows(),
      inlineCreate: { enabled: true },
      onOpenArtifact: vi.fn(),
    });
    act(() => result.current.updateArtifactTitle("a", "a"));
    expect(result.current.inlineDraftContext).toBeNull();

    act(() =>
      result.current.updateArtifactTitle("a", "a", { advanceToNewRow: true })
    );
    expect(result.current.inlineDraftContext).toEqual({
      afterArtifactId: "a",
      groupKey: undefined,
    });
  });

  it("carries the edited row's group into the next draft", () => {
    const { result } = renderListController({
      artifacts: threeRows(),
      defaultGroupBy: "owner",
      inlineCreate: { enabled: true },
      onOpenArtifact: vi.fn(),
    });

    act(() =>
      result.current.updateArtifactTitle("c", "c", { advanceToNewRow: true })
    );

    expect(result.current.inlineDraftContext).toEqual({
      afterArtifactId: "c",
      groupKey: "Pascoe Birchall",
    });
  });
});

describe("list controller inline creation", () => {
  it("appends a draft built from the creation config and opens the next draft after it", () => {
    const { result } = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "  New thing ");

    const draft = created(result, "ART-003");
    expect(artifactIds(result.current.artifacts)).toEqual(["a", "b", draft.id]);
    expect(draft).toMatchObject({
      collaborators: [],
      creationValues: { attachments: [], linkedArtifacts: [] },
      kind: defaultArtifactCreationConfig.kind,
      owner: "Ottilie Eastwick",
      project: null,
      repository: null,
      status: ArtifactStatus.Draft,
      summary: "",
      tags: [],
      title: "New thing",
    });
    expect(result.current.inlineDraftContext).toEqual({
      afterArtifactId: draft.id,
      groupKey: undefined,
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("inserts after the named row, and at the end when that row is gone", () => {
    const { result } = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "middle", undefined, "a");
    expect(result.current.artifacts.map((artifact) => artifact.slug)).toEqual([
      "A",
      "ART-003",
      "B",
    ]);

    createInline(result, "tail", undefined, "missing");
    expect(result.current.artifacts.at(-1)?.slug).toBe("ART-004");
  });

  it("inserts after a middle row and appends when no row is named", () => {
    const { result } = renderListController({
      artifacts: threeRows(),
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "middle", undefined, "b");
    expect(result.current.artifacts.map((artifact) => artifact.slug)).toEqual([
      "A",
      "B",
      "ART-004",
      "C",
    ]);

    createInline(result, "tail");
    expect(result.current.artifacts.map((artifact) => artifact.slug)).toEqual([
      "A",
      "B",
      "ART-004",
      "C",
      "ART-005",
    ]);
  });

  it("files a draft under the creation config's default project", () => {
    const { result } = renderListController({
      artifacts: rows(),
      creationConfig: {
        ...defaultArtifactCreationConfig,
        defaultProject: "Artifact foundations",
      },
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "projected");

    expect(created(result, "ART-003").project).toBe("Artifact foundations");
  });

  it("starts an Issue in progress when the creation kind is Issue", () => {
    const { result } = renderListController({
      artifacts: rows(),
      creationConfig: {
        ...defaultArtifactCreationConfig,
        kind: ArtifactKind.Issue,
      },
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "issue");

    expect(created(result, "ART-003")).toMatchObject({
      kind: ArtifactKind.Issue,
      status: ArtifactStatus.InProgress,
    });
  });

  it("takes owner, tag and custom-field defaults from the group it was created in", () => {
    const owner = renderListController({
      artifacts: rows(),
      defaultGroupBy: "owner",
      onOpenArtifact: vi.fn(),
    }).result;
    createInline(owner, "owned", "Sam Chen");
    expect(created(owner, "ART-003")).toMatchObject({
      owner: "Sam Chen",
      ownerInitials: "SC",
    });
    expect(created(owner, "ART-003").creationValues).not.toHaveProperty(
      "owner"
    );
    expect(owner.current.inlineDraftContext?.groupKey).toBe("Sam Chen");
    expect(created(owner, "ART-003").tags).toEqual([]);

    const tags = renderListController({
      artifacts: rows(),
      defaultGroupBy: "tags",
      onOpenArtifact: vi.fn(),
    }).result;
    createInline(tags, "tagged", "UX");
    expect(created(tags, "ART-003")).toMatchObject({
      owner: "Ottilie Eastwick",
      tags: ["UX"],
    });
    expect(created(tags, "ART-003").creationValues).not.toHaveProperty("tags");

    const custom = renderListController({
      artifacts: rows(),
      defaultGroupBy: "stage",
      onOpenArtifact: vi.fn(),
    }).result;
    createInline(custom, "staged", "Build");
    expect(created(custom, "ART-003").creationValues).toMatchObject({
      stage: "Build",
    });
    expect(created(custom, "ART-003")).toMatchObject({
      owner: "Ottilie Eastwick",
      tags: [],
    });
  });

  it("reads a custom group's key only as that field's value, even when it spells a kind or a status", () => {
    const { result } = renderListController({
      artifacts: rows(),
      defaultGroupBy: "stage",
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "kind-like", ArtifactKind.Issue);
    createInline(result, "status-like", ARTIFACT_STATUS_ROOT.InReview);

    expect(created(result, "ART-003")).toMatchObject({
      creationValues: { stage: ArtifactKind.Issue },
      kind: defaultArtifactCreationConfig.kind,
    });
    expect(created(result, "ART-004")).toMatchObject({
      creationValues: { stage: ARTIFACT_STATUS_ROOT.InReview },
      status: ArtifactStatus.Draft,
    });
  });

  it("takes the kind only from a kind group that names a real kind", () => {
    const { result } = renderListController({
      artifacts: rows(),
      defaultGroupBy: "kind",
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "issue", ArtifactKind.Issue);
    createInline(result, "epic", "Epic");

    expect(created(result, "ART-003").kind).toBe(ArtifactKind.Issue);
    expect(created(result, "ART-004").kind).toBe(
      defaultArtifactCreationConfig.kind
    );
    expect(created(result, "ART-004").creationValues).not.toHaveProperty(
      "kind"
    );
  });

  it("starts at the status group's default and falls back when the kind has none", () => {
    const { result } = renderListController({
      artifacts: rows(),
      defaultGroupBy: "status",
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "review", ARTIFACT_STATUS_ROOT.InReview);
    createInline(result, "done", ARTIFACT_STATUS_ROOT.Done);

    expect(created(result, "ART-003")).toMatchObject({
      owner: "Ottilie Eastwick",
      status: ArtifactStatus.InReview,
      tags: [],
    });
    expect(created(result, "ART-003").creationValues).not.toHaveProperty(
      "status"
    );
    // pins current behavior; looks odd because a draft committed in the Done band of a Document list is created as Draft, outside that band
    expect(created(result, "ART-004").status).toBe(ArtifactStatus.Draft);
  });

  it("takes owner, status, tag and field values from single-value filters", () => {
    const { result } = renderListController({
      additionalColumns: [
        {
          filterValues: (artifact) => [...artifact.tags],
          filterable: true,
          id: "labels",
          kind: ColumnFieldKind.Custom,
          label: "Labels",
          renderCell: () => null,
          width: columnWidthBounds(100),
        },
      ],
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });
    act(() => {
      result.current.filterController.toggleAssignee("Pascoe Birchall");
      result.current.filterController.toggleStatus(
        ARTIFACT_STATUS_ROOT.InReview
      );
      result.current.filterController.toggleTag("Design");
      result.current.setCustomFieldFilters({
        priority: { selectedValues: ["High"] },
        spread: { selectedValues: ["x", "y"] },
      });
      result.current.setExtensionFilters({
        labels: { selectedValues: ["Design"] },
      });
    });

    createInline(result, "filtered");

    const draft = created(result, "ART-003");
    expect(draft).toMatchObject({
      owner: "Pascoe Birchall",
      status: ArtifactStatus.InReview,
      tags: ["Design"],
    });
    expect(draft.creationValues).toMatchObject({
      labels: "Design",
      priority: "High",
    });
    expect(draft.creationValues).not.toHaveProperty("spread");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    [
      "favorites only",
      (result: Controller) =>
        result.current.filterController.toggleFavoritesOnly(),
    ],
    [
      "two owners",
      (result: Controller) => {
        result.current.filterController.toggleAssignee("Pascoe Birchall");
        result.current.filterController.toggleAssignee("Sam Chen");
      },
    ],
    [
      "two statuses",
      (result: Controller) => {
        result.current.filterController.toggleStatus(
          ARTIFACT_STATUS_ROOT.InReview
        );
        result.current.filterController.toggleStatus(ARTIFACT_STATUS_ROOT.Todo);
      },
    ],
    [
      "another kind",
      (result: Controller) =>
        result.current.filterController.togglePriority(ArtifactKind.Issue),
    ],
    [
      "two tags",
      (result: Controller) => {
        result.current.filterController.toggleTag("UX");
        result.current.filterController.toggleTag("Design");
      },
    ],
    [
      "a custom field selection",
      (result: Controller) => {
        result.current.setCustomFields([
          { id: "note", label: "Note", type: TableCustomFieldType.Text },
        ]);
        result.current.setCustomFieldFilters({
          note: { selectedValues: ["p", "q"] },
        });
      },
    ],
    [
      "an extension range",
      (result: Controller) =>
        result.current.setExtensionFilters({ spend: { min: 1 } }),
    ],
  ])(
    "announces a draft that %s hides, and Undo removes it",
    (_name, narrow) => {
      const onArtifactsChange = vi.fn();
      const initial = rows();
      const { result } = renderListController({
        additionalColumns: [
          {
            filterRange: (artifact) => artifact.aiSpend,
            filterable: true,
            id: "spend",
            kind: ColumnFieldKind.Custom,
            label: "Spend",
            renderCell: () => null,
            width: columnWidthBounds(100),
          },
        ],
        artifacts: initial,
        onArtifactsChange,
        onOpenArtifact: vi.fn(),
      });
      act(() => narrow(result));

      createInline(result, "hidden");

      expect(lastToast(toastSuccess).message).toMatch(OUTSIDE_VIEW);
      expect(lastToast(toastSuccess)).toMatchObject({
        actionLabel: UNDO,
        message: "ART-003 created outside the current view",
      });
      act(() => lastToast(toastSuccess).undo?.());
      expect(artifactIds(result.current.artifacts)).toEqual(["a", "b"]);
      expect(onArtifactsChange).toHaveBeenLastCalledWith(initial);
    }
  );

  it("hides a mine-only draft that a group assigned to someone else", () => {
    const { result } = renderListController({
      artifacts: rows(),
      defaultGroupBy: "owner",
      onOpenArtifact: vi.fn(),
    });
    act(() => result.current.filterController.toggleAssignToMe());

    createInline(result, "mine", "Ottilie Eastwick");
    expect(toastSuccess).not.toHaveBeenCalled();

    createInline(result, "theirs", "Sam Chen");
    expect(lastToast(toastSuccess).message).toBe(
      "ART-004 created outside the current view"
    );
  });

  it("keeps a draft whose group tag matches one of several tag filters in view", () => {
    const { result } = renderListController({
      artifacts: rows(),
      defaultGroupBy: "tags",
      onOpenArtifact: vi.fn(),
    });
    act(() => {
      result.current.filterController.toggleTag("UX");
      result.current.filterController.toggleTag("Design");
    });

    createInline(result, "tagged", "UX");

    expect(created(result, "ART-003").tags).toEqual(["UX"]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("undoes a hidden draft for a host that does not listen for changes", () => {
    const { result } = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });
    act(() => result.current.filterController.toggleFavoritesOnly());
    createInline(result, "hidden");

    act(() => lastToast(toastSuccess).undo?.());

    expect(artifactIds(result.current.artifacts)).toEqual(["a", "b"]);
  });

  it("notifies the host of the new rows after the update settles", async () => {
    const onArtifactsChange = vi.fn();
    const { result } = renderListController({
      artifacts: rows(),
      onArtifactsChange,
      onOpenArtifact: vi.fn(),
    });

    createInline(result, "announced");

    await waitFor(() =>
      expect(onArtifactsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "a" }),
        expect.objectContaining({ id: "b" }),
        expect.objectContaining({ slug: "ART-003" }),
      ])
    );
  });
});

describe("list controller tag editor", () => {
  it("adds a new tag on the next palette colour and refuses a case-insensitive duplicate", () => {
    const { result } = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });
    const before = result.current.tagEditorContext.definitions;

    act(() => result.current.tagEditorContext.createTag("Launch"));
    expect(result.current.tagEditorContext.definitions.at(-1)).toEqual({
      color: "violet",
      label: "Launch",
    });

    act(() => result.current.tagEditorContext.createTag("launch"));
    expect(result.current.tagEditorContext.definitions).toHaveLength(
      before.length + 1
    );
  });

  it("recolours only the named tag", () => {
    const { result } = renderListController({
      artifacts: rows(),
      onOpenArtifact: vi.fn(),
    });
    const [first, second] = result.current.tagEditorContext.definitions;
    expect([first?.color, second?.color]).toEqual(["red", "rose"]);

    act(() =>
      result.current.tagEditorContext.setTagColor(first?.label ?? "", "indigo")
    );

    const [recoloured, untouched] = result.current.tagEditorContext.definitions;
    expect(recoloured?.color).toBe("indigo");
    expect(untouched).toEqual(second);
  });
});
