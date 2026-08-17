import { asRecord } from "../util/api-response-utils.js";

const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?$/;

export function asOtlpRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
    : [];
}

export function decodeOtlpAnyValue(
  value: Record<string, unknown> | undefined
): unknown {
  if (!value) {
    return undefined;
  }
  const stringScalar = stringValue(value.stringValue);
  if (stringScalar !== undefined) {
    return stringScalar;
  }
  if (typeof value.boolValue === "boolean") {
    return value.boolValue;
  }
  const numericScalar =
    numberValue(value.intValue) ?? numberValue(value.doubleValue);
  if (numericScalar !== undefined) {
    return numericScalar;
  }
  return value.bytesValue;
}

export function numberFromOtlpValue(value: unknown): number | undefined {
  return numberValue(value);
}

export function decodeOtlpBytesToHex(
  value: unknown,
  options: { bytes: "base64" | "buffer" }
): string {
  if (options.bytes === "base64") {
    return typeof value === "string"
      ? Buffer.from(value, "base64").toString("hex")
      : "";
  }
  return Buffer.isBuffer(value) ? value.toString("hex") : "";
}

export function walkOtlpTraceSpans(
  resourceSpans: Record<string, unknown>[]
): Record<string, unknown>[] {
  return resourceSpans.flatMap((resourceSpan) =>
    asOtlpRecordArray(resourceSpan.scopeSpans).flatMap((scopeSpan) =>
      asOtlpRecordArray(scopeSpan.spans)
    )
  );
}

export function decodeOtlpAttributes(
  attributes: Record<string, unknown>[]
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const attribute of attributes) {
    const key = stringValue(attribute.key);
    if (key) {
      decoded[key] = decodeOtlpAnyValue(asRecord(attribute.value));
    }
  }
  return decoded;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && NUMERIC_STRING_RE.test(value)) {
    return Number(value);
  }
  return undefined;
}
