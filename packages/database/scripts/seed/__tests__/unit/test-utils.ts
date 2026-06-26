export function getLineNumber(content: string, matchIndex: number): number {
  const lines = content.split("\n");
  let charCount = 0;
  let lineNumber = 1;
  for (const line of lines) {
    if (charCount + line.length >= matchIndex) {
      break;
    }
    charCount += line.length + 1;
    lineNumber++;
  }
  return lineNumber;
}

export function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
