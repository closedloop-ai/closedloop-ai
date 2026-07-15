import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { TiptapEditor } from "./types";

/**
 * Shared plugin key for the inline-image upload placeholder decorations. The
 * editor dispatches `add`/`remove` actions through this key and reads the
 * decoration set back from it to locate placeholders.
 */
export const inlineImageUploadPlaceholderKey = new PluginKey<DecorationSet>(
  "inlineImageUploadPlaceholder"
);

/**
 * Meta action carried on a transaction to mutate the placeholder decoration
 * set: add a widget at `pos`, or remove the widget previously added under `id`.
 */
type InlineImageUploadPlaceholderAction =
  | { type: "add"; id: string; pos: number; label: string }
  | { type: "remove"; id: string };

/**
 * Build the ProseMirror plugin that tracks inline-image upload placeholders as
 * a decoration set. Kept as a standalone factory so the add/remove state
 * transitions can be exercised against a plain ProseMirror schema in tests
 * without instantiating the full editor.
 *
 * @internal
 */
export function createInlineImageUploadPlaceholderPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: inlineImageUploadPlaceholderKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, decorations) {
        let nextDecorations = decorations.map(
          transaction.mapping,
          transaction.doc
        );
        const action = transaction.getMeta(inlineImageUploadPlaceholderKey) as
          | InlineImageUploadPlaceholderAction
          | undefined;

        if (action?.type === "add") {
          const element = document.createElement("span");
          element.className = "inline-image-upload-placeholder";
          element.dataset.inlineImageUploadId = action.id;
          element.textContent = action.label;
          nextDecorations = nextDecorations.add(transaction.doc, [
            Decoration.widget(action.pos, element, { id: action.id }),
          ]);
        }

        if (action?.type === "remove") {
          nextDecorations = nextDecorations.remove(
            nextDecorations.find(
              undefined,
              undefined,
              (spec) => spec.id === action.id
            )
          );
        }

        return nextDecorations;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

/**
 * Tiptap extension wrapper that registers the placeholder decoration plugin.
 */
export const InlineImageUploadPlaceholderExtension = Extension.create({
  name: "inlineImageUploadPlaceholder",

  addProseMirrorPlugins() {
    return [createInlineImageUploadPlaceholderPlugin()];
  },
});

/**
 * Resolve the document position of the placeholder widget added under
 * `uploadId`, or `null` when no such placeholder is present.
 */
export function findInlineImagePlaceholderPosition(
  editor: TiptapEditor,
  uploadId: string
): number | null {
  const decorations = inlineImageUploadPlaceholderKey.getState(editor.state);
  const placeholder = decorations
    ?.find(undefined, undefined, (spec) => spec.id === uploadId)
    .at(0);
  return placeholder?.from ?? null;
}
