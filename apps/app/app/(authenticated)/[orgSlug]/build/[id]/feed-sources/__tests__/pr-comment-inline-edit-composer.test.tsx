// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrCommentInlineEditComposer } from "../pr-comment-inline-edit-composer";

function renderEditComposer(
  overrides: { onSubmit?: (body: string) => void; onCancel?: () => void } = {}
) {
  const onSubmit = overrides.onSubmit ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  render(
    <PrCommentInlineEditComposer
      initialBody="original body"
      isPending={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
  return { onSubmit, onCancel };
}

describe("PrCommentInlineEditComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds the textarea with the initial comment body", () => {
    renderEditComposer();
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "original body"
    );
  });

  it("submits the trimmed edited body via the Save button", () => {
    const { onSubmit } = renderEditComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), {
      target: { value: "edited body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith("edited body");
  });

  it("preserves the typed draft after submit so a failed edit is recoverable", () => {
    // The parent keeps this composer mounted when the save fails; submitting
    // must not wipe the textarea before the mutation resolves (FEA-2874).
    renderEditComposer();
    const textarea = screen.getByRole("textbox", { name: "Edit comment" });
    fireEvent.change(textarea, { target: { value: "edited body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(textarea).toHaveValue("edited body");
  });
});
