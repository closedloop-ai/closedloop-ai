export function pickRequired<T>(
  values: readonly T[],
  index: number,
  label: string
): T {
  if (values.length === 0) {
    throw new Error(`${label}: expected at least one value`);
  }
  return values[index % values.length];
}
