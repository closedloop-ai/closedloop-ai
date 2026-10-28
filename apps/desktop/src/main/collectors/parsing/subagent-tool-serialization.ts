/**
 * Character ceiling for a serialized tool-use OUTPUT. ISS-6480 removed the
 * input bound — `input` is carried raw now and is never serialized here.
 */
export const MAX_STRINGIFIED_CHARS = 1000;

/** Serialize completion evidence as valid, root-type-preserving bounded JSON. */
export function stringifyBoundedResult(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return stringifyBoundedJsonValue(value, MAX_STRINGIFIED_CHARS, new Set(), 0);
}

/** Return one valid JSON string literal whose serialized size is bounded. */
export function stringifyBoundedJsonString(value: string): string {
  return boundedJsonString(value, MAX_STRINGIFIED_CHARS) ?? '""';
}

function stringifyBoundedJsonValue(
  value: unknown,
  budget: number,
  ancestors: Set<object>,
  depth: number
): string | null {
  if (budget < 2 || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return boundedJsonString(value, budget);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    const encoded = JSON.stringify(
      typeof value === "number" && !Number.isFinite(value) ? null : value
    );
    return encoded.length <= budget ? encoded : null;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return "null";
  }
  if (depth >= MAX_BOUNDED_JSON_DEPTH) {
    return Array.isArray(value) ? "[]" : "{}";
  }
  ancestors.add(value);
  const encoded = Array.isArray(value)
    ? encodeBoundedArray(value, budget, ancestors, depth + 1)
    : encodeBoundedObject(value, budget, ancestors, depth + 1);
  ancestors.delete(value);
  return encoded;
}

function encodeBoundedArray(
  values: readonly unknown[],
  budget: number,
  ancestors: Set<object>,
  depth: number
): string {
  let encoded = "[";
  for (const value of values) {
    const separator = encoded.length === 1 ? "" : ",";
    const remaining = budget - encoded.length - separator.length - 1;
    const item = stringifyBoundedJsonValue(value, remaining, ancestors, depth);
    if (item === null) {
      break;
    }
    encoded += `${separator}${item}`;
  }
  return `${encoded}]`;
}

function encodeBoundedObject(
  value: object,
  budget: number,
  ancestors: Set<object>,
  depth: number
): string {
  let encoded = "{";
  for (const key of Object.keys(value)) {
    const keyJson = JSON.stringify(key);
    const separator = encoded.length === 1 ? "" : ",";
    const remaining =
      budget - encoded.length - separator.length - keyJson.length - 2;
    const item = stringifyBoundedJsonValue(
      (value as Record<string, unknown>)[key],
      remaining,
      ancestors,
      depth
    );
    if (item === null) {
      break;
    }
    encoded += `${separator}${keyJson}:${item}`;
  }
  return `${encoded}}`;
}

function boundedJsonString(value: string, budget: number): string | null {
  if (budget < 2) {
    return null;
  }
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (JSON.stringify(value.slice(0, candidate)).length <= budget) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return JSON.stringify(value.slice(0, lower));
}

const MAX_BOUNDED_JSON_DEPTH = 20;
