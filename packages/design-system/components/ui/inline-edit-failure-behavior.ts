/**
 * Persistence-refusal policy for inline editors.
 *
 * Retaining a rejected draft is an explicit opt-in because it must never leave
 * an invalid draft without adjacent explanatory copy. Callers that omit the
 * policy retain the compatibility behavior: the editor restores the latest
 * confirmed value after a refusal.
 */
export type InlineEditFailureBehavior =
  | Readonly<{
      retainRejectedDraft: true;
      saveErrorMessage: string;
    }>
  | Readonly<{
      retainRejectedDraft?: false;
      saveErrorMessage?: never;
    }>;

/** Programmer diagnostic for a retained policy that would render no copy. */
export const BLANK_INLINE_EDIT_SAVE_ERROR_MESSAGE =
  "Inline edit retained-failure mode needs a non-blank `saveErrorMessage`.";

/** Refuses the runtime blank that `string` cannot exclude from the public type. */
export function assertInlineEditFailureBehavior(
  retainRejectedDraft: boolean | undefined,
  saveErrorMessage: string | undefined
): void {
  if (retainRejectedDraft && (saveErrorMessage ?? "").trim().length === 0) {
    throw new Error(BLANK_INLINE_EDIT_SAVE_ERROR_MESSAGE);
  }
}
