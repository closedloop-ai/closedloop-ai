import type { RichTextEditorProps, TiptapEditor } from "./types";

export type InlineImageUploadPlaceholder = {
  id: string;
  pos: number;
  label: string;
};

/**
 * Return only image files from paste/drop payloads so editor event handlers can
 * share the same boundary behavior without importing the full editor runtime.
 *
 * @internal
 */
export function getInlineImageFilesFromTransfer(files: Iterable<File>): File[] {
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

/**
 * Run the inline-image upload lifecycle: validate, add an upload placeholder,
 * upload via the injected app callback, replace the placeholder with a durable
 * attachment ref, and clean up on failure.
 *
 * @internal
 */
export async function insertInlineImageFileForEditor({
  editor,
  file,
  inlineImagesEnabled,
  uploadInlineImage,
  validateInlineImageFile,
  onInlineImageUploadError,
  addInlineImagePlaceholder,
  removeInlineImagePlaceholder,
  findPlaceholderPosition,
  createUploadId = () => globalThis.crypto.randomUUID(),
}: {
  editor: TiptapEditor | null;
  file: File;
  inlineImagesEnabled: boolean;
  uploadInlineImage?: RichTextEditorProps["uploadInlineImage"];
  validateInlineImageFile?: RichTextEditorProps["validateInlineImageFile"];
  onInlineImageUploadError?: RichTextEditorProps["onInlineImageUploadError"];
  addInlineImagePlaceholder: (
    placeholder: InlineImageUploadPlaceholder
  ) => void;
  removeInlineImagePlaceholder: (uploadId: string) => void;
  findPlaceholderPosition: (
    editor: TiptapEditor,
    uploadId: string
  ) => number | null;
  createUploadId?: () => string;
}): Promise<void> {
  if (!(editor && inlineImagesEnabled && uploadInlineImage)) {
    return;
  }
  const validationError = validateInlineImageFile?.(file);
  if (validationError) {
    onInlineImageUploadError?.(validationError);
    return;
  }

  const uploadId = createUploadId();
  const insertionPos = editor.state.selection.from;
  editor.commands.focus();
  addInlineImagePlaceholder({
    id: uploadId,
    pos: insertionPos,
    label: `Uploading ${file.name}`,
  });

  try {
    const result = await uploadInlineImage(file);
    const position = findPlaceholderPosition(editor, uploadId);
    removeInlineImagePlaceholder(uploadId);
    if (position !== null) {
      editor
        .chain()
        .focus()
        .insertContentAt(position, {
          type: "inlineImage",
          attrs: {
            alt: result.alt ?? file.name,
            src: result.src,
          },
        })
        .run();
    }
  } catch (error) {
    removeInlineImagePlaceholder(uploadId);
    onInlineImageUploadError?.(
      error instanceof Error ? error.message : "Image upload failed"
    );
  }
}
