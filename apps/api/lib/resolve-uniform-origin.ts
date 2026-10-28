/** Return the one value every row left, or omit an origin when rows disagree. */
export function resolveUniformOrigin<T>(origins: readonly T[]): T | undefined {
  const first = origins[0];
  if (first === undefined) {
    return;
  }
  return origins.every((origin) => origin === first) ? first : undefined;
}
