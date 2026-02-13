"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { useUpdateProject } from "@/hooks/queries/use-projects";

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
  const [isEditing, setIsEditing] = useState(false);
  const [description, setDescription] = useState(initialDescription);
  const [inputValue, setInputValue] = useState(initialDescription);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const updateProject = useUpdateProject();

  // Sync with prop changes (e.g., from server updates)
  useEffect(() => {
    setDescription(initialDescription);
    setInputValue(initialDescription);
  }, [initialDescription]);

  // Focus and select text when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmedValue = inputValue.trim();

    // No change, just exit edit mode
    if (trimmedValue === description) {
      setIsEditing(false);
      return;
    }

    // Capture original value BEFORE optimistic update
    const previousDescription = description;

    // Optimistic update
    setDescription(trimmedValue);
    setIsEditing(false);

    // Call mutation
    updateProject.mutate(
      {
        id: projectId,
        description: trimmedValue || undefined, // Send undefined for empty strings
      },
      {
        onSuccess: () => {
          // Notify parent if callback provided
          onDescriptionChange?.(trimmedValue);
        },
        onError: () => {
          // Revert on error using captured previous value
          setDescription(previousDescription);
          setInputValue(previousDescription);
          toast.error(
            "Failed to update project description. Please try again."
          );
        },
      }
    );
  };

  const handleCancel = () => {
    setInputValue(description);
    setIsEditing(false);
  };

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
        disabled={updateProject.isPending}
        onBlur={handleSave}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a description for this project..."
        ref={textareaRef}
        rows={3}
        value={inputValue}
      />
    );
  }

  return (
    <button
      className="w-full cursor-pointer whitespace-pre-wrap text-left text-sm transition-colors hover:text-muted-foreground"
      onClick={() => setIsEditing(true)}
      title="Click to edit project description"
      type="button"
    >
      {description || (
        <span className="text-muted-foreground">
          Add a description for this project...
        </span>
      )}
    </button>
  );
}
