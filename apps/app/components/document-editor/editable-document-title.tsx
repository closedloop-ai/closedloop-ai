"use client";

import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useUpdateDocument } from "@/hooks/queries/use-documents";
import { useInlineEdit } from "@/hooks/use-inline-edit";
import { normalizeTitle } from "@/lib/ui-utils";

type EditableDocumentTitleProps = {
  documentId: string;
  initialTitle: string;
};

export function EditableDocumentTitle({
  documentId,
  initialTitle,
}: EditableDocumentTitleProps) {
  const updateArtifact = useUpdateDocument();

  const {
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLTextAreaElement>({
    initialValue: initialTitle,
    onSave: (title) =>
      updateArtifact.mutateAsync({
        id: documentId,
        title: normalizeTitle(title),
      }),
    emptyErrorMessage: "Title cannot be empty",
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <Textarea
      className="min-h-0 resize-none overflow-hidden rounded-none border-none bg-transparent px-0 py-0 font-semibold text-3xl tracking-[-0.6px] shadow-none focus-visible:ring-0 md:text-3xl dark:bg-transparent"
      disabled={isPending}
      onBlur={handleSave}
      onChange={(e) => setInputValue(normalizeTitle(e.target.value))}
      onKeyDown={handleKeyDown}
      placeholder="Untitled document"
      ref={inputRef}
      rows={1}
      value={inputValue}
    />
  );
}
