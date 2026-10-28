import { toggleMark } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { type EditorProps, EditorView } from "@tiptap/pm/view";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    blockAtom: { group: "block", atom: true, toDOM: () => ["hr"] },
    image: { inline: true, group: "inline", atom: true, toDOM: () => ["img"] },
  },
  marks: {
    bold: { toDOM: () => ["strong", 0] },
    italic: { toDOM: () => ["em", 0] },
    underline: { toDOM: () => ["u", 0] },
  },
});

/** Real ProseMirror view with independently controllable native and model selection. */
export function createEditorSelectionFixture(props: Partial<EditorProps> = {}) {
  const host = globalThis.document.createElement("div");
  globalThis.document.body.append(host);
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, schema.text("Typed into the editor.")),
  ]);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 5),
      plugins: [
        keymap({
          "Mod-b": toggleMark(schema.marks.bold),
          "Mod-i": toggleMark(schema.marks.italic),
          "Mod-u": toggleMark(schema.marks.underline),
        }),
      ],
    }),
    handleScrollToSelection: () => true,
    ...props,
  });
  view.focus();
  return {
    view,
    schema,
    selectNative(anchor: number, head: number) {
      const text = view.dom.querySelector("p")?.firstChild;
      const native = view.dom.ownerDocument.getSelection();
      if (!(text && native)) {
        throw new Error("Editor fixture text/native selection missing");
      }
      native.setBaseAndExtent(text, anchor, text, head);
    },
    destroy() {
      view.destroy();
      host.remove();
      globalThis.document.getSelection()?.removeAllRanges();
    },
  };
}
