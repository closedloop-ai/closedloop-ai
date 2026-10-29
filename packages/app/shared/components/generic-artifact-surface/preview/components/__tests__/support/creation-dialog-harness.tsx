import type { TableCustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";
import { type ArtifactStatus, genericArtifacts } from "../../../fixtures";
import type {
  ArtifactCreationConfig,
  ArtifactCreationSubmissionOptions,
  ArtifactCreationValues,
} from "../../artifact-creation";
import { AddArtifactDialog } from "../../artifact-creation-dialog";
import { FIND_TIMEOUT } from "./flow-timeouts";

type User = ReturnType<typeof userEvent.setup>;

type CreateSpy = ReturnType<
  typeof vi.fn<
    (
      values: ArtifactCreationValues,
      options?: ArtifactCreationSubmissionOptions
    ) => void
  >
>;

/**
 * Parent that owns `open` the way the list shell does, so a test can close and
 * reopen the same dialog instance and observe which state survived.
 */
export function CreationHarness({
  config,
  customFields = [],
  initialStatus,
  onCreate,
  onOpenChange,
}: {
  config: ArtifactCreationConfig;
  customFields?: readonly TableCustomFieldDefinition[];
  initialStatus?: ArtifactStatus | null;
  onCreate: CreateSpy;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Reopen creator
      </button>
      <AddArtifactDialog
        artifacts={genericArtifacts.slice(0, 2)}
        config={config}
        customFields={customFields}
        initialStatus={initialStatus}
        onCreate={onCreate}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
        open={open}
      />
    </>
  );
}

/** Opens a creation chip picker and toggles one option; leaves it open. */
export async function pickOption(user: User, trigger: string, option: string) {
  await user.click(screen.getByRole("button", { name: trigger }));
  const list = await screen.findByRole("listbox", {}, FIND_TIMEOUT);
  await user.click(within(list).getByText(option));
}

export async function closeTopPopover(user: User) {
  await user.keyboard("{Escape}");
}

export function lastCreateCall(onCreate: CreateSpy) {
  const call = onCreate.mock.lastCall;
  if (!call) {
    throw new Error("onCreate was not called");
  }
  return call;
}

export function createSpy(): CreateSpy {
  return vi.fn();
}
