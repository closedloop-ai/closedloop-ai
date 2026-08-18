// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TiptapEditorCore } from "./tiptap-editor-core";

const mocks = vi.hoisted(() => ({
  editor: null as TestEditor | null,
  editorOptions: null as EditorOptions | null,
  inlineImageConfigure: vi.fn(),
  insertInlineImageFileForEditor: vi.fn(),
  mermaidConfigure: vi.fn(),
  placeholderConfigure: vi.fn(),
  setEditorMarkdown: vi.fn(),
  starterKitConfigure: vi.fn(),
}));

vi.mock("@repo/design-system/lib/utils", () => ({
  cn: (...values: Array<string | false | undefined>) =>
    values.filter(Boolean).join(" "),
}));

vi.mock("@tiptap/react", () => ({
  EditorContent: ({ className }: Readonly<{ className?: string }>) => (
    <div className={className} data-testid="editor-content" />
  ),
  useEditor: (options: EditorOptions) => {
    mocks.editorOptions = options;
    return mocks.editor;
  },
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: mocks.starterKitConfigure },
}));

vi.mock("@tiptap/extension-list", () => ({
  TaskItem: { name: "taskItem" },
  TaskList: { name: "taskList" },
}));

vi.mock("@tiptap/extension-placeholder", () => ({
  Placeholder: { configure: mocks.placeholderConfigure },
}));

vi.mock("@tiptap/extension-table", () => ({
  Table: { configure: vi.fn(() => ({ name: "table" })) },
}));

vi.mock("@tiptap/extension-table-cell", () => ({
  TableCell: { name: "tableCell" },
}));

vi.mock("@tiptap/extension-table-header", () => ({
  TableHeader: { name: "tableHeader" },
}));

vi.mock("@tiptap/extension-table-row", () => ({
  TableRow: { name: "tableRow" },
}));

vi.mock("@tiptap/markdown", () => ({
  Markdown: { configure: vi.fn(() => ({ name: "markdown" })) },
}));

vi.mock("./inline-image-extension", () => ({
  InlineImageExtension: { configure: mocks.inlineImageConfigure },
}));

vi.mock("./mermaid-extension", () => ({
  MermaidExtension: { configure: mocks.mermaidConfigure },
}));

vi.mock("./inline-image-upload-placeholder", () => ({
  findInlineImagePlaceholderPosition: vi.fn(),
  InlineImageUploadPlaceholderExtension: { name: "uploadPlaceholder" },
  inlineImageUploadPlaceholderKey: "upload-placeholder-key",
}));

vi.mock("./inline-image-upload", () => ({
  getInlineImageFilesFromTransfer: (files: File[]) =>
    files.filter((file) => file.type.startsWith("image/")),
  insertInlineImageFileForEditor: mocks.insertInlineImageFileForEditor,
}));

vi.mock("./set-editor-markdown", () => ({
  setEditorMarkdown: mocks.setEditorMarkdown,
}));

vi.mock("./rich-text-toolbar", () => ({
  RichTextToolbar: ({
    onPasteMarkdown,
  }: Readonly<{ onPasteMarkdown: (markdown: string) => void }>) => (
    <button onClick={() => onPasteMarkdown("# pasted")} type="button">
      Toolbar
    </button>
  ),
}));

beforeEach(() => {
  mocks.editor = createEditor();
  mocks.editorOptions = null;
  mocks.inlineImageConfigure.mockReset().mockReturnValue({
    name: "inlineImage",
  });
  mocks.insertInlineImageFileForEditor.mockReset().mockResolvedValue(undefined);
  mocks.mermaidConfigure.mockReset().mockReturnValue({ name: "mermaid" });
  mocks.placeholderConfigure.mockReset().mockReturnValue({
    name: "placeholder",
  });
  mocks.setEditorMarkdown.mockReset();
  mocks.starterKitConfigure.mockReset().mockReturnValue({
    name: "starterKit",
  });
});

describe("TiptapEditorCore", () => {
  it("configures the public editor defaults and forwards editor callbacks", () => {
    const onChange = vi.fn();
    const onEditorReady = vi.fn();

    render(
      <TiptapEditorCore
        onChange={onChange}
        onEditorReady={onEditorReady}
        placeholder="Start writing"
        value="# initial"
      />
    );

    const options = getEditorOptions();
    expect(options.content).toBe("# initial");
    expect(options.contentType).toBe("markdown");
    expect(options.editable).toBe(true);
    expect(options.immediatelyRender).toBe(false);
    expect(mocks.placeholderConfigure).toHaveBeenCalledWith({
      placeholder: "Start writing",
      showOnlyWhenEditable: false,
    });
    expect(mocks.mermaidConfigure).toHaveBeenCalledWith({
      enhancementsEnabled: false,
    });
    expect(mocks.inlineImageConfigure).toHaveBeenCalledWith({
      enabled: false,
      resolveInlineImages: undefined,
    });

    act(() => options.onCreate?.({ editor: mocks.editor! }));
    expect(onEditorReady).toHaveBeenCalledWith(mocks.editor);
    expect(mocks.editor?.resetContent).toBeTypeOf("function");

    act(() => mocks.editor?.resetContent?.("# reset"));
    expect(mocks.setEditorMarkdown).toHaveBeenCalledWith(
      mocks.editor,
      "# reset"
    );

    act(() => options.onUpdate?.({ editor: mocks.editor! }));
    expect(onChange).toHaveBeenCalledWith("# current");
  });

  it("pins the link policy and enables Liveblocks-owned history", () => {
    const liveblocksExtension = { name: "liveblocks" } as never;

    render(
      <TiptapEditorCore
        liveblocksExtension={liveblocksExtension}
        onChange={vi.fn()}
        placeholder=""
        value=""
      />
    );

    const options = getEditorOptions();
    expect(options).not.toHaveProperty("content");
    expect(options.extensions).toContain(liveblocksExtension);
    expect(mocks.starterKitConfigure).toHaveBeenCalledWith(
      expect.objectContaining({ undoRedo: false })
    );

    const starterConfig = mocks.starterKitConfigure.mock.calls[0][0];
    const defaultValidate = vi.fn(() => true);
    expect(
      starterConfig.link.isAllowedUri("https://example.com", {
        defaultValidate,
      })
    ).toBe(true);
    expect(
      starterConfig.link.isAllowedUri("javascript:alert(1)", {
        defaultValidate,
      })
    ).toBe(false);
    expect(starterConfig.link.HTMLAttributes).toEqual({
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    });
  });

  it("seeds an empty ready Liveblocks room exactly once", () => {
    const liveblocksExtension = { name: "liveblocks" } as never;

    const { rerender } = render(
      <TiptapEditorCore
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady
        onChange={vi.fn()}
        value="# seed"
      />
    );

    expect(mocks.setEditorMarkdown).toHaveBeenCalledWith(
      mocks.editor,
      "# seed"
    );
    mocks.setEditorMarkdown.mockClear();

    rerender(
      <TiptapEditorCore
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady={false}
        onChange={vi.fn()}
        value="# changed"
      />
    );
    rerender(
      <TiptapEditorCore
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady
        onChange={vi.fn()}
        value="# changed"
      />
    );

    expect(mocks.setEditorMarkdown).not.toHaveBeenCalled();
  });

  it("does not overwrite a populated Liveblocks room or seed empty input", () => {
    mocks.editor!.getText.mockReturnValue("existing room content");

    const { unmount } = render(
      <TiptapEditorCore
        liveblocksExtension={{ name: "liveblocks" } as never}
        liveblocksIsReady
        onChange={vi.fn()}
        value="# seed"
      />
    );

    expect(mocks.setEditorMarkdown).not.toHaveBeenCalled();
    unmount();

    mocks.editor = createEditor();
    render(
      <TiptapEditorCore
        liveblocksExtension={{ name: "liveblocks" } as never}
        liveblocksIsReady
        onChange={vi.fn()}
        value=""
      />
    );
    expect(mocks.setEditorMarkdown).not.toHaveBeenCalled();
  });

  it("synchronizes changed non-Liveblocks markdown and editable state", () => {
    mocks.editor!.getMarkdown.mockReturnValue("same");
    const { rerender } = render(
      <TiptapEditorCore onChange={vi.fn()} readOnly value="same" />
    );

    expect(mocks.editor?.setEditable).toHaveBeenCalledWith(false);
    expect(mocks.setEditorMarkdown).not.toHaveBeenCalled();

    rerender(
      <TiptapEditorCore onChange={vi.fn()} readOnly={false} value="changed" />
    );

    expect(mocks.editor?.setEditable).toHaveBeenLastCalledWith(true);
    expect(mocks.setEditorMarkdown).toHaveBeenCalledWith(
      mocks.editor,
      "changed"
    );
  });

  it("keeps Liveblocks and editor-null value synchronization inert", () => {
    const { unmount } = render(
      <TiptapEditorCore
        liveblocksExtension={{ name: "liveblocks" } as never}
        onChange={vi.fn()}
        value="different"
      />
    );
    expect(mocks.setEditorMarkdown).not.toHaveBeenCalled();
    unmount();

    mocks.editor = null;
    render(<TiptapEditorCore onChange={vi.fn()} value="different" />);
    expect(mocks.setEditorMarkdown).not.toHaveBeenCalled();
  });

  it("exposes upload only while both the feature and callback are enabled", () => {
    const uploadInlineImage = vi.fn();
    const { rerender } = render(
      <TiptapEditorCore
        inlineImagesEnabled
        onChange={vi.fn()}
        uploadInlineImage={uploadInlineImage}
        value=""
      />
    );

    expect(mocks.editor?.insertInlineImageFile).toBeTypeOf("function");
    act(() => getEditorOptions().onCreate?.({ editor: mocks.editor! }));
    expect(mocks.editor?.insertInlineImageFile).toBeTypeOf("function");

    rerender(
      <TiptapEditorCore inlineImagesEnabled onChange={vi.fn()} value="" />
    );
    expect(mocks.editor?.insertInlineImageFile).toBeUndefined();
  });

  it("handles image drops and pastes through the editor-owned upload flow", async () => {
    const uploadInlineImage = vi.fn();
    render(
      <TiptapEditorCore
        inlineImagesEnabled
        onChange={vi.fn()}
        uploadInlineImage={uploadInlineImage}
        value=""
      />
    );

    const handlers = getEditorOptions().editorProps.handleDOMEvents;
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const dropEvent = {
      dataTransfer: { files: [image] },
      preventDefault: vi.fn(),
    };
    const pasteEvent = {
      clipboardData: { files: [image] },
      preventDefault: vi.fn(),
    };

    expect(handlers.drop({}, dropEvent)).toBe(true);
    expect(handlers.paste({}, pasteEvent)).toBe(true);
    await waitFor(() =>
      expect(mocks.insertInlineImageFileForEditor).toHaveBeenCalledTimes(2)
    );
    expect(dropEvent.preventDefault).toHaveBeenCalledOnce();
    expect(pasteEvent.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.insertInlineImageFileForEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        editor: mocks.editor,
        file: image,
        inlineImagesEnabled: true,
        uploadInlineImage,
      })
    );
  });

  it("ignores disabled, empty, and non-image transfer payloads", () => {
    render(<TiptapEditorCore onChange={vi.fn()} value="" />);
    const handlers = getEditorOptions().editorProps.handleDOMEvents;
    const preventDefault = vi.fn();

    expect(handlers.drop({}, { dataTransfer: undefined, preventDefault })).toBe(
      false
    );
    expect(
      handlers.paste(
        {},
        {
          clipboardData: {
            files: [new File(["text"], "notes.txt", { type: "text/plain" })],
          },
          preventDefault,
        }
      )
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.insertInlineImageFileForEditor).not.toHaveBeenCalled();
  });

  it("dispatches placeholder add and remove actions from an upload", async () => {
    mocks.insertInlineImageFileForEditor.mockImplementationOnce(
      ({ addInlineImagePlaceholder, removeInlineImagePlaceholder }) => {
        addInlineImagePlaceholder({
          id: "upload-1",
          label: "Uploading",
          pos: 4,
        });
        removeInlineImagePlaceholder("upload-1");
        return Promise.resolve();
      }
    );
    render(
      <TiptapEditorCore
        inlineImagesEnabled
        onChange={vi.fn()}
        uploadInlineImage={vi.fn()}
        value=""
      />
    );

    const image = new File(["image"], "diagram.png", { type: "image/png" });
    getEditorOptions().editorProps.handleDOMEvents.drop(
      {},
      { dataTransfer: { files: [image] }, preventDefault: vi.fn() }
    );

    await waitFor(() => expect(mocks.editor?.view.dispatch).toHaveBeenCalled());
    expect(mocks.editor?.transaction.setMeta).toHaveBeenNthCalledWith(
      2,
      "upload-placeholder-key",
      { id: "upload-1", label: "Uploading", pos: 4, type: "add" }
    );
    expect(mocks.editor?.transaction.setMeta).toHaveBeenNthCalledWith(
      3,
      "upload-placeholder-key",
      { id: "upload-1", type: "remove" }
    );
  });

  it("renders toolbar and scroll modes according to public props", () => {
    const { rerender } = render(
      <TiptapEditorCore
        className="custom-class"
        onChange={vi.fn()}
        toolbarMode="focus"
        value=""
      />
    );

    expect(
      screen.getByRole("button", { name: "Toolbar" }).parentElement?.className
    ).toContain("hidden group-focus-within:block");
    expect(
      screen.getByTestId("editor-content").parentElement?.className
    ).toContain("flex-1 overflow-y-auto");

    rerender(
      <TiptapEditorCore
        externalToolbar
        onChange={vi.fn()}
        scrollMode="outer"
        value=""
      />
    );
    expect(screen.queryByRole("button", { name: "Toolbar" })).toBeNull();
    expect(
      screen.getByTestId("editor-content").parentElement?.className
    ).not.toContain("overflow-y-auto");

    rerender(<TiptapEditorCore onChange={vi.fn()} readOnly value="" />);
    expect(screen.queryByRole("button", { name: "Toolbar" })).toBeNull();
  });

  it("uses the toolbar paste action to replace editor markdown", () => {
    render(<TiptapEditorCore onChange={vi.fn()} value="" />);
    mocks.setEditorMarkdown.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Toolbar" }));

    expect(mocks.setEditorMarkdown).toHaveBeenCalledWith(
      mocks.editor,
      "# pasted"
    );
  });
});

type EditorOptions = {
  content?: string;
  contentType?: string;
  editable: boolean;
  editorProps: {
    handleDOMEvents: {
      drop: (view: unknown, event: TransferEvent) => boolean;
      paste: (view: unknown, event: TransferEvent) => boolean;
    };
  };
  extensions: unknown[];
  immediatelyRender: boolean;
  onCreate?: (payload: { editor: TestEditor }) => void;
  onUpdate?: (payload: { editor: TestEditor }) => void;
};

type TransferEvent = {
  clipboardData?: { files: File[] };
  dataTransfer?: { files: File[] };
  preventDefault: () => void;
};

type TestEditor = {
  getMarkdown: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
  insertInlineImageFile?: (file: File) => Promise<void>;
  resetContent?: (markdown: string) => void;
  setEditable: ReturnType<typeof vi.fn>;
  state: { tr: TestEditor["transaction"] };
  transaction: { setMeta: ReturnType<typeof vi.fn> };
  view: { dispatch: ReturnType<typeof vi.fn> };
};

function createEditor(): TestEditor {
  const transaction = {
    setMeta: vi.fn(() => transaction),
  };
  return {
    getMarkdown: vi.fn(() => "# current"),
    getText: vi.fn(() => ""),
    setEditable: vi.fn(),
    state: { tr: transaction },
    transaction,
    view: { dispatch: vi.fn() },
  };
}

function getEditorOptions(): EditorOptions {
  if (!mocks.editorOptions) {
    throw new Error("useEditor options were not captured");
  }
  return mocks.editorOptions;
}
