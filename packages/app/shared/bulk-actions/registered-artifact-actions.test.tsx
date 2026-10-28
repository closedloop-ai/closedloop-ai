import {
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "@repo/api/src/types/artifact-bulk-action";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type TableBulkActionOption,
  TableBulkActionUndo,
  type TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { describe, expect, it, vi } from "vitest";
import { BULK_SELECTION_CHANGED_MESSAGE } from "./bulk-selection-copy";
import type { MixedBulkActionRequest } from "./mixed-action-confirmation";
import {
  descriptorBulkExecutor,
  registeredArtifactDescriptors,
} from "./registered-artifact-actions";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn() },
}));

describe("registered favorite and owner presentations", () => {
  it("sets one favorite target for the whole mixed-state selection and retains only refused IDs", async () => {
    const execute = vi.fn().mockResolvedValue({
      results: [
        batchItemApplied(FIRST),
        batchItemFailed(SECOND, BatchItemFailureCode.ArtifactsNotFound),
      ],
      transactionIds: ["one-transaction"],
    });
    const onCommitted = vi.fn();
    const favorite = registeredArtifactDescriptors({
      entries: [
        {
          id: ArtifactBulkAction.ChangeFavorite,
          supportedIds: [FIRST, SECOND],
          execute,
        },
      ],
      presentations: {},
      favoriteIds: new Set([FIRST]),
      users: [],
      onCommitted,
    })[0];
    if (favorite?.kind !== "command") {
      throw new Error("Expected favorite command");
    }
    const clear = vi.fn();
    const retain = vi.fn();
    favorite.onSelect([FIRST, SECOND], { clear, retain });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(retain).toHaveBeenCalledWith([SECOND]));
    expect(onCommitted).toHaveBeenCalledWith(
      [FIRST],
      ArtifactBulkAction.ChangeFavorite
    );
    expect(clear).not.toHaveBeenCalled();
  });

  it("passes the selected user ID through the owner registry entry", async () => {
    const execute = vi.fn().mockResolvedValue({
      results: [batchItemApplied(FIRST), batchItemApplied(SECOND)],
      transactionIds: ["owner-transaction"],
    });
    const owner = registeredArtifactDescriptors({
      entries: [
        {
          id: ArtifactBulkAction.ChangeOwner,
          supportedIds: [FIRST, SECOND],
          execute,
        },
      ],
      presentations: {},
      favoriteIds: new Set(),
      users: [{ id: "owner-1", name: "Ada" }],
      onCommitted: vi.fn(),
    })[0];
    if (owner?.kind !== "picker") {
      throw new Error("Expected owner picker");
    }
    const clear = vi.fn();
    const option = owner.options.find(
      (candidate) => candidate.id === "owner-1"
    );
    if (!option) {
      throw new Error("Expected owner option");
    }
    await owner.onSelect([FIRST, SECOND], option, { clear, retain: vi.fn() });
    expect(execute).toHaveBeenCalledWith("owner-1");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it.each([ArtifactBulkAction.ChangeStatus, ArtifactBulkAction.ChangePriority])(
    "executes %s through the registry entry",
    async (action) => {
      const execute = vi.fn().mockResolvedValue({
        results: [batchItemApplied(FIRST), batchItemApplied(SECOND)],
        transactionIds: ["field-transaction"],
      });
      const presentationOnSelect = vi.fn();
      const descriptor = registeredArtifactDescriptors({
        entries: [
          {
            id: action,
            supportedIds: [FIRST, SECOND],
            execute,
          },
        ],
        presentations: {
          [action]: {
            emptyLabel: "No matches",
            icon: null,
            id: action,
            kind: "picker",
            label: "Field",
            onSelect: presentationOnSelect,
            options: [{ id: "target", label: "Target" }],
            undo: TableBulkActionUndo.NotImplemented,
          },
        },
        favoriteIds: new Set(),
        users: [],
        onCommitted: vi.fn(),
      })[0];
      if (descriptor?.kind !== "picker") {
        throw new Error("Expected field picker");
      }
      const option = descriptor.options[0];
      if (!option) {
        throw new Error("Expected field option");
      }

      await descriptor.onSelect([FIRST, SECOND], option, {
        clear: vi.fn(),
        retain: vi.fn(),
      });

      expect(execute).toHaveBeenCalledWith("target");
      expect(presentationOnSelect).not.toHaveBeenCalled();
    }
  );

  it.each([ArtifactBulkAction.AddTag, ArtifactBulkAction.RemoveTag])(
    "preserves per-item %s settlement and retries only the failed row",
    async (action) => {
      const descriptorOnSelect = vi
        .fn()
        .mockImplementationOnce(
          (
            _ids: readonly string[],
            _option: TableBulkActionOption,
            selection: TableBulkSelectionControls
          ) => {
            selection.reportResult?.({
              appliedIds: [FIRST],
              failedIds: [SECOND],
            });
            return Promise.resolve(false);
          }
        )
        .mockImplementationOnce(
          (
            _ids: readonly string[],
            _option: TableBulkActionOption,
            selection: TableBulkSelectionControls
          ) => {
            selection.reportResult?.({
              appliedIds: [SECOND],
              failedIds: [],
            });
            return Promise.resolve(true);
          }
        );
      const presentation = {
        emptyLabel: "TEST ONLY: No matches",
        icon: null,
        id: action,
        kind: "picker" as const,
        label: "TEST ONLY: Tag",
        onSelect: descriptorOnSelect,
        options: [{ id: "tag-1", label: "TEST ONLY: Tag" }],
        undo: TableBulkActionUndo.NotImplemented,
      };
      const executor = descriptorBulkExecutor(presentation, {
        clear: vi.fn(),
        retain: vi.fn(),
      });
      const onCommitted = vi.fn();
      const retain = vi.fn();
      const first = registeredArtifactDescriptors({
        entries: [
          {
            id: action,
            supportedIds: [FIRST, SECOND],
            execute: (value) =>
              executor(
                [
                  { id: FIRST, kind: ArtifactBulkKind.Document },
                  { id: SECOND, kind: ArtifactBulkKind.Document },
                ],
                value
              ),
          },
        ],
        presentations: { [action]: presentation },
        favoriteIds: new Set(),
        users: [],
        onCommitted,
      })[0];
      if (first?.kind !== "picker") {
        throw new Error("Expected tag picker");
      }

      await first.onSelect([FIRST, SECOND], first.options[0]!, {
        clear: vi.fn(),
        retain,
      });

      expect(onCommitted).toHaveBeenCalledWith([FIRST], action);
      expect(retain).toHaveBeenCalledWith([SECOND]);

      const retry = registeredArtifactDescriptors({
        entries: [
          {
            id: action,
            supportedIds: [SECOND],
            execute: (value) =>
              executor(
                [{ id: SECOND, kind: ArtifactBulkKind.Document }],
                value
              ),
          },
        ],
        presentations: { [action]: presentation },
        favoriteIds: new Set(),
        users: [],
        onCommitted,
      })[0];
      if (retry?.kind !== "picker") {
        throw new Error("Expected retry tag picker");
      }
      await retry.onSelect([SECOND], retry.options[0]!, {
        clear: vi.fn(),
        retain: vi.fn(),
      });

      expect(descriptorOnSelect.mock.calls.map(([ids]) => ids)).toEqual([
        [FIRST, SECOND],
        [SECOND],
      ]);
    }
  );

  it("defers mixed owner selection and retains skipped plus failed rows in selection order", async () => {
    const execute = vi.fn().mockResolvedValue({
      results: [batchItemFailed(FIRST, BatchItemFailureCode.ArtifactsNotFound)],
      transactionIds: [],
    });
    const onMixedSelection = vi.fn((_request: MixedBulkActionRequest) => true);
    const retain = vi.fn();
    const clear = vi.fn();
    const owner = registeredArtifactDescriptors({
      entries: [
        {
          id: ArtifactBulkAction.ChangeOwner,
          supportedIds: [FIRST],
          partition: {
            selectedRows: [
              { id: SECOND, kind: ArtifactBulkKind.Branch },
              { id: FIRST, kind: ArtifactBulkKind.Document },
            ],
            applicableRows: [{ id: FIRST, kind: ArtifactBulkKind.Document }],
            inapplicableRows: [{ id: SECOND, kind: ArtifactBulkKind.Branch }],
          },
          execute,
        },
      ],
      presentations: {},
      favoriteIds: new Set(),
      users: [{ id: "owner-1", name: "Ada" }],
      onCommitted: vi.fn(),
      onMixedSelection,
    })[0];
    if (owner?.kind !== "picker") {
      throw new Error("Expected owner picker");
    }
    const selected = owner.options.find((option) => option.id === "owner-1");
    if (!selected) {
      throw new Error("Expected owner option");
    }

    expect(
      await owner.onSelect([SECOND, FIRST], selected, { clear, retain })
    ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const request = onMixedSelection.mock.calls[0]?.[0];
    expect(request?.inapplicableRows.map((row) => row.id)).toEqual([SECOND]);
    await request?.execute();
    expect(execute).toHaveBeenCalledWith("owner-1");
    expect(retain).toHaveBeenCalledWith([SECOND, FIRST]);
    expect(clear).not.toHaveBeenCalled();
  });

  it("executes an all-applicable partition immediately without asking for confirmation", async () => {
    const execute = vi.fn().mockResolvedValue({
      results: [batchItemApplied(FIRST), batchItemApplied(SECOND)],
      transactionIds: [],
    });
    const onMixedSelection = vi.fn((_request: MixedBulkActionRequest) => true);
    const owner = registeredArtifactDescriptors({
      entries: [
        {
          id: ArtifactBulkAction.ChangeOwner,
          supportedIds: [FIRST, SECOND],
          partition: {
            selectedRows: [
              { id: FIRST, kind: ArtifactBulkKind.Document },
              { id: SECOND, kind: ArtifactBulkKind.Session },
            ],
            applicableRows: [
              { id: FIRST, kind: ArtifactBulkKind.Document },
              { id: SECOND, kind: ArtifactBulkKind.Session },
            ],
            inapplicableRows: [],
          },
          execute,
        },
      ],
      presentations: {},
      favoriteIds: new Set(),
      users: [{ id: "owner-1", name: "TEST ONLY: Ada" }],
      onCommitted: vi.fn(),
      onMixedSelection,
    })[0];
    if (owner?.kind !== "picker") {
      throw new Error("Expected owner picker");
    }
    const option = owner.options.find(
      (candidate) => candidate.id === "owner-1"
    );
    if (!option) {
      throw new Error("Expected owner option");
    }
    const clear = vi.fn();

    expect(
      await owner.onSelect([FIRST, SECOND], option, { clear, retain: vi.fn() })
    ).toBe(true);
    expect(execute).toHaveBeenCalledWith("owner-1");
    expect(onMixedSelection).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("routes a mixed project picker through confirmation and only its entry executor", async () => {
    const execute = vi.fn().mockResolvedValue({
      results: [batchItemApplied(FIRST)],
      transactionIds: [],
    });
    const onMixedSelection = vi.fn((_request: MixedBulkActionRequest) => true);
    const retain = vi.fn();
    const move = registeredArtifactDescriptors({
      entries: [
        {
          id: ArtifactBulkAction.ChangeProject,
          supportedIds: [FIRST],
          partition: {
            selectedRows: [
              { id: FIRST, kind: ArtifactBulkKind.Document },
              { id: SECOND, kind: ArtifactBulkKind.Project },
            ],
            applicableRows: [{ id: FIRST, kind: ArtifactBulkKind.Document }],
            inapplicableRows: [{ id: SECOND, kind: ArtifactBulkKind.Project }],
          },
          execute,
        },
      ],
      presentations: {
        [ArtifactBulkAction.ChangeProject]: {
          emptyLabel: "TEST ONLY: No matches",
          icon: null,
          id: ArtifactBulkAction.ChangeProject,
          kind: "picker",
          label: "TEST ONLY: Move to project",
          onSelect: vi.fn(),
          options: [{ id: "project-1", label: "TEST ONLY: Project" }],
          undo: TableBulkActionUndo.NotImplemented,
        },
      },
      favoriteIds: new Set(),
      users: [],
      onCommitted: vi.fn(),
      onMixedSelection,
    })[0];
    if (move?.kind !== "picker") {
      throw new Error("Expected project picker");
    }
    const option = move.options[0];
    if (!option) {
      throw new Error("Expected project option");
    }
    await move.onSelect([FIRST, SECOND], option, {
      clear: vi.fn(),
      retain,
    });
    expect(execute).not.toHaveBeenCalled();
    const request = onMixedSelection.mock.calls[0]?.[0];
    await request?.execute();
    expect(execute).toHaveBeenCalledWith("project-1");
    expect(retain).toHaveBeenCalledWith([SECOND]);
  });

  it("reports stale selection and does not execute a pending confirmation", async () => {
    const execute = vi.fn();
    const onMixedSelection = vi.fn((_request: MixedBulkActionRequest) => true);
    const retain = vi.fn();
    const clear = vi.fn();
    let generation = 1;
    const owner = registeredArtifactDescriptors({
      entries: [
        {
          id: ArtifactBulkAction.ChangeOwner,
          supportedIds: [FIRST],
          partition: {
            selectedRows: [
              { id: FIRST, kind: ArtifactBulkKind.Document },
              { id: SECOND, kind: ArtifactBulkKind.Branch },
            ],
            applicableRows: [{ id: FIRST, kind: ArtifactBulkKind.Document }],
            inapplicableRows: [{ id: SECOND, kind: ArtifactBulkKind.Branch }],
          },
          execute,
        },
      ],
      presentations: {},
      favoriteIds: new Set(),
      users: [{ id: "owner-1", name: "TEST ONLY: Ada" }],
      onCommitted: vi.fn(),
      onMixedSelection,
    })[0];
    if (owner?.kind !== "picker") {
      throw new Error("Expected owner picker");
    }
    const option = owner.options.find(
      (candidate) => candidate.id === "owner-1"
    );
    if (!option) {
      throw new Error("Expected owner option");
    }
    const selection = { clear, retain, getGeneration: () => generation };
    await owner.onSelect([FIRST, SECOND], option, selection);
    generation = 2;

    expect(await onMixedSelection.mock.calls[0]?.[0].execute()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(BULK_SELECTION_CHANGED_MESSAGE);
    expect(clear).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
  });

  it("uses each descriptor label for its mixed-confirmation copy", () => {
    const onMixedSelection = vi.fn((_request: MixedBulkActionRequest) => true);
    const entries = [
      {
        id: ArtifactBulkAction.ChangeFavorite,
        supportedIds: [FIRST],
        partition: {
          selectedRows: [
            { id: FIRST, kind: ArtifactBulkKind.Document },
            { id: SECOND, kind: ArtifactBulkKind.Branch },
          ],
          applicableRows: [{ id: FIRST, kind: ArtifactBulkKind.Document }],
          inapplicableRows: [{ id: SECOND, kind: ArtifactBulkKind.Branch }],
        },
        execute: vi.fn(),
      },
      {
        id: ArtifactBulkAction.ChangeOwner,
        supportedIds: [FIRST],
        partition: {
          selectedRows: [
            { id: FIRST, kind: ArtifactBulkKind.Document },
            { id: SECOND, kind: ArtifactBulkKind.Branch },
          ],
          applicableRows: [{ id: FIRST, kind: ArtifactBulkKind.Document }],
          inapplicableRows: [{ id: SECOND, kind: ArtifactBulkKind.Branch }],
        },
        execute: vi.fn(),
      },
    ];
    const [favorite, owner] = registeredArtifactDescriptors({
      entries,
      presentations: {},
      favoriteIds: new Set(),
      users: [{ id: "owner-1", name: "TEST ONLY: Ada" }],
      onCommitted: vi.fn(),
      onMixedSelection,
    });
    if (favorite?.kind !== "command" || owner?.kind !== "picker") {
      throw new Error("Expected favorite and owner descriptors");
    }
    favorite.onSelect([FIRST, SECOND], { clear: vi.fn(), retain: vi.fn() });
    owner.onSelect([FIRST, SECOND], owner.options[0]!, {
      clear: vi.fn(),
      retain: vi.fn(),
    });

    expect(
      onMixedSelection.mock.calls.map(([request]) => request.actionLabel)
    ).toEqual([favorite.label, owner.label]);
  });
});
