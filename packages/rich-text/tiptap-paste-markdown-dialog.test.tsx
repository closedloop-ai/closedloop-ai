// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TiptapPasteMarkdownDialog } from "./tiptap-paste-markdown-dialog";

const PLACEHOLDER = "Paste your markdown here...";

afterEach(() => {
  vi.clearAllMocks();
});

function renderDialog() {
  const onOpenChange = vi.fn();
  const onSetContent = vi.fn();
  const view = render(
    <TiptapPasteMarkdownDialog
      onOpenChange={onOpenChange}
      onSetContent={onSetContent}
      open
    />
  );
  return { onOpenChange, onSetContent, view };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

describe("TiptapPasteMarkdownDialog", () => {
  it("disables Set Content until non-whitespace markdown is entered", () => {
    renderDialog();
    const setContent = screen.getByRole("button", { name: "Set Content" });

    expect(setContent.hasAttribute("disabled")).toBe(true);
    fireEvent.change(textarea(), { target: { value: "   " } });
    expect(setContent.hasAttribute("disabled")).toBe(true);
    fireEvent.change(textarea(), { target: { value: "# Title" } });
    expect(setContent.hasAttribute("disabled")).toBe(false);
  });

  it("submits the markdown, clears the input and closes", () => {
    const { onOpenChange, onSetContent } = renderDialog();
    fireEvent.change(textarea(), { target: { value: "# Title" } });

    fireEvent.click(screen.getByRole("button", { name: "Set Content" }));

    expect(onSetContent).toHaveBeenCalledWith("# Title");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(textarea().value).toBe("");
  });

  it("clears the input and closes on Cancel without submitting", () => {
    const { onOpenChange, onSetContent } = renderDialog();
    fireEvent.change(textarea(), { target: { value: "draft" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSetContent).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(textarea().value).toBe("");
  });

  it("clears the input when the dialog is dismissed with Escape", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(textarea(), { target: { value: "draft" } });

    fireEvent.keyDown(textarea(), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(textarea().value).toBe("");
  });
});
