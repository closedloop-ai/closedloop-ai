// @vitest-environment jsdom

import { GapCursor } from "@tiptap/pm/gapcursor";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorProps } from "@tiptap/pm/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorSelectionFixture } from "./__tests__/editor-selection-fixture";
import { synchronizeEditorDomSelection } from "./editor-dom-selection";

const fixtures: ReturnType<typeof createEditorSelectionFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.destroy();
  }
});

describe("synchronizeEditorDomSelection", () => {
  it.each([
    { key: "b", mark: "bold" },
    { key: "i", mark: "italic" },
    { key: "u", mark: "underline" },
  ])(
    "applies $mark to the native selection before the keymap runs",
    ({ key, mark }) => {
      const fixture = createFixture({
        handleKeyDown: synchronizeEditorDomSelection,
      });
      fixture.selectNative(0, 5);
      expect(selectedText(fixture)).toBe("Type");

      const event = shortcut(key);
      fixture.view.dom.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(selectedText(fixture)).toBe("Typed");
      expect(
        fixture.view.state.doc.rangeHasMark(5, 6, fixture.schema.marks[mark])
      ).toBe(true);
      expect(fixture.view.hasFocus()).toBe(true);
    }
  );

  it.each([
    { anchor: 0, head: 5, modelAnchor: 1, modelHead: 6 },
    { anchor: 5, head: 0, modelAnchor: 6, modelHead: 1 },
  ])(
    "preserves native anchor $anchor and head $head",
    ({ anchor, head, modelAnchor, modelHead }) => {
      const fixture = createFixture();
      fixture.selectNative(anchor, head);

      expect(synchronizeEditorDomSelection(fixture.view, shortcut())).toBe(
        false
      );

      expect(fixture.view.state.selection.anchor).toBe(modelAnchor);
      expect(fixture.view.state.selection.head).toBe(modelHead);
    }
  );

  it("also synchronizes macOS modifier shortcuts", () => {
    const fixture = createFixture();
    fixture.selectNative(0, 5);
    const event = new globalThis.KeyboardEvent("keydown", {
      key: "b",
      metaKey: true,
    });

    synchronizeEditorDomSelection(fixture.view, event);

    expect(selectedText(fixture)).toBe("Typed");
    expect(event.defaultPrevented).toBe(false);
  });

  it("adopts the public editor selection factory result", () => {
    const factory = vi.fn<NonNullable<EditorProps["createSelectionBetween"]>>(
      (view, anchor, head) =>
        TextSelection.create(view.state.doc, anchor.pos, head.pos + 1)
    );
    const fixture = createFixture({ createSelectionBetween: factory });
    fixture.selectNative(5, 0);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(factory).toHaveBeenCalledWith(
      fixture.view,
      expect.objectContaining({ pos: 6 }),
      expect.objectContaining({ pos: 1 })
    );
    expect(fixture.view.state.selection).toBe(factory.mock.results[0]?.value);
    expect(fixture.view.state.selection.anchor).toBe(6);
    expect(fixture.view.state.selection.head).toBe(2);
  });

  it("does not dispatch when native and model selections already agree", () => {
    const fixture = createFixture();
    fixture.selectNative(0, 4);
    const dispatch = vi.spyOn(fixture.view, "dispatch");

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves a native select-all selection intact", () => {
    const fixture = createFixture();
    fixture.view.dispatch(
      fixture.view.state.tr.setSelection(
        new AllSelection(fixture.view.state.doc)
      )
    );
    fixture.view.focus();

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBeInstanceOf(AllSelection);
  });

  it("accepts a native text selection after a stale select-all model", () => {
    const fixture = createFixture();
    fixture.view.dispatch(
      fixture.view.state.tr.setSelection(
        new AllSelection(fixture.view.state.doc)
      )
    );
    fixture.selectNative(0, 5);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
    expect(selectedText(fixture)).toBe("Typed");
  });

  it("formats genuine native text after a stale image node selection", () => {
    const fixture = createImageFixture({
      handleKeyDown: synchronizeEditorDomSelection,
    });
    fixture.selectNative(0, 5);
    expect(fixture.view.state.selection).toBeInstanceOf(NodeSelection);

    const event = shortcut();
    fixture.view.dom.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
    expect(fixture.view.state.selection.anchor).toBe(1);
    expect(fixture.view.state.selection.head).toBe(6);
    expect(selectedText(fixture)).toBe("Typed");
    expect(fixture.view.state.doc.firstChild?.firstChild?.text).toBe("Typed");
    expect(fixture.view.state.doc.firstChild?.firstChild?.marks).toEqual([
      fixture.schema.marks.bold.create(),
    ]);
  });

  it("retains a genuine native image node selection", () => {
    const fixture = createImageFixture();
    const image = fixture.view.dom.querySelector("img");
    const native = fixture.view.dom.ownerDocument.getSelection();
    if (!(image && native)) {
      throw new Error("Editor fixture image/native selection missing");
    }
    const range = fixture.view.dom.ownerDocument.createRange();
    range.selectNode(image);
    native.removeAllRanges();
    native.addRange(range);
    const selectedImage = fixture.view.state.selection;

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBe(selectedImage);
    expect(fixture.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(fixture.view.state.selection.from).toBe(6);
    expect(fixture.view.state.selection.to).toBe(7);
  });

  it("accepts a native text caret after a stale image node selection", () => {
    const fixture = createImageFixture();
    fixture.selectNative(2, 2);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
    expect(fixture.view.state.selection.anchor).toBe(3);
    expect(fixture.view.state.selection.head).toBe(3);
  });

  it("accepts native paragraph-boundary text after a stale image selection", () => {
    const fixture = createImageFixture();
    const paragraph = fixture.view.dom.querySelector("p");
    const native = fixture.view.dom.ownerDocument.getSelection();
    if (!(paragraph && native)) {
      throw new Error("Editor fixture paragraph/native selection missing");
    }
    native.setBaseAndExtent(paragraph, 0, paragraph, 1);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
    expect(fixture.view.state.selection.anchor).toBe(1);
    expect(fixture.view.state.selection.head).toBe(6);
    expect(selectedText(fixture)).toBe("Typed");
  });

  it.each([false, true])(
    "formats marked-wrapper text with reversed=%s after a stale image selection",
    (reversed) => {
      const fixture = createImageFixture({
        handleKeyDown: synchronizeEditorDomSelection,
      });
      fixture.view.dispatch(
        fixture.view.state.tr.addMark(1, 6, fixture.schema.marks.bold.create())
      );
      const marked = fixture.view.dom.querySelector("strong");
      const native = fixture.view.dom.ownerDocument.getSelection();
      if (!(marked && native)) {
        throw new Error("Editor fixture marked text/native selection missing");
      }
      if (reversed) {
        native.setBaseAndExtent(marked, 1, marked, 0);
      } else {
        native.setBaseAndExtent(marked, 0, marked, 1);
      }
      expect(fixture.view.state.selection).toBeInstanceOf(NodeSelection);
      expect(native.toString()).toBe("Typed");

      const event = shortcut();
      fixture.view.dom.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
      expect(fixture.view.state.selection.anchor).toBe(reversed ? 6 : 1);
      expect(fixture.view.state.selection.head).toBe(reversed ? 1 : 6);
      expect(selectedText(fixture)).toBe("Typed");
      expect(fixture.view.state.doc.firstChild?.firstChild?.text).toBe("Typed");
      expect(fixture.view.state.doc.firstChild?.firstChild?.marks).toEqual([]);
      expect(fixture.view.state.doc.nodeAt(6)?.marks).toEqual([]);
    }
  );

  it.each([0, 1])(
    "formats an empty paragraph caret at DOM offset %s after a stale image selection",
    (offset) => {
      const fixture = createFixture({
        handleKeyDown: synchronizeEditorDomSelection,
      });
      const doc = fixture.schema.node("doc", null, [
        fixture.schema.node("paragraph", null, fixture.schema.node("image")),
        fixture.schema.node("paragraph"),
      ]);
      fixture.view.dispatch(
        fixture.view.state.tr.replaceWith(
          0,
          fixture.view.state.doc.content.size,
          doc.content
        )
      );
      fixture.view.dispatch(
        fixture.view.state.tr.setSelection(
          NodeSelection.create(fixture.view.state.doc, 1)
        )
      );
      const paragraph = fixture.view.dom.querySelectorAll("p")[1];
      const native = fixture.view.dom.ownerDocument.getSelection();
      if (!(paragraph && native)) {
        throw new Error(
          "Editor fixture empty paragraph/native selection missing"
        );
      }
      native.setBaseAndExtent(paragraph, offset, paragraph, offset);

      const event = shortcut();
      fixture.view.dom.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
      expect(fixture.view.state.selection.anchor).toBe(4);
      expect(fixture.view.state.selection.head).toBe(4);
      expect(fixture.view.state.storedMarks).toEqual([
        fixture.schema.marks.bold.create(),
      ]);
      expect(fixture.view.state.doc.nodeAt(1)?.type).toBe(
        fixture.schema.nodes.image
      );
      expect(fixture.view.state.doc.nodeAt(1)?.marks).toEqual([]);
    }
  );

  it("retains an atom selection when its DOM label contains native text", () => {
    const fixture = createImageFixture({
      nodeViews: {
        image: () => {
          const dom = globalThis.document.createElement("span");
          dom.textContent = "Image label";
          return { dom };
        },
      },
    });
    const label = fixture.view.dom.querySelector("span")?.firstChild;
    const native = fixture.view.dom.ownerDocument.getSelection();
    if (!(label && native)) {
      throw new Error("Editor fixture atom label/native selection missing");
    }
    native.setBaseAndExtent(label, 1, label, 5);
    const selection = fixture.view.state.selection;

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBe(selection);
    expect(fixture.view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("retains a custom selection owned by another plugin", () => {
    const fixture = createFixture();
    const doc = fixture.schema.node("doc", null, [
      fixture.schema.node("blockAtom"),
      fixture.schema.node("paragraph", null, fixture.schema.text("Typed")),
    ]);
    fixture.view.dispatch(
      fixture.view.state.tr.replaceWith(
        0,
        fixture.view.state.doc.content.size,
        doc.content
      )
    );
    const selection = new GapCursor(fixture.view.state.doc.resolve(0));
    fixture.view.dispatch(fixture.view.state.tr.setSelection(selection));
    fixture.selectNative(0, 5);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBe(selection);
  });

  it.each([false, true])(
    "maps native text across mark fragments with reversed=%s",
    (reversed) => {
      const fixture = createFixture();
      const doc = fixture.schema.node("doc", null, [
        fixture.schema.node("paragraph", null, [
          fixture.schema.text("Ty", [fixture.schema.marks.bold.create()]),
          fixture.schema.text("ped"),
        ]),
      ]);
      fixture.view.dispatch(
        fixture.view.state.tr.replaceWith(
          0,
          fixture.view.state.doc.content.size,
          doc.content
        )
      );
      fixture.view.dispatch(
        fixture.view.state.tr.setSelection(
          TextSelection.create(fixture.view.state.doc, 1, 5)
        )
      );
      const first = fixture.view.dom.querySelector("strong")?.firstChild;
      const last = fixture.view.dom.querySelector("p")?.lastChild;
      const native = fixture.view.dom.ownerDocument.getSelection();
      if (!(first && last && native)) {
        throw new Error(
          "Editor fixture fragmented text/native selection missing"
        );
      }
      if (reversed) {
        native.setBaseAndExtent(last, 3, first, 0);
      } else {
        native.setBaseAndExtent(first, 0, last, 3);
      }

      synchronizeEditorDomSelection(fixture.view, shortcut());

      expect(fixture.view.state.selection.anchor).toBe(reversed ? 6 : 1);
      expect(fixture.view.state.selection.head).toBe(reversed ? 1 : 6);
      expect(selectedText(fixture)).toBe("Typed");
    }
  );

  it.each([
    { key: "b", ctrlKey: true, isComposing: true },
    { key: "Process", ctrlKey: true },
    { key: "Dead", ctrlKey: true },
    { key: "Control", ctrlKey: true },
    { key: "b", ctrlKey: true, altKey: true },
    { key: "ArrowRight" },
  ])(
    "defers $key without changing selection for non-shortcut input",
    (options) => {
      const fixture = createFixture();
      fixture.selectNative(0, 5);

      synchronizeEditorDomSelection(
        fixture.view,
        new globalThis.KeyboardEvent("keydown", options)
      );

      expect(selectedText(fixture)).toBe("Type");
    }
  );

  it("defers while the editor has an active IME composition", () => {
    const fixture = createFixture();
    fixture.view.dom.dispatchEvent(
      new globalThis.CompositionEvent("compositionstart", { bubbles: true })
    );
    fixture.selectNative(0, 5);
    expect(fixture.view.composing).toBe(true);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(selectedText(fixture)).toBe("Type");
  });

  it("does not change selection for a prevented shortcut", () => {
    const fixture = createFixture();
    fixture.selectNative(0, 5);
    const event = shortcut();
    event.preventDefault();

    synchronizeEditorDomSelection(fixture.view, event);

    expect(selectedText(fixture)).toBe("Type");
  });

  it("does not change a read-only editor", () => {
    const fixture = createFixture({ editable: () => false });
    fixture.selectNative(0, 5);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(selectedText(fixture)).toBe("Type");
  });

  it("does not steal focus from a control outside the editor", () => {
    const fixture = createFixture();
    fixture.selectNative(0, 5);
    const button = globalThis.document.createElement("button");
    globalThis.document.body.append(button);
    try {
      button.focus();
      synchronizeEditorDomSelection(fixture.view, shortcut());
      expect(selectedText(fixture)).toBe("Type");
      expect(globalThis.document.activeElement).toBe(button);
    } finally {
      button.remove();
    }
  });

  it("defers a selection that crosses out of the editor", () => {
    const fixture = createFixture();
    const outside = globalThis.document.createTextNode("outside");
    globalThis.document.body.append(outside);
    try {
      const text = fixture.view.dom.querySelector("p")?.firstChild;
      if (!text) {
        throw new Error("Editor fixture text missing");
      }
      globalThis.document.getSelection()?.setBaseAndExtent(text, 0, outside, 2);
      synchronizeEditorDomSelection(fixture.view, shortcut());
      expect(selectedText(fixture)).toBe("Type");
    } finally {
      outside.remove();
    }
  });

  it("defers when the native selection cannot be mapped to a document position", () => {
    const fixture = createFixture();
    fixture.selectNative(0, 5);
    vi.spyOn(fixture.view, "posAtDOM").mockImplementation(() => {
      throw new RangeError("Position out of range");
    });
    const dispatch = vi.spyOn(fixture.view, "dispatch");

    expect(synchronizeEditorDomSelection(fixture.view, shortcut())).toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(selectedText(fixture)).toBe("Type");
  });

  it("rethrows a mapping failure that is not a RangeError", () => {
    const fixture = createFixture();
    fixture.selectNative(0, 5);
    const failure = new TypeError("view detached");
    vi.spyOn(fixture.view, "posAtDOM").mockImplementation(() => {
      throw failure;
    });

    expect(() =>
      synchronizeEditorDomSelection(fixture.view, shortcut())
    ).toThrow(failure);
    expect(selectedText(fixture)).toBe("Type");
  });

  it("replaces a stale image selection with native text that extends past the image", () => {
    const fixture = createFixture();
    const doc = fixture.schema.node("doc", null, [
      fixture.schema.node("paragraph", null, [
        fixture.schema.text("Typed"),
        fixture.schema.node("image"),
        fixture.schema.text("xy"),
      ]),
    ]);
    fixture.view.dispatch(
      fixture.view.state.tr.replaceWith(
        0,
        fixture.view.state.doc.content.size,
        doc.content
      )
    );
    fixture.view.dispatch(
      fixture.view.state.tr.setSelection(
        NodeSelection.create(fixture.view.state.doc, 6)
      )
    );
    const paragraph = fixture.view.dom.querySelector("p");
    const tail = paragraph?.lastChild;
    const native = fixture.view.dom.ownerDocument.getSelection();
    if (!(paragraph && tail && native)) {
      throw new Error("Editor fixture image/tail text selection missing");
    }
    native.setBaseAndExtent(paragraph, 1, tail, 1);

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBeInstanceOf(TextSelection);
    expect(fixture.view.state.selection.anchor).toBe(6);
    expect(fixture.view.state.selection.head).toBe(8);
  });

  it("keeps the first-image selection when native selection spans exactly the second image", () => {
    const fixture = createFixture();
    const doc = fixture.schema.node("doc", null, [
      fixture.schema.node("paragraph", null, [
        fixture.schema.text("Typed"),
        fixture.schema.node("image"),
        fixture.schema.node("image"),
      ]),
    ]);
    fixture.view.dispatch(
      fixture.view.state.tr.replaceWith(
        0,
        fixture.view.state.doc.content.size,
        doc.content
      )
    );
    fixture.view.dispatch(
      fixture.view.state.tr.setSelection(
        NodeSelection.create(fixture.view.state.doc, 6)
      )
    );
    const paragraph = fixture.view.dom.querySelector("p");
    const native = fixture.view.dom.ownerDocument.getSelection();
    if (!(paragraph && native)) {
      throw new Error("Editor fixture paragraph/native selection missing");
    }
    // Pins current behavior. Looks wrong: the native range is the second image
    // (7..8) but the model stays on the first (6), so a copy takes the image the
    // user did not select. canReplaceNodeSelection's `to - from ===
    // node.nodeSize` clause never checks that the atom is the model's node.
    native.setBaseAndExtent(paragraph, 2, paragraph, 3);
    const selection = fixture.view.state.selection;

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.posAtDOM(paragraph, 2)).toBe(7);
    expect(fixture.view.state.selection).toBe(selection);
    expect(fixture.view.state.selection.from).toBe(6);
  });

  it("retains an image selection when a native endpoint sits inside the image DOM", () => {
    const fixture = createImageFixture({
      nodeViews: {
        image: () => {
          const dom = globalThis.document.createElement("span");
          dom.textContent = "Image label";
          return { dom };
        },
      },
    });
    const label = fixture.view.dom.querySelector("span")?.firstChild;
    const text = fixture.view.dom.querySelector("p")?.firstChild;
    const native = fixture.view.dom.ownerDocument.getSelection();
    if (!(label && text && native)) {
      throw new Error("Editor fixture atom label/text selection missing");
    }
    // Pins current behavior. The domAtPos fallback in isNativeDocumentTextPoint
    // also rejects this endpoint (no node inside a leaf atom DOM contains the
    // paragraph-level DOM position), so this does not isolate isNativeAtomPoint.
    native.setBaseAndExtent(label, 0, text, 0);
    const selection = fixture.view.state.selection;

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(fixture.view.state.selection).toBe(selection);
    expect(fixture.view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("defers when no native selection exists", () => {
    const fixture = createFixture();
    globalThis.document.getSelection()?.removeAllRanges();

    synchronizeEditorDomSelection(fixture.view, shortcut());

    expect(selectedText(fixture)).toBe("Type");
  });
});

function createFixture(props: Partial<EditorProps> = {}) {
  const fixture = createEditorSelectionFixture(props);
  fixtures.push(fixture);
  return fixture;
}

function selectedText(
  fixture: ReturnType<typeof createEditorSelectionFixture>
): string {
  const { doc, selection } = fixture.view.state;
  return doc.textBetween(selection.from, selection.to);
}

function shortcut(key = "b"): KeyboardEvent {
  return new globalThis.KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
}

function createImageFixture(props: Partial<EditorProps> = {}) {
  const fixture = createFixture(props);
  const doc = fixture.schema.node("doc", null, [
    fixture.schema.node("paragraph", null, [
      fixture.schema.text("Typed"),
      fixture.schema.node("image"),
    ]),
  ]);
  fixture.view.dispatch(
    fixture.view.state.tr.replaceWith(
      0,
      fixture.view.state.doc.content.size,
      doc.content
    )
  );
  fixture.view.dispatch(
    fixture.view.state.tr.setSelection(
      NodeSelection.create(fixture.view.state.doc, 6)
    )
  );
  return fixture;
}
