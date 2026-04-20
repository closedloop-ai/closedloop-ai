"use client";

import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useUpdateDocument } from "@/hooks/queries/use-documents";
import { useInlineEdit } from "@/hooks/use-inline-edit";

type EditableFeatureTitleProps = {
  documentId: string;
  initialTitle: string;
  onTitleChange?: (newTitle: string) => void;
};

export function EditableFeatureTitle({
  documentId,
  initialTitle,
  onTitleChange,
}: Readonly<EditableFeatureTitleProps>) {
  const updateDocument = useUpdateDocument();

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
      updateDocument.mutateAsync({
        id: documentId,
        title: normalizeFeatureTitle(title),
      }),
    onChange: onTitleChange,
    emptyErrorMessage: "Feature title cannot be empty",
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
      className="min-h-0 resize-none overflow-hidden rounded-none border-none bg-transparent px-0 py-0 font-semibold text-2xl tracking-[-0.6px] shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
      disabled={isPending}
      onBlur={handleSave}
      onChange={(e) => setInputValue(normalizeFeatureTitle(e.target.value))}
      onKeyDown={handleKeyDown}
      placeholder="Untitled feature"
      ref={inputRef}
      rows={1}
      value={inputValue}
    />
  );
}

function normalizeFeatureTitle(value: string) {
  return value.replaceAll(/\s*[\r\n]+\s*/g, " ");
}
