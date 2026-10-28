"use client";

import { InlineEditErrorMessage } from "@repo/app/shared/components/inline-edit-error-message";
import {
  InlineEditSubject,
  inlineEditEmptyValueMessage,
} from "@repo/app/shared/lib/inline-edit-empty-value-message";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
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
    error,
    errorMessageId,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLInputElement>({
    scopeKey: projectId,
    initialValue: initialTitle,
    onSave: (trimmedValue, expectedName, recoverableErrorOwner) =>
      updateProject.mutateAsync({
        id: projectId,
        name: trimmedValue,
        expectedName,
        ...(recoverableErrorOwner ? { recoverableErrorOwner } : {}),
      }),
    onChange: onTitleChange,
    emptyErrorMessage: inlineEditEmptyValueMessage(
      InlineEditSubject.ProjectTitle
    ),
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
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
    <div>
      <Input
        aria-describedby={error ? errorMessageId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label="Project title"
        className="h-auto rounded-none border-none bg-transparent px-0 py-0 font-semibold text-2xl shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
        disabled={isPending}
        onBlur={(event) => handleSave(event.relatedTarget)}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Untitled project"
        ref={inputRef}
        value={inputValue}
      />
      <InlineEditErrorMessage error={error} id={errorMessageId} />
    </div>
  );
}
