import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import type { CustomFieldValueRejection } from "@repo/lib/custom-fields/custom-field-editor";
import { CustomFieldValueRejection as Rejection } from "@repo/lib/custom-fields/custom-field-editor";
import { INVALID_DATE_MESSAGE } from "../components/constants";
import { durationValidationMessage } from "./duration-field";

/**
 * ISS-9590 — the one place a refused custom-field draft becomes words.
 *
 * Before this, each editor answered the question itself: the grid cell held
 * `"Enter a valid date"` as a literal while importing
 * {@link INLINE_SCALAR_NUMBER_INVALID_MESSAGE} for the sibling case, and the
 * duration editors reached a third function. Three copies of "how do we say
 * no" is how two surfaces come to refuse the same draft in different words.
 *
 * Exhaustive over `CustomFieldValueRejection`, which is the guard that matters:
 * a new rejection reason cannot compile until a human has decided what it says.
 * Every entry below resolves to an already-approved string — nothing here was
 * composed to fill the table, and nothing may be.
 *
 * Every entry is a function of the draft because one of them needs it: an
 * unparseable span quotes what the user typed. Do not collapse the other two
 * into bare strings; a mixed table makes the call site re-derive which shape it
 * is holding.
 */
const CUSTOM_FIELD_VALUE_REJECTION_MESSAGE: Record<
  CustomFieldValueRejection,
  (draft: string) => string
> = {
  [Rejection.InvalidNumber]: () => INLINE_SCALAR_NUMBER_INVALID_MESSAGE,
  [Rejection.InvalidDate]: () => INVALID_DATE_MESSAGE,
  [Rejection.InvalidDuration]: (draft) =>
    durationValidationMessage(draft.trim()),
};

/** What an editor tells the user about a draft it refused. */
export function customFieldValueRejectionMessage(
  reason: CustomFieldValueRejection,
  draft: string
): string {
  return CUSTOM_FIELD_VALUE_REJECTION_MESSAGE[reason](draft);
}
