import { describe, expect, it, vi } from "vitest";
import { setEditorMarkdown } from "./set-editor-markdown";

describe("setEditorMarkdown", () => {
  it("calls editor.commands.setContent after microtask when editor is non-null", async () => {
    const setContent = vi.fn();
    const editor = { commands: { setContent } } as never;

    setEditorMarkdown(editor, "# Hello");

    // Not called synchronously
    expect(setContent).not.toHaveBeenCalled();

    // Flush microtask queue
    await Promise.resolve();

    expect(setContent).toHaveBeenCalledOnce();
    expect(setContent).toHaveBeenCalledWith("# Hello", {
      contentType: "markdown",
    });
  });

  it("does nothing when editor is null", async () => {
    // Should not throw
    setEditorMarkdown(null, "# Hello");
    await Promise.resolve();
  });
});
