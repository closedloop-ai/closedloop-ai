import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableBulkActionDescriptor,
  TableBulkActionOption,
  TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import type { ReactNode } from "react";

export type SessionsBulkActionOption = {
  id: string;
  label: string;
};

export type SessionsBulkUndo = () => Promise<void> | void;

/** Per-item v2 settlement; the legacy command may still return only Undo. */
export type SessionsBulkCommandOutcome = {
  undo: SessionsBulkUndo;
  succeededIds: readonly string[];
  failedIds: readonly string[];
};

export type SessionsBulkActionCommand = {
  options: readonly SessionsBulkActionOption[];
  /**
   * REQUIRED to hand back an undo (whitlockk review cid 4031486783). The descriptor
   * below declares `TableBulkActionUndo.Supported` unconditionally, so a
   * command permitted to return nothing could advertise a way back the applied
   * toast then never offers. Requiring the callback makes that mismatch
   * unconstructible instead of leaving it to a runtime check the type cannot
   * see.
   */
  onApply: (
    rowIds: readonly string[],
    option: SessionsBulkActionOption
  ) =>
    | Promise<SessionsBulkUndo | SessionsBulkCommandOutcome>
    | SessionsBulkUndo
    | SessionsBulkCommandOutcome;
  onCreateOption?: (
    label: string
  ) => Promise<SessionsBulkActionOption> | SessionsBulkActionOption;
};

/**
 * A host batch command as ONE bulk-action descriptor the rail renders
 * (ISS-8942), carrying the Sessions reporting this used to hardcode: the
 * applied toast with its Undo, and the failure toasts a rejected mutation or a
 * rejected option creation owe the reader.
 */
export function sessionsBulkPickerAction({
  command,
  icon,
  id,
  label,
}: {
  command: SessionsBulkActionCommand;
  icon: ReactNode;
  id: string;
  label: string;
}): TableBulkActionDescriptor {
  const create = command.onCreateOption;
  return {
    emptyLabel: "No matches",
    icon,
    id,
    kind: "picker",
    // ISS-10161: honoured by construction — `onApply` is typed to hand back a
    // SessionsBulkUndo, so the applied toast always has one to surface.
    undo: TableBulkActionUndo.Supported,
    label,
    onSelect: (rowIds, option, selection) =>
      applyBulkCommand({ command, label, option, rowIds, selection }),
    options: command.options,
    search: {
      label: `Search ${label.toLowerCase()}`,
      placeholder: "Search...",
    },
    // Attached only when the host can actually create one, so a command that
    // cannot does not grow a "Create …" row that resolves to nothing.
    ...(create
      ? {
          createOptionLabel: (query: string) => `Create “${query}”`,
          onCreateOption: async (
            query: string,
            rowIds: readonly string[],
            selection: TableBulkSelectionControls
          ) => {
            try {
              const option = await create(query);
              if (!option) {
                return false;
              }
              return await applyBulkCommand({
                command,
                label,
                option,
                rowIds,
                selection,
              });
            } catch {
              toast.error(`Couldn't create ${label.toLowerCase()}`);
              return false;
            }
          },
        }
      : {}),
  };
}

async function applyBulkCommand({
  command,
  label,
  option,
  rowIds,
  selection,
}: {
  command: SessionsBulkActionCommand;
  label: string;
  option: TableBulkActionOption;
  rowIds: readonly string[];
  selection: TableBulkSelectionControls;
}): Promise<boolean> {
  try {
    const applied = await command.onApply(rowIds, {
      id: option.id,
      label: option.label,
    });
    const undo = typeof applied === "function" ? applied : applied.undo;
    const succeededIds =
      typeof applied === "function" ? rowIds : applied.succeededIds;
    const failedIds = typeof applied === "function" ? [] : applied.failedIds;
    if (succeededIds.length === 0) {
      toast.error(`Couldn't ${label.toLowerCase()}`);
      selection.retain(failedIds);
      return false;
    }
    toast.success(`${label} applied to ${succeededIds.length} sessions`, {
      action: {
        label: "Undo",
        onClick: () =>
          Promise.resolve(undo()).catch(() =>
            toast.error(`Couldn't undo ${label.toLowerCase()}`)
          ),
      },
    });
    if (failedIds.length > 0) {
      toast.error(`Couldn't ${label.toLowerCase()}`);
      selection.retain(failedIds);
      return false;
    }
    selection.clear();
    return true;
  } catch {
    toast.error(`Couldn't ${label.toLowerCase()}`);
    return false;
  }
}
