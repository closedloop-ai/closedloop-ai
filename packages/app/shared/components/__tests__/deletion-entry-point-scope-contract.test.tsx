import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeletionEntryPoint } from "../deletion-entry-point";
import {
  DELETION_SCOPE_ITEM_KIND,
  type DeletionEffects,
} from "../deletion-scope-review";

/**
 * ISS-12539, PR #8878 review: if the dialog ever confirms without the ids in
 * scope, the entry point must not hand the host an empty scope as if a
 * deletion had been asked for. The dialog is replaced by a stub that breaks
 * that contract, which the real dialog cannot be made to do. Strings are test
 * fixtures, not product copy.
 */
const confirmOutcome = vi.hoisted(() => ({ value: "" }));

vi.mock("../delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: ({
    onConfirm,
    open,
  }: {
    onConfirm: (scopeIds?: string[]) => Promise<boolean>;
    open: boolean;
  }) =>
    open ? (
      <>
        <button
          onClick={async () => {
            try {
              await onConfirm();
              confirmOutcome.value = "resolved";
            } catch {
              confirmOutcome.value = "rejected";
            }
          }}
          type="button"
        >
          fixture-confirm-without-ids
        </button>
        <button
          onClick={async () => {
            try {
              await onConfirm([]);
              confirmOutcome.value = "resolved";
            } catch {
              confirmOutcome.value = "rejected";
            }
          }}
          type="button"
        >
          fixture-confirm-empty
        </button>
      </>
    ) : null,
}));

const EFFECTS: DeletionEffects = {
  localCopies: { label: "fixture-local-label", statement: "fixture-local" },
  serverData: { label: "fixture-server-label", statement: "fixture-server" },
  sharedAccess: { label: "fixture-shared-label", statement: "fixture-shared" },
  futureReupload: {
    label: "fixture-reupload-label",
    statement: "fixture-reupload",
  },
};

function renderAndOpen() {
  const onConfirm = vi.fn(async (_ids: string[]) => true);
  render(
    <DeletionEntryPoint
      effects={EFFECTS}
      effectsLabel="fixture-effects"
      itemName="fixture-item"
      items={[
        {
          id: "ses-1",
          kind: DELETION_SCOPE_ITEM_KIND.SESSION,
          label: "fixture-session-one",
        },
      ]}
      onConfirm={onConfirm}
      scopeLabel="fixture-scope"
      title="fixture-title"
      triggerLabel="fixture-entry-point"
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "fixture-entry-point" }));
  return onConfirm;
}

describe("DeletionEntryPoint when the dialog breaks its scope contract", () => {
  it.each([
    ["no ids", "fixture-confirm-without-ids"],
    ["an empty list", "fixture-confirm-empty"],
  ])(
    "rejects a confirm with %s instead of requesting an empty deletion",
    async (_case, button) => {
      confirmOutcome.value = "";
      const onConfirm = renderAndOpen();
      fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(confirmOutcome.value).toBe("rejected"));
      expect(onConfirm).not.toHaveBeenCalled();
    }
  );
});
