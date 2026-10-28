import { InlineEditErrorMessage } from "@repo/app/shared/components/inline-edit-error-message";
import { useInlineEdit } from "@repo/app/shared/hooks/use-inline-edit";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";

/**
 * The shape both shipped title fields hand the hook, shared by every
 * `useInlineEdit` suite so they drive one subject. It mirrors
 * `EditableProjectTitle` and `EditableDocumentTitle` exactly on the point that
 * matters: Enter saves WITHOUT blurring, so the blur that follows is a second
 * pass over the same edit while the first mutation is still in flight.
 */
export function TitleField({
  initialTitle = "Plan",
  label = "Title",
  onChange,
  onSave,
  scopeKey = "entity-1",
}: Readonly<TitleFieldProps>) {
  const {
    error,
    errorMessageId,
    inputValue,
    setInputValue,
    inputRef,
    handleSave,
    handleCancel,
    value,
  } = useInlineEdit<HTMLInputElement>({
    scopeKey,
    initialValue: initialTitle,
    onChange,
    onSave,
    emptyErrorMessage: "Title cannot be empty",
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
  });

  return (
    <div>
      <input
        aria-describedby={error ? errorMessageId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={label}
        data-confirmed-value={value}
        onBlur={(event) => handleSave(event.relatedTarget)}
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleSave();
          } else if (event.key === "Escape") {
            event.preventDefault();
            handleCancel();
          }
        }}
        ref={inputRef}
        value={inputValue}
      />
      <InlineEditErrorMessage error={error} id={errorMessageId} />
    </div>
  );
}

type TitleFieldProps = {
  initialTitle?: string;
  label?: string;
  onChange?: (next: string) => void;
  onSave: (
    trimmedValue: string,
    expectedValue: string | undefined
  ) => Promise<unknown>;
  scopeKey?: string;
};
