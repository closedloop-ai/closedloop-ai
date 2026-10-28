"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import { InlineEditErrorMessage } from "@repo/app/shared/components/inline-edit-error-message";
import { useInlineEdit } from "@repo/app/shared/hooks/use-inline-edit";
import {
  InlineEditSubject,
  inlineEditEmptyValueMessage,
} from "@repo/app/shared/lib/inline-edit-empty-value-message";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { normalizeTitle } from "@repo/app/shared/lib/ui-utils";
import { Textarea } from "@repo/design-system/components/ui/textarea";

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
    error,
    errorMessageId,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLTextAreaElement>({
    scopeKey: documentId,
    initialValue: initialTitle,
    onSave: (title, expectedTitle, recoverableErrorOwner) =>
      updateArtifact.mutateAsync({
        id: documentId,
        title: normalizeTitle(title),
        expectedTitle,
        surface: ArtifactStatusEditSurface.Detail,
        ...(recoverableErrorOwner ? { recoverableErrorOwner } : {}),
      }),
    emptyErrorMessage: inlineEditEmptyValueMessage(
      InlineEditSubject.DocumentTitle
    ),
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
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
    <div>
      <Textarea
        aria-describedby={error ? errorMessageId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label="Document title"
        className="min-h-0 resize-none overflow-hidden rounded-none border-none bg-transparent px-0 py-0 font-semibold text-3xl tracking-[-0.6px] shadow-none focus-visible:ring-0 md:text-3xl dark:bg-transparent"
        disabled={isPending}
        onBlur={(event) => handleSave(event.relatedTarget)}
        onChange={(e) => setInputValue(normalizeTitle(e.target.value))}
        onKeyDown={handleKeyDown}
        placeholder="Untitled document"
        ref={inputRef}
        rows={1}
        value={inputValue}
      />
      <InlineEditErrorMessage error={error} id={errorMessageId} />
    </div>
  );
}
