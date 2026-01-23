"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useEffect, useRef, useState } from "react";
import { updateProject } from "@/app/actions/projects";

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
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [inputValue, setInputValue] = useState(initialTitle);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync with prop changes (e.g., from server updates)
  useEffect(() => {
    setTitle(initialTitle);
    setInputValue(initialTitle);
  }, [initialTitle]);

  // Focus and select text when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    const trimmedValue = inputValue.trim();

    // Validation: prevent empty titles
    if (!trimmedValue) {
      toast.error("Project title cannot be empty");
      setInputValue(title); // Reset to last valid value
      setIsEditing(false);
      return;
    }

    // No change, just exit edit mode
    if (trimmedValue === title) {
      setIsEditing(false);
      return;
    }

    // Capture original value BEFORE optimistic update
    const previousTitle = title;

    // Optimistic update
    setTitle(trimmedValue);
    setIsEditing(false);
    setIsPending(true);

    // Call server action
    const result = await updateProject({
      id: projectId,
      name: trimmedValue,
    });

    setIsPending(false);

    if (result.success) {
      // Notify parent if callback provided
      onTitleChange?.(trimmedValue);
    } else {
      // Revert on error using captured previous value
      setTitle(previousTitle);
      setInputValue(previousTitle);
      toast.error("Failed to update project title. Please try again.");
    }
  };

  const handleCancel = () => {
    setInputValue(title);
    setIsEditing(false);
  };

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
      onClick={() => setIsEditing(true)}
      title="Click to edit project title"
      type="button"
    >
      {title}
    </button>
  );
}
