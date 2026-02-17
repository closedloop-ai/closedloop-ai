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
    isEditing,
    value,
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    handleSave,
    handleCancel,
    startEditing,
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

  if (isEditing) {
    return (
      <Textarea
        className="min-h-16 w-full resize-none border-none px-0 py-0 text-sm shadow-none focus-visible:ring-0"
        disabled={isPending}
        onBlur={handleSave}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a description for this project..."
        ref={inputRef}
        rows={3}
        value={inputValue}
      />
    );
  }

  return (
    <button
      className="w-full cursor-pointer whitespace-pre-wrap text-left text-sm transition-colors hover:text-muted-foreground"
      onClick={startEditing}
      title="Click to edit project description"
      type="button"
    >
      {value || (
        <span className="text-muted-foreground">
          Add a description for this project...
        </span>
      )}
    </button>
  );
}
