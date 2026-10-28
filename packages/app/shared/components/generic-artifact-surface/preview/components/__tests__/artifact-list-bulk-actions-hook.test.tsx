// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GenericArtifactStatus,
  genericArtifactStatusRaw,
} from "../../../generic-artifact-status";
import {
  ArtifactKind,
  type GenericArtifact,
  genericArtifacts,
} from "../../fixtures";
import {
  resolveArtifactBulkStatusUpdates,
  useArtifactListBulkActions,
} from "../artifact-list-bulk-actions";
import {
  INITIAL_TAG_DEFINITIONS,
  type TagDefinition,
} from "../artifact-list-model";
import {
  runLastToastUndo,
  type ToastSuccessHandler,
} from "./support/toast-spy";

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<ToastSuccessHandler>(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess },
}));

const IN_REVIEW_ISSUE: GenericArtifact = {
  ...genericArtifacts[0],
  id: "issue-review",
  kind: ArtifactKind.Issue,
  project: "Platform",
  status: GenericArtifactStatus.InReview,
  tags: ["UX"],
};
const TRIAGE_ISSUE: GenericArtifact = {
  ...IN_REVIEW_ISSUE,
  id: "issue-triage",
  status: GenericArtifactStatus.Triage,
};
const DOCUMENT: GenericArtifact = {
  ...genericArtifacts[1],
  id: "document",
  kind: ArtifactKind.Document,
};
const ROWS = [IN_REVIEW_ISSUE, TRIAGE_ISSUE, DOCUMENT];
const SEEDED_TAGS: TagDefinition[] = INITIAL_TAG_DEFINITIONS.slice(0, 2);
const SEEDED_FAVORITE = "already-favorite";

function useBulkHarness(
  rows: readonly GenericArtifact[],
  selected: readonly string[]
) {
  const [artifacts, setArtifacts] = useState<GenericArtifact[]>([...rows]);
  const [favoriteArtifactIds, setFavoriteArtifactIds] = useState(
    new Set([SEEDED_FAVORITE])
  );
  const [selectedArtifactIds, setSelectedArtifactIds] = useState(
    new Set(selected)
  );
  const [tagDefinitions, setTagDefinitions] = useState(SEEDED_TAGS);
  const selectionAnchorId = useRef<string | null>(selected[0] ?? null);
  const actions = useArtifactListBulkActions({
    artifacts,
    favoriteArtifactIds,
    selectedArtifactIds,
    selectionAnchorId,
    setArtifacts,
    setFavoriteArtifactIds,
    setSelectedArtifactIds,
    setTagDefinitions,
    tagDefinitions,
  });
  return {
    actions,
    artifacts,
    favoriteArtifactIds,
    selectedArtifactIds,
    selectionAnchorId,
    tagDefinitions,
  };
}

function renderBulk(
  selected: readonly string[],
  rows: readonly GenericArtifact[] = ROWS
) {
  return renderHook(() => useBulkHarness(rows, selected));
}

type Harness = ReturnType<typeof renderBulk>["result"];

function row(result: Harness, id: string) {
  return result.current.artifacts.find((artifact) => artifact.id === id);
}

function selection(result: Harness) {
  return {
    anchor: result.current.selectionAnchorId.current,
    ids: [...result.current.selectedArtifactIds],
  };
}

const CLEARED_SELECTION = { anchor: null, ids: [] };

beforeEach(() => {
  toastSuccess.mockReset();
});

describe("useArtifactListBulkActions applyBulkAction", () => {
  it("favorites the selection, clears it, and undo restores the old favorites", () => {
    const { result } = renderBulk([IN_REVIEW_ISSUE.id, TRIAGE_ISSUE.id]);

    act(() => result.current.actions.applyBulkAction("favorite"));

    expect([...result.current.favoriteArtifactIds]).toEqual([
      SEEDED_FAVORITE,
      IN_REVIEW_ISSUE.id,
      TRIAGE_ISSUE.id,
    ]);
    expect(result.current.artifacts).toEqual(ROWS);
    expect(selection(result)).toEqual(CLEARED_SELECTION);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Added to favorites for 2 artifacts",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );

    runLastToastUndo(toastSuccess);
    expect([...result.current.favoriteArtifactIds]).toEqual([SEEDED_FAVORITE]);
  });

  it("moves only the selected row to a project, in the singular", () => {
    const { result } = renderBulk([TRIAGE_ISSUE.id]);

    act(() =>
      result.current.actions.applyBulkAction("add-to-project", "Design system")
    );

    expect(row(result, TRIAGE_ISSUE.id)?.project).toBe("Design system");
    expect(row(result, IN_REVIEW_ISSUE.id)?.project).toBe("Platform");
    expect(toastSuccess).toHaveBeenCalledWith(
      "Added to project for 1 artifact",
      expect.anything()
    );
    expect(result.current.favoriteArtifactIds).toEqual(
      new Set([SEEDED_FAVORITE])
    );
  });

  it("assigns an owner and leaves tag definitions alone", () => {
    const { result } = renderBulk([IN_REVIEW_ISSUE.id, DOCUMENT.id]);

    act(() =>
      result.current.actions.applyBulkAction("assign-owner", "Jordan Lee")
    );

    expect(row(result, DOCUMENT.id)?.owner).toBe("Jordan Lee");
    expect(row(result, IN_REVIEW_ISSUE.id)?.ownerInitials).toBe("JL");
    expect(result.current.tagDefinitions).toBe(SEEDED_TAGS);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Owner assigned for 2 artifacts",
      expect.anything()
    );
  });

  it("adds a new tag as a blue definition, and undo restores rows and definitions", () => {
    const { result } = renderBulk([IN_REVIEW_ISSUE.id]);

    act(() => result.current.actions.applyBulkAction("add-tag", "Novel"));

    expect(row(result, IN_REVIEW_ISSUE.id)?.tags).toEqual(["UX", "Novel"]);
    expect(row(result, TRIAGE_ISSUE.id)?.tags).toEqual(["UX"]);
    expect(result.current.tagDefinitions).toEqual([
      ...SEEDED_TAGS,
      { color: "blue", label: "Novel" },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Tag added for 1 artifact",
      expect.anything()
    );

    runLastToastUndo(toastSuccess);
    expect(result.current.artifacts).toEqual(ROWS);
    expect(result.current.tagDefinitions).toEqual(SEEDED_TAGS);
  });

  it("keeps the tag definitions for a known label or no label", () => {
    const { result } = renderBulk([IN_REVIEW_ISSUE.id]);
    const knownLabel = SEEDED_TAGS[0]?.label;

    act(() => result.current.actions.applyBulkAction("add-tag", knownLabel));
    expect(result.current.tagDefinitions).toBe(SEEDED_TAGS);

    act(() => result.current.actions.applyBulkAction("add-tag"));
    expect(result.current.tagDefinitions).toBe(SEEDED_TAGS);
  });
});

describe("useArtifactListBulkActions status", () => {
  it("offers only the targets every selected row supports", () => {
    const mixed = renderBulk([IN_REVIEW_ISSUE.id, DOCUMENT.id]);
    const none = renderBulk([]);

    expect(
      mixed.result.current.actions.bulkStatusOptions.map((option) => option.key)
    ).toEqual([ARTIFACT_STATUS_ROOT.InReview]);
    expect(none.result.current.actions.bulkStatusOptions).toEqual([]);
  });

  it("does nothing when any selected row cannot take the target", () => {
    const { result } = renderBulk([IN_REVIEW_ISSUE.id, DOCUMENT.id]);

    act(() =>
      result.current.actions.applyBulkStatus(ARTIFACT_STATUS_ROOT.Todo)
    );

    expect(result.current.artifacts).toEqual(ROWS);
    expect(result.current.selectedArtifactIds.size).toBe(2);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("does nothing when every selected row already has the target", () => {
    const { result } = renderBulk([IN_REVIEW_ISSUE.id]);

    act(() =>
      result.current.actions.applyBulkStatus(ARTIFACT_STATUS_ROOT.InReview)
    );

    expect(result.current.selectedArtifactIds.size).toBe(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("moves the changed rows, drops their raw evidence, and undo restores them", () => {
    const rawReview = genericArtifactStatusRaw(IN_REVIEW_ISSUE);
    expect(typeof rawReview).toBe("string");
    const rawBacked: GenericArtifact = {
      ...IN_REVIEW_ISSUE,
      statusRaw: rawReview ?? undefined,
    };
    const rows = [rawBacked, TRIAGE_ISSUE, DOCUMENT];
    const { result } = renderBulk([rawBacked.id, TRIAGE_ISSUE.id], rows);

    act(() =>
      result.current.actions.applyBulkStatus(ARTIFACT_STATUS_ROOT.InReview)
    );

    expect(row(result, rawBacked.id)).toEqual({
      ...rawBacked,
      status: GenericArtifactStatus.InReview,
      statusRaw: undefined,
    });
    expect(row(result, TRIAGE_ISSUE.id)?.status).toBe(
      GenericArtifactStatus.InReview
    );
    expect(row(result, DOCUMENT.id)).toBe(DOCUMENT);
    expect(selection(result)).toEqual(CLEARED_SELECTION);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Status updated",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );

    runLastToastUndo(toastSuccess);
    expect(result.current.artifacts).toEqual(rows);
  });
});

describe("resolveArtifactBulkStatusUpdates raw evidence", () => {
  it("rewrites a row already at the target when it carries raw evidence", () => {
    const rawReview = genericArtifactStatusRaw(IN_REVIEW_ISSUE) ?? undefined;

    expect(
      resolveArtifactBulkStatusUpdates(
        [{ ...IN_REVIEW_ISSUE, statusRaw: rawReview }],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toEqual([
      {
        artifactId: IN_REVIEW_ISSUE.id,
        status: GenericArtifactStatus.InReview,
      },
    ]);
  });
});
