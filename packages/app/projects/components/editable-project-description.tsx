"use client";

import { Textarea } from "@repo/design-system/components/ui/textarea";
import { InlineEditErrorMessage } from "../../shared/components/inline-edit-error-message";
import { useInlineEdit } from "../../shared/hooks/use-inline-edit";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "../../shared/lib/inline-edit-save-error";
import { useUpdateProject } from "../hooks/use-projects";

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
  const updateProject = useUpdateProject();

  const {
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    error,
    errorMessageId,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLTextAreaElement>({
    scopeKey: projectId,
    initialValue: initialDescription,
    // Clearing writes `""`: sending nothing while the field shows empty would
    // leave every later guarded save expecting a value the server never held.
    onSave: (description, expectedDescription, recoverableErrorOwner) =>
      updateProject.mutateAsync({
        id: projectId,
        description,
        expectedDescription,
        ...(recoverableErrorOwner ? { recoverableErrorOwner } : {}),
      }),
    onChange: onDescriptionChange,
    allowEmpty: true,
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
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
    <div>
      <Textarea
        aria-describedby={error ? errorMessageId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label="Project description"
        className="min-h-0 w-full resize-none rounded-none border-none bg-transparent px-0 py-0 text-lg shadow-none focus-visible:ring-0 dark:bg-transparent"
        disabled={isPending}
        onBlur={(event) => handleSave(event.relatedTarget)}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a description for this project..."
        ref={inputRef}
        rows={1}
        value={inputValue}
      />
      <InlineEditErrorMessage error={error} id={errorMessageId} />
    </div>
  );
}
