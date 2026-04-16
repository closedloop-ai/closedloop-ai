"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { useUpdateDocument } from "@/hooks/queries/use-documents";
import { useInlineEdit } from "@/hooks/use-inline-edit";

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
  } = useInlineEdit<HTMLInputElement>({
    initialValue: initialTitle,
    onSave: (title) => updateArtifact.mutateAsync({ id: documentId, title }),
    emptyErrorMessage: "Title cannot be empty",
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <Input
      className="h-auto rounded-none border-none bg-transparent px-0 py-0 font-semibold text-3xl tracking-[-0.6px] shadow-none focus-visible:ring-0 md:text-3xl dark:bg-transparent"
      disabled={isPending}
      onBlur={handleSave}
      onChange={(e) => setInputValue(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder="Untitled document"
      ref={inputRef}
      value={inputValue}
    />
  );
}
