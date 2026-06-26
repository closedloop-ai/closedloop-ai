import { describe, expect, it, vi } from "vitest";
import {
  getInlineImageFilesFromTransfer,
  insertInlineImageFileForEditor,
} from "./inline-image-upload";
import type { TiptapEditor } from "./types";

const ATTACHMENT_REF = "attachment://00000000-0000-4000-8000-000000000001";

function createEditor() {
  const transaction = {
    setMeta: vi.fn(() => transaction),
  };
  const chain = {
    focus: vi.fn(() => chain),
    insertContentAt: vi.fn(() => chain),
    run: vi.fn(),
  };
  const editor = {
    chain: vi.fn(() => chain),
    commands: { focus: vi.fn() },
    state: {
      selection: { from: 7 },
      tr: transaction,
    },
    view: {
      dispatch: vi.fn(),
    },
  } as unknown as TiptapEditor;

  return { chain, editor, transaction };
}

describe("inline image upload lifecycle", () => {
  it("filters paste/drop transfer files to image files", () => {
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const text = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(getInlineImageFilesFromTransfer([image, text])).toEqual([image]);
  });

  it("adds a placeholder and replaces it with a durable attachment ref", async () => {
    const { chain, editor } = createEditor();
    const addInlineImagePlaceholder = vi.fn();
    const removeInlineImagePlaceholder = vi.fn();
    const uploadInlineImage = vi.fn().mockResolvedValue({
      alt: "diagram",
      src: ATTACHMENT_REF,
    });
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    await insertInlineImageFileForEditor({
      addInlineImagePlaceholder,
      createUploadId: () => "upload-1",
      editor,
      file,
      findPlaceholderPosition: () => 11,
      inlineImagesEnabled: true,
      removeInlineImagePlaceholder,
      uploadInlineImage,
    });

    expect(addInlineImagePlaceholder).toHaveBeenCalledWith({
      id: "upload-1",
      label: "Uploading diagram.png",
      pos: 7,
    });
    expect(removeInlineImagePlaceholder).toHaveBeenCalledWith("upload-1");
    expect(chain.insertContentAt).toHaveBeenCalledWith(11, {
      attrs: {
        alt: "diagram",
        src: ATTACHMENT_REF,
      },
      type: "inlineImage",
    });
    expect(chain.run).toHaveBeenCalled();
  });

  it("reports validation failures without adding a placeholder", async () => {
    const { chain, editor } = createEditor();
    const onInlineImageUploadError = vi.fn();
    const uploadInlineImage = vi.fn();

    await insertInlineImageFileForEditor({
      addInlineImagePlaceholder: vi.fn(),
      editor,
      file: new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
      findPlaceholderPosition: () => null,
      inlineImagesEnabled: true,
      onInlineImageUploadError,
      removeInlineImagePlaceholder: vi.fn(),
      uploadInlineImage,
      validateInlineImageFile: () => "SVG is not supported",
    });

    expect(onInlineImageUploadError).toHaveBeenCalledWith(
      "SVG is not supported"
    );
    expect(editor.view.dispatch).not.toHaveBeenCalled();
    expect(uploadInlineImage).not.toHaveBeenCalled();
    expect(chain.insertContentAt).not.toHaveBeenCalled();
  });

  it("removes the placeholder and reports upload failures", async () => {
    const { chain, editor } = createEditor();
    const onInlineImageUploadError = vi.fn();
    const removeInlineImagePlaceholder = vi.fn();

    await insertInlineImageFileForEditor({
      addInlineImagePlaceholder: vi.fn(),
      createUploadId: () => "upload-2",
      editor,
      file: new File(["image"], "broken.png", { type: "image/png" }),
      findPlaceholderPosition: () => 11,
      inlineImagesEnabled: true,
      onInlineImageUploadError,
      removeInlineImagePlaceholder,
      uploadInlineImage: vi.fn().mockRejectedValue(new Error("PUT failed")),
    });

    expect(removeInlineImagePlaceholder).toHaveBeenCalledWith("upload-2");
    expect(onInlineImageUploadError).toHaveBeenCalledWith("PUT failed");
    expect(chain.insertContentAt).not.toHaveBeenCalled();
  });

  it("does not upload when inline images are disabled", async () => {
    const { editor } = createEditor();
    const uploadInlineImage = vi.fn();

    await insertInlineImageFileForEditor({
      addInlineImagePlaceholder: vi.fn(),
      editor,
      file: new File(["image"], "diagram.png", { type: "image/png" }),
      findPlaceholderPosition: () => null,
      inlineImagesEnabled: false,
      removeInlineImagePlaceholder: vi.fn(),
      uploadInlineImage,
    });

    expect(uploadInlineImage).not.toHaveBeenCalled();
    expect(editor.view.dispatch).not.toHaveBeenCalled();
  });
});
