import type { CustomFieldReferenceTarget } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  resolvesDisplayValueOnRead,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { orderRowsByIdFrom } from "@/lib/order-rows-by";

/**
 * How a custom field value's display string is DERIVED, for both the write that
 * caches it and the read that renders it.
 *
 * Deliberately free of any `@repo/database` import, and it must stay that way:
 * `value-projections.ts` and `utils.ts` are imported by a wide set of suites
 * that mock `@repo/database` with `withDb` alone, and a module that eagerly
 * dereferences a generated Prisma enum dies at COLLECTION with an error naming
 * none of the files involved. `display-value-import-contract.test.ts` loads this
 * module with no mock at all, which is only a meaningful guard while it has
 * nothing to mock.
 */

/**
 * Separator for the display strings derived HERE — the people join and the
 * reference join. Deliberately NOT shared with `MULTI_ENUM_DISPLAY_SEPARATOR`
 * (utils.ts) despite the identical value: that one is interpolated into the
 * rename SQL in `enum-options-service`, so converging them would couple PEOPLE
 * and REFERENCE rendering to a MULTI_ENUM storage contract.
 */
export const MULTI_VALUE_DISPLAY_SEPARATOR = ", ";

/**
 * A user's name as "First L.".
 *
 * NOT the canonical backend name derivation — that is `formatUserFullName` in
 * `lib/user-display-name.ts` (FEA-3506), which renders the full name and is what
 * the PEOPLE cell shows through the renderer's own `getUserDisplayName`. The
 * abbreviation is kept because it is the string `custom_field_values.display_value`
 * and the Sessions band header already carry; switching them to the full name
 * would be a user-visible copy change, which ISS-7215 is not (the band-vs-cell
 * format split predates it).
 *
 * A person with neither name part renders as "" so the caller can drop them
 * rather than emit a stray separator.
 */
export function formatPersonName(person: {
  firstName: string | null;
  lastName: string | null;
}): string {
  const first = person.firstName?.trim() ?? "";
  const lastInitial = person.lastName?.[0] ?? "";
  if (!first) {
    return lastInitial ? `${lastInitial}.` : "";
  }
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

/**
 * The display string for a PEOPLE value's already-ordered users.
 *
 * Takes the ordered list rather than ids so the caller owns the order: both the
 * write (which caches this into the sort key) and the read (which renders it)
 * order through `orderRowsByIdFrom` against the same stored `peopleValueIds`, so the
 * two cannot disagree about sequence, about a dropped nameless person, or about
 * a repeated id.
 */
export function formatPeopleDisplayValue(people: BasicUser[]): string {
  return people
    .map(formatPersonName)
    .filter(Boolean)
    .join(MULTI_VALUE_DISPLAY_SEPARATOR);
}

/**
 * The display string for a set of resolved reference targets.
 *
 * Prefers the slug because that is the stable handle a reader recognizes; falls
 * back to the name for artifacts without one.
 */
export function formatReferenceDisplayValue(
  targets: CustomFieldReferenceTarget[]
): string {
  return targets
    .map((target) => target.slug ?? target.name)
    .join(MULTI_VALUE_DISPLAY_SEPARATOR);
}

/** The live rows a `ResolvedOnRead` type derives its display string from. */
type DisplayValueContext = {
  referenceValues: CustomFieldReferenceTarget[];
  peopleValues: BasicUser[];
};

type DisplayValueResolver = (context: DisplayValueContext) => string;

/**
 * Which live rows each field type derives its display string from, or `null`
 * when the stored column is authoritative.
 *
 * Exhaustive over `CustomFieldType`, and a Record rather than a branch on
 * {@link resolvesDisplayValueOnRead}, because that boolean answers WHETHER a
 * type resolves on read and not WHICH shape it resolves from. Two distinct SHAPES now
 * exist across the three ResolvedOnRead types (ISS-7215 added PEOPLE beside
 * the two reference types), so a two-way branch would hand a
 * PEOPLE row to the reference formatter — whose `referenceValues` is always
 * empty for it — and blank every PEOPLE value permanently, which is worse than
 * the staleness this ticket fixes. The `null` entries are unreachable behind
 * the guard in {@link resolveDisplayValue}; they exist so a new field type
 * fails `tsc` here until someone chooses, the same way
 * `SORT_SOURCE_BY_FIELD_TYPE` carries nulls for the reference types.
 */
const DISPLAY_VALUE_RESOLVER: Record<
  CustomFieldType,
  DisplayValueResolver | null
> = {
  [CustomFieldType.Text]: null,
  [CustomFieldType.Number]: null,
  [CustomFieldType.Enum]: null,
  [CustomFieldType.MultiEnum]: null,
  [CustomFieldType.Date]: null,
  [CustomFieldType.People]: (context) =>
    formatPeopleDisplayValue(context.peopleValues),
  [CustomFieldType.Reference]: (context) =>
    formatReferenceDisplayValue(context.referenceValues),
  [CustomFieldType.ReferenceMulti]: (context) =>
    formatReferenceDisplayValue(context.referenceValues),
};

/**
 * Applies the `DISPLAY_VALUE_STRATEGY` rule on the read side. The only place a
 * read decides whether the stored column or the live rows win.
 *
 * For a `ResolvedOnRead` type the stored column is ignored entirely — for
 * PEOPLE it still HOLDS a string, because it remains the sort key, so ignoring
 * it here is what actually fixes the staleness rather than merely hiding it.
 */
export function resolveDisplayValue(
  fieldType: CustomFieldType,
  storedDisplayValue: string | null,
  referenceValues: CustomFieldReferenceTarget[],
  peopleValues: BasicUser[]
): string | null {
  if (!resolvesDisplayValueOnRead(fieldType)) {
    return storedDisplayValue ?? null;
  }
  return (
    DISPLAY_VALUE_RESOLVER[fieldType]?.({ referenceValues, peopleValues }) ??
    null
  );
}

/**
 * The cached PEOPLE sort key for a stored id list — ordered by the stored ids,
 * formatted by {@link formatPeopleDisplayValue}.
 *
 * The one place order and format are tied together for the WRITTEN column, so
 * the write path (`computeDisplayValue`) and the rename refresh
 * (`refreshPeopleDisplayValuesForUser`) cannot derive the key two ways. The
 * read path renders through `orderRowsByIdFrom` + `formatPeopleDisplayValue`
 * too, and `people-display-parity.test.ts` pins the three against each other.
 */
export function formatPeopleSortKey(
  ids: string[],
  byId: ReadonlyMap<string, BasicUser>
): string {
  return formatPeopleDisplayValue(orderRowsByIdFrom(byId, ids));
}
