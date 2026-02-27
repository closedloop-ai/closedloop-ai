"use client";

import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useInlineEdit } from "@/hooks/use-inline-edit";

type EditableProjectDescriptionProps = {
  projectId: string;
  initialDescription: string;
  onDescriptionChange?: (newDescription: string) => void;
};

export function EditableProjectDescription({
  projectId,
  initialDescription,
  onDescriptionChange,
}: EditableProjectDescriptionProps) {
  const {
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLTextAreaElement>({
    projectId,
    initialValue: initialDescription,
    buildPayload: (trimmedValue) => ({
      description: trimmedValue || undefined,
    }),
    onChange: onDescriptionChange,
    allowEmpty: true,
    saveErrorMessage: "Failed to update project description. Please try again.",
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to save (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
    // Shift+Enter allows newlines (default textarea behavior)
  };

  return (
    <Textarea
      className="min-h-0 w-full resize-none rounded-none border-none bg-transparent px-0 py-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
      disabled={isPending}
      onBlur={handleSave}
      onChange={(e) => setInputValue(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder="Add a description for this project..."
      ref={inputRef}
      rows={1}
      value={inputValue}
    />
  );
}
