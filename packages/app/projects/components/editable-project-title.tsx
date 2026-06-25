"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { useInlineEdit } from "../../shared/hooks/use-inline-edit";
import { useUpdateProject } from "../hooks/use-projects";

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
  const updateProject = useUpdateProject();

  const {
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLInputElement>({
    initialValue: initialTitle,
    onSave: (trimmedValue) =>
      updateProject.mutateAsync({ id: projectId, name: trimmedValue }),
    onChange: onTitleChange,
    emptyErrorMessage: "Project title cannot be empty",
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
      aria-label="Project title"
      className="h-auto rounded-none border-none bg-transparent px-0 py-0 font-semibold text-2xl shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
      disabled={isPending}
      onBlur={handleSave}
      onChange={(e) => setInputValue(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder="Untitled project"
      ref={inputRef}
      value={inputValue}
    />
  );
}
