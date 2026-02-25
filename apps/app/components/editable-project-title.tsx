"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { useInlineEdit } from "@/hooks/use-inline-edit";

type EditableProjectTitleProps = {
  projectId: string;
  initialTitle: string;
  onTitleChange?: (newTitle: string) => void;
};

export function EditableProjectTitle({
  projectId,
  initialTitle,
  onTitleChange,
}: EditableProjectTitleProps) {
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
  } = useInlineEdit<HTMLInputElement>({
    projectId,
    initialValue: initialTitle,
    buildPayload: (trimmedValue) => ({ name: trimmedValue }),
    onChange: onTitleChange,
    emptyErrorMessage: "Project title cannot be empty",
    saveErrorMessage: "Failed to update project title. Please try again.",
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

  if (isEditing) {
    return (
      <Input
        className="h-auto border-none px-0 py-0 font-semibold text-2xl shadow-none focus-visible:ring-0"
        disabled={isPending}
        onBlur={handleSave}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        ref={inputRef}
        value={inputValue}
      />
    );
  }

  return (
    <button
      className="cursor-pointer font-semibold text-2xl transition-colors hover:text-muted-foreground"
      onClick={startEditing}
      title="Click to edit project title"
      type="button"
    >
      {value}
    </button>
  );
}
