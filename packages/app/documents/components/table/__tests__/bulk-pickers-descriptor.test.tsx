import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemFailureCode,
  type BatchMutationResponse,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  DocumentStatusMutationErrorCode,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { ApiError } from "@repo/app/shared/api/api-error";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { documentStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { appliedTagMessage } from "@repo/app/tags/lib/bulk-tag-labels";
import type { TableBulkSelectionControls } from "@repo/design-system/components/ui/table-bulk-actions";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBulkStatusAction } from "../bulk-status-picker";
import { DocumentsBulkActions } from "../documents-bulk-actions";

const BATCH_UPDATE_STATUS = vi.hoisted(() => vi.fn());
const BATCH_UPDATE_STATUS_ASYNC = vi.hoisted(() => vi.fn());
const BATCH_APPLY_TAG = vi.hoisted(() => vi.fn());
const BATCH_UPDATE_PRIORITY = vi.hoisted(() => vi.fn());
const FEATURE_FLAGS = vi.hoisted(() => new Map<string, boolean>());
const TOAST_ERROR = vi.hoisted(() => vi.fn());
const TOAST_SUCCESS = vi.hoisted(() => vi.fn());
const TAGS = vi.hoisted(() => ({
  value: [] as { id: string; name: string }[],
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useBatchUpdatePriority: () => ({
    isPending: false,
    mutate: BATCH_UPDATE_PRIORITY,
  }),
  useBatchUpdateStatus: () => ({
    isPending: false,
    mutate: BATCH_UPDATE_STATUS,
    mutateAsync: BATCH_UPDATE_STATUS_ASYNC,
  }),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => FEATURE_FLAGS.get(key) ?? false,
  useFeatureFlagEnabledOptional: (key: string) =>
    FEATURE_FLAGS.get(key) ?? false,
}));
vi.mock("@repo/app/tags/hooks/use-tags", () => ({
  useBatchApplyTag: () => ({ isPending: false, mutate: BATCH_APPLY_TAG }),
  useTags: () => ({ data: TAGS.value }),
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: TOAST_ERROR, success: TOAST_SUCCESS },
}));

/**
 * ISS-8942 — the project table's status and tag pickers ARE bulk-action
 * descriptors now: one list, one renderer, the selection handed down rather
 * than read out of a prop each picker held for itself.
 */

const SELECTED_IDS = ["doc-1", "doc-2"];
const STATUS_TRIGGER = /^Change Status$/;
const TAG_TRIGGER = /^Add Tag$/;
const PRIORITY_TRIGGER = /^Change Priority$/;
const HIGH_PRIORITY_OPTION = /^High$/;
const DRAFT_OPTION = /Draft/;
const TAG_OPTION = /Needs review/;

function Harness({
  rowIds = SELECTED_IDS,
  selectedRows = SELECTED_IDS.map((id) => makeArtifact({ id })),
  selection,
}: {
  rowIds?: readonly string[];
  selectedRows?: DocumentRowData[];
  selection: TableBulkSelectionControls;
}) {
  return (
    <DocumentsBulkActions
      onClear={selection.clear}
      onRetain={selection.retain}
      rowIds={rowIds}
      selectedRows={selectedRows}
    />
  );
}

describe("the project table's bulk pickers as descriptors", () => {
  beforeEach(() => {
    BATCH_UPDATE_STATUS.mockReset();
    BATCH_UPDATE_STATUS_ASYNC.mockReset();
    BATCH_APPLY_TAG.mockReset();
    BATCH_UPDATE_PRIORITY.mockReset();
    FEATURE_FLAGS.clear();
    TOAST_ERROR.mockReset();
    TOAST_SUCCESS.mockReset();
    TAGS.value = [{ id: "tag-1", name: "Needs review" }];
  });

  it("renders both actions from ONE descriptor list", () => {
    render(<Harness selection={{ clear: vi.fn(), retain: vi.fn() }} />);

    expect(screen.getByRole("button", { name: STATUS_TRIGGER })).toBeVisible();
    expect(screen.getByRole("button", { name: TAG_TRIGGER })).toBeVisible();
  });

  // The gate decides only whether priority JOINS the list; its two neighbours
  // are asserted present in both states so a closed gate cannot pass by
  // rendering nothing at all.
  it("offers priority only once its gate is open", () => {
    render(<Harness selection={{ clear: vi.fn(), retain: vi.fn() }} />);
    expect(
      screen.queryByRole("button", { name: PRIORITY_TRIGGER })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: STATUS_TRIGGER })).toBeVisible();

    FEATURE_FLAGS.set(ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY, true);
    render(<Harness selection={{ clear: vi.fn(), retain: vi.fn() }} />);
    expect(
      screen.getAllByRole("button", { name: PRIORITY_TRIGGER })[0]
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: STATUS_TRIGGER })[0]
    ).toBeVisible();
  });

  it("sends the status batch exactly the selected row ids", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    render(<Harness selection={{ clear, retain: vi.fn() }} />);

    await user.click(screen.getByRole("button", { name: STATUS_TRIGGER }));
    await user.click(
      await screen.findByRole("menuitem", { name: DRAFT_OPTION })
    );

    await waitFor(() => expect(BATCH_UPDATE_STATUS).toHaveBeenCalledTimes(1));
    expect(BATCH_UPDATE_STATUS.mock.calls[0]?.[0]).toMatchObject({
      documentIds: SELECTED_IDS,
    });
    // Nothing landed yet — the mutation mock never calls back — so the
    // selection must still be the reader's.
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears the selection only once the status batch reports success", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    BATCH_UPDATE_STATUS.mockImplementation(
      (
        _input: unknown,
        handlers: { onSuccess: (response: BatchMutationResponse) => void }
      ) =>
        handlers.onSuccess({
          results: SELECTED_IDS.map((id) => batchItemApplied(id)),
        })
    );
    render(<Harness selection={{ clear, retain: vi.fn() }} />);

    await user.click(screen.getByRole("button", { name: STATUS_TRIGGER }));
    await user.click(
      await screen.findByRole("menuitem", { name: DRAFT_OPTION })
    );

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  });

  it("keeps only failed rows selected after a partial status update", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    const retain = vi.fn();
    BATCH_UPDATE_STATUS.mockImplementation(
      (
        _input: unknown,
        handlers: { onSuccess: (response: BatchMutationResponse) => void }
      ) =>
        handlers.onSuccess({
          results: [
            batchItemApplied(SELECTED_IDS[0] ?? ""),
            batchItemFailed(
              SELECTED_IDS[1] ?? "",
              BatchItemFailureCode.StaleStatus
            ),
          ],
        })
    );
    render(<Harness selection={{ clear, retain }} />);

    await user.click(screen.getByRole("button", { name: STATUS_TRIGGER }));
    await user.click(
      await screen.findByRole("menuitem", { name: DRAFT_OPTION })
    );

    await waitFor(() => expect(retain).toHaveBeenCalledWith([SELECTED_IDS[1]]));
    expect(clear).not.toHaveBeenCalled();
    expect(TOAST_ERROR).toHaveBeenCalledWith(
      BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.StaleStatus]
    );
  });

  it("uses stale-write copy when the selected rows changed before the batch finished", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    BATCH_UPDATE_STATUS.mockImplementation(
      (_input: unknown, handlers: { onError: (error: unknown) => void }) =>
        handlers.onError(
          new ApiError("stale", 409, {
            code: DocumentStatusMutationErrorCode.StaleStatus,
          })
        )
    );
    render(<Harness selection={{ clear, retain: vi.fn() }} />);

    await user.click(screen.getByRole("button", { name: STATUS_TRIGGER }));
    await user.click(
      await screen.findByRole("menuitem", { name: DRAFT_OPTION })
    );

    await waitFor(() =>
      expect(TOAST_ERROR).toHaveBeenCalledWith(
        "Could not update all items because the selection changed. Refresh and try again."
      )
    );
    expect(clear).not.toHaveBeenCalled();
  });

  // ISS-9443: the bar is the `bulk` surface, and the telemetry event is only
  // attributable if the request says so. Without the field the API counts
  // nothing for this control at all, and nothing else in the payload could tell
  // a bulk write from an inline one.
  it("names itself as the bulk surface on the priority batch", async () => {
    const user = userEvent.setup();
    FEATURE_FLAGS.set(ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY, true);
    render(<Harness selection={{ clear: vi.fn(), retain: vi.fn() }} />);

    await user.click(
      screen.getAllByRole("button", {
        name: PRIORITY_TRIGGER,
      })[0] as HTMLElement
    );
    await user.click(
      await screen.findByRole("menuitem", { name: HIGH_PRIORITY_OPTION })
    );

    await waitFor(() => expect(BATCH_UPDATE_PRIORITY).toHaveBeenCalledTimes(1));
    expect(BATCH_UPDATE_PRIORITY.mock.calls[0]?.[0]).toEqual({
      documentIds: SELECTED_IDS,
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
    });
  });

  it("keeps only failed rows selected after a partial priority update", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    const retain = vi.fn();
    FEATURE_FLAGS.set(ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY, true);
    BATCH_UPDATE_PRIORITY.mockImplementation(
      (
        _input: unknown,
        handlers: { onSuccess: (response: BatchMutationResponse) => void }
      ) =>
        handlers.onSuccess({
          results: [
            batchItemApplied(SELECTED_IDS[0] ?? ""),
            batchItemFailed(
              SELECTED_IDS[1] ?? "",
              BatchItemFailureCode.StalePriority
            ),
          ],
        })
    );
    render(<Harness selection={{ clear, retain }} />);

    await user.click(screen.getByRole("button", { name: PRIORITY_TRIGGER }));
    await user.click(
      await screen.findByRole("menuitem", { name: HIGH_PRIORITY_OPTION })
    );

    await waitFor(() => expect(retain).toHaveBeenCalledWith([SELECTED_IDS[1]]));
    expect(clear).not.toHaveBeenCalled();
    expect(TOAST_ERROR).toHaveBeenCalledWith(
      BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.StalePriority]
    );
  });

  it("omits status when the universal champion sees explicit bulk denial", () => {
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const denied = makeArtifact({
      statusMutation: {
        allowedStatuses: [DocumentStatus.Draft],
        expectedStatusByIdField: "expectedStatusById",
        expectedStatusField: "expectedStatus",
        permissions: {
          [DocumentStatusMutationOperation.Bulk]: false,
          [DocumentStatusMutationOperation.Single]: true,
        },
      },
    });

    render(
      <Harness
        rowIds={[denied.id]}
        selectedRows={[denied]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );

    expect(
      screen.queryByRole("button", { name: STATUS_TRIGGER })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: TAG_TRIGGER })).toBeVisible();

    const { result } = renderHook(() =>
      useBulkStatusAction([denied], [denied.id], {
        preservePageAction: true,
      })
    );
    expect(result.current?.applicableIds).toEqual([]);
    if (result.current?.kind !== "picker") {
      throw new Error("Expected page-capability status picker");
    }
    expect(result.current.options.length).toBeGreaterThan(0);
  });

  it("keeps the page status picker but filters choices by applicable-row capability", () => {
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const applicable = makeArtifact({
      id: "doc-1",
      statusMutation: mutationCapability([DocumentStatus.Draft]),
    });
    const denied = makeArtifact({
      id: "doc-2",
      statusMutation: {
        ...mutationCapability([DocumentStatus.Approved]),
        permissions: {
          [DocumentStatusMutationOperation.Bulk]: false,
          [DocumentStatusMutationOperation.Single]: true,
        },
      },
    });
    const { result } = renderHook(() =>
      useBulkStatusAction([applicable, denied], [applicable.id, denied.id], {
        preservePageAction: true,
      })
    );

    expect(result.current?.applicableIds).toEqual([applicable.id]);
    expect(result.current?.options.map((option) => option.id)).toEqual([
      DocumentStatus.Draft,
    ]);
    expect(result.current?.options.map((option) => option.id)).not.toContain(
      IssueStatus.InProgress
    );
  });

  it("uses the status mutation hook for registry execution", async () => {
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const row = makeArtifact({
      id: "doc-1",
      statusMutation: mutationCapability([DocumentStatus.Draft]),
    });
    const response = { results: [batchItemApplied(row.id)] };
    BATCH_UPDATE_STATUS_ASYNC.mockResolvedValue(response);
    const { result } = renderHook(() =>
      useBulkStatusAction([row], [row.id], { preservePageAction: true })
    );
    if (!result.current) {
      throw new Error("Expected page status picker");
    }

    await expect(
      result.current.executeForRegistry([row.id], DocumentStatus.Draft)
    ).resolves.toEqual(response);
    expect(BATCH_UPDATE_STATUS_ASYNC).toHaveBeenCalledWith({
      documentIds: [row.id],
      status: DocumentStatus.Draft,
      surface: ArtifactStatusEditSurface.Bulk,
    });
    expect(BATCH_UPDATE_STATUS).not.toHaveBeenCalled();
  });

  it("omits status for a mixed selection containing a non-document row", () => {
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const document = makeArtifact({ id: "doc-1" });
    const single = render(
      <Harness
        rowIds={[document.id]}
        selectedRows={[document]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );
    expect(screen.getByRole("button", { name: STATUS_TRIGGER })).toBeVisible();
    single.unmount();

    render(
      <Harness
        rowIds={["doc-1", "branch-1"]}
        selectedRows={[document]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );

    expect(
      screen.queryByRole("button", { name: STATUS_TRIGGER })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: TAG_TRIGGER })).toBeVisible();
    expect(BATCH_UPDATE_STATUS).not.toHaveBeenCalled();
  });

  it("omits status when any selected row has unrecognized raw evidence", () => {
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);

    render(
      <Harness
        selectedRows={[
          makeArtifact({ id: "doc-1" }),
          { ...makeArtifact({ id: "doc-2" }), rawStatus: "future-state" },
        ]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );

    expect(
      screen.queryByRole("button", { name: STATUS_TRIGGER })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: TAG_TRIGGER })).toBeVisible();
  });

  it("offers only the producer-authorized bulk targets", async () => {
    const user = userEvent.setup();
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const row = makeArtifact({
      statusMutation: mutationCapability([DocumentStatus.Draft]),
    });
    render(
      <Harness
        rowIds={[row.id]}
        selectedRows={[row]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );

    await user.click(screen.getByRole("button", { name: STATUS_TRIGGER }));
    expect(
      await screen.findByRole("menuitem", { name: "Drafting" })
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", {
        name: artifactStatusLabel(
          documentStatusFacet(DocumentType.Prd, DocumentStatus.Approved)
        ),
      })
    ).not.toBeInTheDocument();
  });

  it("omits the action when selected rows have no common allowed target", () => {
    FEATURE_FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const first = makeArtifact({
      id: "doc-1",
      statusMutation: mutationCapability([DocumentStatus.Draft]),
    });
    const second = makeArtifact({
      id: "doc-2",
      statusMutation: mutationCapability([DocumentStatus.Approved]),
    });
    render(
      <Harness
        selectedRows={[first, second]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );

    expect(
      screen.queryByRole("button", { name: STATUS_TRIGGER })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: TAG_TRIGGER })).toBeVisible();
  });

  it("sends the tag batch exactly the selected row ids", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        rowIds={["doc-9"]}
        selection={{ clear: vi.fn(), retain: vi.fn() }}
      />
    );

    await user.click(screen.getByRole("button", { name: TAG_TRIGGER }));
    await user.click(await screen.findByRole("button", { name: TAG_OPTION }));

    await waitFor(() => expect(BATCH_APPLY_TAG).toHaveBeenCalledTimes(1));
    expect(BATCH_APPLY_TAG.mock.calls[0]?.[0]).toMatchObject({
      entityIds: ["doc-9"],
      tagId: "tag-1",
    });
  });

  // DT-B06: the Documents tag action now renders through the shared picker, so
  // its completion callbacks are pinned through the rendered control. Changed
  // by operator ruling on the ISS-12305 review (Asana precedent): a successful
  // write keeps the selection.
  it.each([0, 2])(
    "keeps the selection and closes the picker once a tag write reports %i applied",
    async (appliedCount) => {
      const user = userEvent.setup();
      const clear = vi.fn();
      const retain = vi.fn();
      BATCH_APPLY_TAG.mockImplementation(
        (
          _input: unknown,
          handlers: { onSuccess: (result: { appliedCount: number }) => void }
        ) => handlers.onSuccess({ appliedCount })
      );
      render(<Harness selection={{ clear, retain }} />);

      await user.click(screen.getByRole("button", { name: TAG_TRIGGER }));
      await user.click(await screen.findByRole("button", { name: TAG_OPTION }));

      await waitFor(() =>
        expect(TOAST_SUCCESS).toHaveBeenCalledWith(
          appliedTagMessage(TAGS.value[0]?.name ?? "", appliedCount)
        )
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: TAG_OPTION })).toBeNull()
      );
      expect(clear).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
    }
  );

  it("keeps the selection and the open picker when the tag write is rejected", async () => {
    const user = userEvent.setup();
    const clear = vi.fn();
    const retain = vi.fn();
    BATCH_APPLY_TAG.mockImplementation(
      (_input: unknown, handlers: { onError: (error: unknown) => void }) =>
        handlers.onError(new ApiError("Forbidden", 403))
    );
    render(<Harness selection={{ clear, retain }} />);

    await user.click(screen.getByRole("button", { name: TAG_TRIGGER }));
    await user.click(await screen.findByRole("button", { name: TAG_OPTION }));

    await waitFor(() => expect(BATCH_APPLY_TAG).toHaveBeenCalledTimes(1));
    expect(clear).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    expect(TOAST_SUCCESS).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: TAG_OPTION })).toBeVisible();
  });

  it("says there are no tags rather than opening an empty list", async () => {
    const user = userEvent.setup();
    TAGS.value = [];
    render(<Harness selection={{ clear: vi.fn(), retain: vi.fn() }} />);

    await user.click(screen.getByRole("button", { name: TAG_TRIGGER }));

    expect(await screen.findByText("No tags available")).toBeVisible();
    expect(screen.queryByRole("button", { name: TAG_OPTION })).toBe(null);
  });
});

function mutationCapability(allowedStatuses: DocumentStatus[]) {
  return {
    allowedStatuses,
    expectedStatusByIdField: "expectedStatusById" as const,
    expectedStatusField: "expectedStatus" as const,
    permissions: {
      [DocumentStatusMutationOperation.Bulk]: true,
      [DocumentStatusMutationOperation.Single]: true,
    },
  };
}
