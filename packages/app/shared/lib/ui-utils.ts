export function normalizeTitle(value: string) {
  return value.replaceAll(/\s*[\r\n]+\s*/g, " ");
}
