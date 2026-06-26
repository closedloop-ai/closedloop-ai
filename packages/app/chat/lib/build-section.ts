export function buildSection(
  title: string,
  lines: readonly string[]
): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", `## ${title}`, ...lines];
}
