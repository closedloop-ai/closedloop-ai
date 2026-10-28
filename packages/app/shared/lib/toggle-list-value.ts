/**
 * Add or remove one value from a multi-select selection, preserving order.
 *
 * The canonical owner: four cell editors and the facet-filter controller had
 * each declared their own byte-identical copy (tamsinb review), so a fix to one
 * would silently have left the others behind.
 */
export function toggleListValue(
  values: readonly string[],
  value: string
): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}
