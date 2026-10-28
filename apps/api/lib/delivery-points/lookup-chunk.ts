/**
 * The one place the delivery-point reads apply their `IN`-list bound (ISS-8399).
 *
 * Every id-keyed read in this directory chunks on the same number rather than
 * each picking its own, so a batch's statement count is predictable and one
 * module cannot quietly widen a statement past what the others assume.
 */

/** Ids per `IN` list, bounding one statement's size. */
export const LOOKUP_CHUNK = 200;

/** Slice a list into {@link LOOKUP_CHUNK}-wide chunks. */
export function* chunked<T>(values: readonly T[]): Generator<T[]> {
  for (let index = 0; index < values.length; index += LOOKUP_CHUNK) {
    yield values.slice(index, index + LOOKUP_CHUNK);
  }
}
