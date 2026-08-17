import { z } from "zod";
import type { NormalizedToolUse } from "../types.js";
import { FIXTURE_OWNER_RE } from "./parser-utils.js";

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const MAX_NESTED_TEXT_DEPTH = 4;
const MAX_NESTED_TEXT_NODES = 200;
const MAX_NESTED_TEXT_VALUES = 100;
const MAX_NESTED_TEXT_LENGTH = 50_000;
const MAX_NESTED_TEXT_TOTAL_LENGTH = 250_000;
const recordSchema = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
);
const timestampSchema = z.iso.datetime();

/** Normalize a concrete source timestamp without any Session-time fallback. */
export function validMonitoredEventTimestamp(
  value: string | null
): string | null {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data).toISOString() : null;
}

/** Build a canonical owner/repository identity from bounded provider input. */
export function normalizedMonitoredRepository(
  owner: string | undefined,
  repository: string | undefined
): string | undefined {
  if (
    !(owner && repository) ||
    FIXTURE_OWNER_RE.test(owner) ||
    !OWNER_REPO_RE.test(`${owner}/${repository}`)
  ) {
    return undefined;
  }
  return `${owner}/${repository}`.toLowerCase();
}

/** Return whether normalized telemetry proves that a tool use completed. */
export function toolUseHasCompleted(toolUse: NormalizedToolUse): boolean {
  return toolUse.resultTimestamp != null || toolUse.output !== undefined;
}

/** Collect a bounded text projection from nested tool output. */
export function boundedNestedTextValues(value: unknown): string[] {
  const values: string[] = [];
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value },
  ];
  let visited = 0;
  let retainedTextLength = 0;
  while (
    pending.length > 0 &&
    visited < MAX_NESTED_TEXT_NODES &&
    values.length < MAX_NESTED_TEXT_VALUES
  ) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    visited += 1;
    if (shouldSkipNestedValue(current)) {
      continue;
    }
    if (typeof current.value === "string") {
      const remainingTextLength =
        MAX_NESTED_TEXT_TOTAL_LENGTH - retainedTextLength;
      if (remainingTextLength <= 0) {
        break;
      }
      const retained = current.value.slice(
        0,
        Math.min(MAX_NESTED_TEXT_LENGTH, remainingTextLength)
      );
      values.push(retained);
      retainedTextLength += retained.length;
      continue;
    }
    const remainingNodeBudget =
      MAX_NESTED_TEXT_NODES - visited - pending.length;
    if (remainingNodeBudget <= 0) {
      continue;
    }
    enqueueNestedChildren(pending, current, remainingNodeBudget);
  }
  return values;
}

type NestedValue = { depth: number; value: unknown };

function shouldSkipNestedValue(current: NestedValue): boolean {
  return (
    current.value === null ||
    current.value === undefined ||
    current.depth > MAX_NESTED_TEXT_DEPTH
  );
}

function enqueueNestedChildren(
  pending: NestedValue[],
  current: NestedValue,
  remainingNodeBudget: number
): void {
  const members = nestedMembers(current.value, remainingNodeBudget);
  for (let index = members.length - 1; index >= 0; index -= 1) {
    pending.push({ depth: current.depth + 1, value: members[index] });
  }
}

function nestedMembers(value: unknown, limit: number): unknown[] {
  if (Array.isArray(value)) {
    return value.slice(0, limit);
  }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const members: unknown[] = [];
  for (const key in parsed.data) {
    if (Object.hasOwn(parsed.data, key)) {
      members.push(parsed.data[key]);
      if (members.length >= limit) {
        break;
      }
    }
  }
  return members;
}
