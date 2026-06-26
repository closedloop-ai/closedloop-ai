export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function durationSeconds(startedAt: string, endedAt: string): number {
  const delta = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
  return Number.isFinite(delta) && delta >= 0 ? delta : 0;
}
