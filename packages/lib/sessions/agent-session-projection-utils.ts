import type { TurnItem } from "@repo/api/src/types/agent-session";

/**
 * Pure value / text / duration primitives shared across the Agent Session detail
 * projection (`agent-session-detail-projection.ts`). Extracted so the projection
 * module stays a single-responsibility timeline+turn builder rather than also
 * carrying every low-level coercion helper. All leaves here are framework-free
 * and dependency-free (no back-reference into the projection), so they keep
 * `@repo/lib`'s pure-leaf guarantee on every surface.
 */

export function firstNonNull(
  ...values: Array<string | null | undefined>
): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null;
}

export function getTurnItemTime(item: TurnItem): number {
  if ("tMs" in item) {
    return item.tMs;
  }
  return 0;
}

export function getTurnItemRow(item: TurnItem): number {
  if ("_row" in item) {
    return item._row;
  }
  return 0;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function argumentText(value: unknown): string | null {
  const text = stringValue(value);
  if (text) {
    return text;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((item) =>
      typeof item === "string" || typeof item === "number" ? String(item) : ""
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Render an arbitrary tool input/output value as human-readable text for the
 * expanded panel. Strings pass through; objects/arrays are pretty-printed JSON.
 * Empty/whitespace results collapse to null so the caller omits the field.
 */
export function jsonToDisplayText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text && text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function clipText(
  value: string,
  max: number
): { text: string; truncated: boolean } {
  if (value.length <= max) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, max), truncated: true };
}

export function formatDurationMs(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Reconstruct a `command args` string from a tool event's `data`/`tool_input`,
 * tolerating both the snake- and camel-case field spellings different producers
 * emit. Returns null when neither a command nor args is present.
 */
export function commandDetail(
  data: Record<string, unknown>,
  toolInput: Record<string, unknown> | null
): string | null {
  const command = stringValue(
    data.command ??
      data.cmd ??
      data.executable ??
      toolInput?.command ??
      toolInput?.cmd ??
      toolInput?.executable
  );
  const args = argumentText(
    data.args ?? data.arguments ?? toolInput?.args ?? toolInput?.arguments
  );
  if (command && args && !command.includes(args)) {
    return `${command} ${args}`;
  }
  return command ?? args;
}

/**
 * A short status string for a tool call: an explicit `status`, else a derived
 * `exit N` line from a numeric exit code. Undefined when neither is present.
 */
export function statusDetail(
  data: Record<string, unknown>,
  toolResponse: Record<string, unknown> | null
): string | undefined {
  const status = stringValue(data.status ?? toolResponse?.status);
  if (status) {
    return status;
  }
  const exitCode =
    data.exitCode ??
    data.exit_code ??
    toolResponse?.exitCode ??
    toolResponse?.exit_code;
  if (!(typeof exitCode === "number" && Number.isFinite(exitCode))) {
    return undefined;
  }
  return `exit ${Math.trunc(exitCode)}`;
}

/**
 * A human-readable duration string for a tool call derived from an explicit
 * `durationMs`/`duration_ms` field. Undefined when no positive duration is set.
 */
export function durationDetail(
  data: Record<string, unknown>,
  toolResponse: Record<string, unknown> | null
): string | undefined {
  const durationMs = numberValue(
    data.durationMs ?? data.duration_ms ?? toolResponse?.durationMs
  );
  return durationMs ? formatDurationMs(durationMs) : undefined;
}
