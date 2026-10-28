import { type CountNoun, pluralize } from "@repo/design-system/lib/count-noun";

/** Existing Documents bulk-tag copy, shared by every Add Tag presentation. */
export const BULK_TAG_ACTION_ID = "bulk-tag";
export const BULK_TAG_ACTION_LABEL = "Add Tag";
export const BULK_REMOVE_TAG_ACTION_ID = "bulk-remove-tag";
/** DOC-36 R10's approved Remove Tag action, in Add Tag's existing casing. */
export const BULK_REMOVE_TAG_ACTION_LABEL = "Remove Tag";
export const BULK_TAG_EMPTY_LABEL = "No tags available";

/** Counts confirmed tag associations using the established bulk-tag wording. */
export function appliedTagMessage(
  tagName: string,
  count: number,
  noun: CountNoun = { one: "item", other: "items" }
): string {
  return `Applied "${tagName}" to ${count} ${pluralize(noun, count)}`;
}
