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
  const array = decodeOtlpArrayValue(value.arrayValue);
  if (array !== undefined) {
    return array;
  }
  return value.bytesValue;
}

/**
 * An `ArrayValue`'s members, decoded, or `undefined` when the AnyValue held no
 * array.
 *
 * Arrays used to fall through to `bytesValue` and decode to `undefined`, which
 * an attribute reader cannot tell from an attribute that was never stamped.
 * `gen_ai.response.finish_reasons` (ISS-7352 item D) is a `string[]` in the
 * OTel gen-AI semantic conventions, so without this the one attribute that says
 * why a request stopped read as absent on every span that carried it.
 */
function decodeOtlpArrayValue(value: unknown): unknown[] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const members = (value as Record<string, unknown>).values;
  // proto3 omits an empty repeated field, so an ArrayValue with no members
  // arrives as `arrayValue: {}` — a real empty list, which a reader must be
  // able to tell from an AnyValue that decoded to nothing.
  if (members === undefined) {
    return [];
  }
  if (!Array.isArray(members)) {
    return undefined;
  }
  return asOtlpRecordArray(members).map((member) => decodeOtlpAnyValue(member));
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
  return walkOtlpLeaves(resourceSpans, "scopeSpans", "spans");
}

export function decodeOtlpAttributes(
  attributes: Record<string, unknown>[]
): Record<string, unknown> {
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const decoded: Record<string, unknown> = Object.create(null);
  for (const attribute of attributes) {
    const key = stringValue(attribute.key);
    if (key) {
      decoded[key] = decodeOtlpAnyValue(asRecord(attribute.value));
    }
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...decoded };
}

export function walkOtlpMetrics(
  resourceMetrics: Record<string, unknown>[]
): Record<string, unknown>[] {
  return walkOtlpLeaves(resourceMetrics, "scopeMetrics", "metrics");
}

export function walkOtlpLogRecords(
  resourceLogs: Record<string, unknown>[]
): Record<string, unknown>[] {
  return walkOtlpLeaves(resourceLogs, "scopeLogs", "logRecords");
}

/**
 * Every OTLP signal nests the same three levels — resource container, scope
 * array, leaf array — so the three exported walkers above differ only in their
 * two key names. Keeping the traversal here means a consumer never re-derives
 * it against `decodedPayload` and silently skips a level.
 */
function walkOtlpLeaves(
  resourceContainers: Record<string, unknown>[],
  scopeKey: string,
  leafKey: string
): Record<string, unknown>[] {
  return resourceContainers.flatMap((container) =>
    asOtlpRecordArray(container[scopeKey]).flatMap((scope) =>
      asOtlpRecordArray(scope[leafKey])
    )
  );
}

/**
 * One resource container's own attributes, kept WITH its leaves.
 *
 * The flattening walkers above are right for a consumer that has already
 * decided the whole export belongs to one producer. A consumer that must
 * attribute data per producer cannot use them: an OTLP request may carry
 * several resource containers, and flattening discards which resource each
 * leaf came from (ISS-7352 review).
 */
export type OtlpResourceGroup = {
  resourceAttributes: Record<string, unknown>;
  leaves: Record<string, unknown>[];
};

export function groupOtlpMetricsByResource(
  resourceMetrics: Record<string, unknown>[]
): OtlpResourceGroup[] {
  return groupOtlpLeavesByResource(resourceMetrics, "scopeMetrics", "metrics");
}

export function groupOtlpLogRecordsByResource(
  resourceLogs: Record<string, unknown>[]
): OtlpResourceGroup[] {
  return groupOtlpLeavesByResource(resourceLogs, "scopeLogs", "logRecords");
}

export function groupOtlpSpansByResource(
  resourceSpans: Record<string, unknown>[]
): OtlpResourceGroup[] {
  return groupOtlpLeavesByResource(resourceSpans, "scopeSpans", "spans");
}

function groupOtlpLeavesByResource(
  resourceContainers: Record<string, unknown>[],
  scopeKey: string,
  leafKey: string
): OtlpResourceGroup[] {
  return resourceContainers.map((container) => ({
    resourceAttributes: decodeOtlpAttributes(
      asOtlpRecordArray(asRecord(container.resource).attributes)
    ),
    leaves: asOtlpRecordArray(container[scopeKey]).flatMap((scope) =>
      asOtlpRecordArray(scope[leafKey])
    ),
  }));
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
