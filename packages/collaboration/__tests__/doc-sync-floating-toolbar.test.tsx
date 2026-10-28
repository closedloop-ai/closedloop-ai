// @vitest-environment jsdom

import { createDocumentExtensions } from "@repo/document-schema/extensions";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOC_SYNC_FLOATING_TOOLBAR_KEY,
  DocSyncFloatingToolbar,
} from "../client/doc-sync-floating-toolbar";
import { installJsdomLayoutStubs } from "./support/jsdom-layout-stubs";

/** PLN-2189 T-2.9 / AC-014: the selection toolbar on doc-sync. */
const docSyncProbe = vi.hoisted(() => ({ onDocSync: true }));

vi.mock("../client/doc-sync-room", () => ({
  useIsOnDocSync: () => docSyncProbe.onDocSync,
}));

/** Liveblocks' `FloatingToolbar` labels, which the doc-sync one reuses. */
const FORMATTING_CONTROLS = [
  "Bold",
  "Italic",
  "Underline",
  "Strikethrough",
  "Inline code",
];

/** A focusable control elsewhere on the page, outside the toolbar. */
const OUTSIDE_INPUT_TEST_ID = "outside-input";

/** The editor's scrolling ancestor, as the document canvas is on the page. */
const SCROLLER_TEST_ID = "scroller";

const cleanups: (() => void)[] = [];

installJsdomLayoutStubs();

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  docSyncProbe.onDocSync = true;
  vi.restoreAllMocks();
});

describe("DocSyncFloatingToolbar", () => {
  it("shows the formatting controls, and no Comment control, for a selection under a DocSyncRoom", async () => {
    const editor = await mountEditor();

    expect(DOC_SYNC_FLOATING_TOOLBAR_KEY.get(editor.state)).toBeDefined();
    await selectFirstWord(editor);

    const toolbar = await screen.findByRole(
      "toolbar",
      { name: "Floating toolbar" },
      { timeout: 2000 }
    );
    for (const name of FORMATTING_CONTROLS) {
      expect(within(toolbar).getByRole("button", { name })).toBeVisible();
    }
    // The text-style control.
    expect(within(toolbar).getByRole("combobox")).toBeVisible();
    expect(
      within(toolbar).queryByRole("button", { name: "Add a comment" })
    ).toBeNull();
    expect(within(toolbar).queryByText("Comment")).toBeNull();
  });

  it("hides when focus leaves the editor for a control outside the toolbar", async () => {
    const editor = await mountEditor();
    await selectFirstWord(editor);
    await findToolbar();

    act(() => {
      screen.getByTestId(OUTSIDE_INPUT_TEST_ID).focus();
    });

    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("stays open, and applies the format, when focus moves into the toolbar", async () => {
    const editor = await mountEditor();
    await selectFirstWord(editor);
    const bold = within(await findToolbar()).getByRole("button", {
      name: "Bold",
    });

    // Focus first with no mousedown, so tiptap's click guard cannot be what
    // keeps the menu open.
    act(() => {
      bold.focus();
    });
    expect(screen.getByRole("toolbar")).toBeVisible();

    act(() => {
      fireEvent.mouseDown(bold);
      fireEvent.click(bold);
    });

    expect(editor.isActive("bold")).toBe(true);
    expect(
      screen.getByRole("toolbar", { name: "Floating toolbar" })
    ).toBeVisible();
  });

  it("opens the text-style dropdown inside the container that keeps the toolbar open", async () => {
    const editor = await mountEditor();
    await selectFirstWord(editor);
    const toolbar = await findToolbar();
    const textStyle = within(toolbar).getByRole("combobox");

    act(() => {
      textStyle.focus();
      fireEvent.keyDown(textStyle, { key: "Enter" });
    });

    const dropdown = await screen.findByRole("listbox");
    const container = toolbar.parentElement?.parentElement;
    expect(container).not.toBe(globalThis.document.body);
    expect(container?.contains(dropdown)).toBe(true);
  });

  it("tracks the selection's marks and block style on selection-only changes", async () => {
    const editor = await mountEditor(
      "<h1>Title</h1><p><strong>Hello</strong> world</p>"
    );
    await selectRange(editor, 8, 13);
    const toolbar = await findToolbar();
    const bold = () => within(toolbar).getByRole("button", { name: "Bold" });
    const textStyle = () => within(toolbar).getByRole("combobox");
    expect(bold()).toHaveAttribute("aria-pressed", "true");
    expect(textStyle()).toHaveTextContent("Text");

    await selectRange(editor, 14, 19);
    expect(bold()).toHaveAttribute("aria-pressed", "false");

    await selectRange(editor, 1, 6);
    expect(textStyle()).toHaveTextContent("Heading 1");
  });

  it("repositions on the editor's scrolling ancestor, not only the window", async () => {
    const addListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const editor = await mountEditor();
    await selectFirstWord(editor);
    await findToolbar();

    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    const scrollerListeners = addListener.mock.calls.filter(
      ([type], index) =>
        type === "scroll" && addListener.mock.contexts[index] === scroller
    );
    expect(scrollerListeners).toHaveLength(1);
  });

  it("renders nothing outside a DocSyncRoom, where the Liveblocks toolbar mounts", async () => {
    docSyncProbe.onDocSync = false;
    const editor = await mountEditor();

    await selectFirstWord(editor);

    // No bubble menu is registered, so no selection can ever show one.
    expect(DOC_SYNC_FLOATING_TOOLBAR_KEY.get(editor.state)).toBeUndefined();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

async function mountEditor(content = "<p>Hello world</p>") {
  const mounted: { editor: Editor | null } = { editor: null };
  function Harness() {
    const editor = useEditor({
      immediatelyRender: true,
      content,
      extensions: createDocumentExtensions({ undoRedo: false }),
    });
    mounted.editor = editor;
    return (
      <>
        <div data-testid={SCROLLER_TEST_ID} style={{ overflowY: "auto" }}>
          <EditorContent editor={editor} />
        </div>
        <DocSyncFloatingToolbar editor={editor} />
        <input data-testid={OUTSIDE_INPUT_TEST_ID} />
      </>
    );
  }
  const view = render(<Harness />);
  cleanups.push(() => view.unmount());
  await waitFor(() => expect(mounted.editor).not.toBeNull());
  const { editor } = mounted;
  if (!editor) {
    throw new Error("editor did not mount");
  }
  return editor;
}

function findToolbar() {
  return screen.findByRole(
    "toolbar",
    { name: "Floating toolbar" },
    { timeout: 2000 }
  );
}

function selectFirstWord(editor: Editor) {
  return selectRange(editor, 1, 6);
}

async function selectRange(editor: Editor, from: number, to: number) {
  await act(async () => {
    editor.chain().focus().setTextSelection({ from, to }).run();
    await Promise.resolve();
  });
}
