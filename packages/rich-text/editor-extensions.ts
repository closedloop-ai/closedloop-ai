import { createDocumentExtensions } from "@repo/document-schema/extensions";
import type { AnyExtension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { InlineImageExtension } from "./inline-image-extension";
import { InlineImageUploadPlaceholderExtension } from "./inline-image-upload-placeholder";
import { MermaidExtension } from "./mermaid-extension";

type EditorExtensionsOptions = {
  placeholder?: string;
  liveblocksExtension?: AnyExtension;
};

/**
 * The editor's extensions: the shared document schema with the editor's node
 * views, plus the editor-only extensions. Liveblocks owns undo/redo through Yjs
 * when its extension is present.
 */
export function createEditorExtensions({
  placeholder,
  liveblocksExtension,
}: EditorExtensionsOptions) {
  return [
    ...createDocumentExtensions({
      mermaidNode: MermaidExtension,
      inlineImageNode: InlineImageExtension,
      undoRedo: !liveblocksExtension,
    }),
    Placeholder.configure({
      placeholder,
      // Keep the placeholder visible even when the editor is read-only so
      // empty documents in the read-only-by-default shell still show a
      // clickable "Add description" affordance.
      showOnlyWhenEditable: false,
    }),
    InlineImageUploadPlaceholderExtension,
    ...(liveblocksExtension ? [liveblocksExtension] : []),
  ];
}
