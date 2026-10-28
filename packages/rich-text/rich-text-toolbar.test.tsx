// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTextToolbar } from "./rich-text-toolbar";

afterEach(() => {
  vi.clearAllMocks();
});

describe("RichTextToolbar", () => {
  it("opens the paste dialog from the toolbar and forwards submitted markdown", () => {
    const onPasteMarkdown = vi.fn();
    render(<RichTextToolbar editor={null} onPasteMarkdown={onPasteMarkdown} />);

    expect(
      screen.queryByPlaceholderText("Paste your markdown here...")
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Paste Markdown" }));
    fireEvent.change(
      screen.getByPlaceholderText("Paste your markdown here..."),
      {
        target: { value: "**bold**" },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Set Content" }));

    expect(onPasteMarkdown).toHaveBeenCalledWith("**bold**");
    expect(
      screen.queryByPlaceholderText("Paste your markdown here...")
    ).toBeNull();
  });

  it("passes onUploadInlineImage through to the toolbar", () => {
    render(
      <RichTextToolbar
        editor={null}
        onPasteMarkdown={vi.fn()}
        onUploadInlineImage={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Insert Image" })).toBeTruthy();
  });
});
