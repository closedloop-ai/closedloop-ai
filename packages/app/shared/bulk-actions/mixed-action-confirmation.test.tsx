// @vitest-environment jsdom

import { ArtifactBulkKind } from "@repo/api/src/types/artifact-bulk-action";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type MixedBulkActionCopyProvider,
  type MixedBulkActionRequest,
  useMixedBulkActionConfirmation,
} from "./mixed-action-confirmation";

const DOCUMENT = { id: "document-1", kind: ArtifactBulkKind.Document };
const BRANCH = { id: "branch-1", kind: ArtifactBulkKind.Branch };
const SESSION = { id: "session-1", kind: ArtifactBulkKind.Session };
const copyProvider: MixedBulkActionCopyProvider = (request) => ({
  title: `TEST ONLY: ${request.actionLabel}`,
  body: "TEST ONLY: Some rows cannot use this action.",
  formatInapplicableRow: (row) => `TEST ONLY: ${row.id}`,
  proceedLabel: "TEST ONLY: Proceed",
  cancelLabel: "TEST ONLY: Cancel",
});

function Harness({
  copy,
  request,
}: {
  copy?: MixedBulkActionCopyProvider;
  request: MixedBulkActionRequest;
}) {
  const { requestConfirmation, confirmationDialog } =
    useMixedBulkActionConfirmation(copy);
  return (
    <>
      <button onClick={() => requestConfirmation(request)} type="button">
        TEST ONLY: Choose
      </button>
      {confirmationDialog}
    </>
  );
}

describe("mixed bulk action confirmation", () => {
  it("cancels without execution, then confirms only through the captured request", async () => {
    const execute = vi.fn().mockResolvedValue(true);
    const request: MixedBulkActionRequest = {
      actionLabel: "Assign owner",
      selectedRows: [DOCUMENT, BRANCH],
      applicableRows: [DOCUMENT],
      inapplicableRows: [BRANCH],
      execute,
    };
    render(<Harness copy={copyProvider} request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Choose" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("TEST ONLY: branch-1");
    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Choose" }));
    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Proceed" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uses the approved copy, labels the row list by the title, and orders list before question", () => {
    const request: MixedBulkActionRequest = {
      actionLabel: "Change owner",
      selectedRows: [DOCUMENT, { ...BRANCH, label: "Feature branch" }, SESSION],
      applicableRows: [DOCUMENT, SESSION],
      inapplicableRows: [{ ...BRANCH, label: "Feature branch" }],
      execute: vi.fn().mockResolvedValue(true),
    };
    render(<Harness request={request} />);
    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Choose" }));

    const title = screen.getByRole("heading", {
      name: "Change owner isn't available for 1 of 3 selected artifacts",
    });
    const list = screen.getByRole("list");
    expect(title.querySelector("span")?.id).toBeTruthy();
    expect(list.getAttribute("aria-labelledby")).toBe(
      title.querySelector("span")?.id
    );
    expect(list).toHaveTextContent("Feature branch (branch)");
    const dialogText = screen.getByRole("dialog").textContent ?? "";
    expect(dialogText.indexOf("Feature branch (branch)")).toBeLessThan(
      dialogText.indexOf("Continue with the other 2?")
    );
    expect(
      screen.getByRole("button", { name: "Change owner for 2" })
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("keeps Proceed disabled when the selected artifact is all inapplicable", () => {
    const execute = vi.fn().mockResolvedValue(true);
    const request: MixedBulkActionRequest = {
      actionLabel: "Assign owner",
      selectedRows: [BRANCH],
      applicableRows: [],
      inapplicableRows: [BRANCH],
      execute,
    };
    render(<Harness request={request} />);
    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Choose" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Assign owner isn't available for 1 of 1 selected artifact"
    );
    expect(
      screen.getByRole("button", { name: "Assign owner for 0" })
    ).toBeDisabled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("closes the dialog when a stale confirmation returns false", async () => {
    const request: MixedBulkActionRequest = {
      actionLabel: "TEST ONLY: Assign owner",
      selectedRows: [DOCUMENT, BRANCH],
      applicableRows: [DOCUMENT],
      inapplicableRows: [BRANCH],
      execute: vi.fn().mockResolvedValue(false),
    };
    render(<Harness copy={copyProvider} request={request} />);
    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Choose" }));
    fireEvent.click(screen.getByRole("button", { name: "TEST ONLY: Proceed" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(request.execute).toHaveBeenCalledTimes(1);
  });
});
