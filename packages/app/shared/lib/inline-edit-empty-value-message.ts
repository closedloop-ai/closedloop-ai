/**
 * ISS-9590 — the one place an always-mounted field's empty-value refusal
 * becomes words.
 *
 * `useInlineEdit` (`packages/app/shared/hooks/use-inline-edit.ts`) refuses a
 * blank draft on any field that did not ask for `allowEmpty`, and it toasts
 * whatever `emptyErrorMessage` the call site handed it. Each call site was
 * writing its own: the document title shipped `"Title cannot be empty"` and the
 * project title `"Project title cannot be empty"`, two spellings of one rule
 * with nothing holding them to each other. That is the same defect
 * `value-rejection-message.ts` closed for a refused custom-field draft, one
 * hook over.
 *
 * Exhaustive over {@link InlineEditSubject}: a subject added to the vocabulary
 * cannot compile until a human has decided what its refusal says. That guard
 * reaches the subjects that opt IN and no further — `useInlineEdit` still takes
 * `emptyErrorMessage?: string`, so a fourth field can pass its own literal, or
 * none, and typecheck. Holding every call site to this map is review's, not
 * `tsc`'s.
 *
 * Both entries are the sentence that call site already shipped — nothing here
 * was composed, and nothing may be. They still say the rule two ways; making
 * them agree is a copy decision and a human's.
 *
 * `allowEmpty` fields are absent by construction. A field that permits a blank
 * value never reaches this refusal, so giving it an entry would put a sentence
 * behind a branch it cannot take.
 */

/** The always-mounted fields that refuse a blank draft. */
export const InlineEditSubject = {
  DocumentTitle: "document-title",
  ProjectTitle: "project-title",
} as const;
export type InlineEditSubject =
  (typeof InlineEditSubject)[keyof typeof InlineEditSubject];

const INLINE_EDIT_EMPTY_VALUE_MESSAGE: Readonly<
  Record<InlineEditSubject, string>
> = Object.freeze({
  [InlineEditSubject.DocumentTitle]: "Title cannot be empty",
  [InlineEditSubject.ProjectTitle]: "Project title cannot be empty",
});

/** What an always-mounted field tells the user about a blank draft it refused. */
export function inlineEditEmptyValueMessage(
  subject: InlineEditSubject
): string {
  return INLINE_EDIT_EMPTY_VALUE_MESSAGE[subject];
}
