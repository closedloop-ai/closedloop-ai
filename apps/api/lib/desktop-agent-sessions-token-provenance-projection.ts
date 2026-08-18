import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { jsonObjectSchema } from "./json-schema";

/** Keeps understood identity fields while degrading unknown future variants. */
export function projectKnownTokenSourceIdentity(value: unknown): unknown {
  const record = parseRecord(value);
  if (!record) {
    return value;
  }
  if (record.availability === TokenSourceIdentityAvailability.Available) {
    return {
      availability: record.availability,
      scheme: record.scheme,
      sourceRecordIds: record.sourceRecordIds,
    };
  }
  if (record.availability === TokenSourceIdentityAvailability.Unavailable) {
    if (
      typeof record.reason === "string" &&
      !Object.values(TokenSourceIdentityUnavailableReason).some(
        (reason) => reason === record.reason
      )
    ) {
      return undefined;
    }
    return { availability: record.availability, reason: record.reason };
  }
  return typeof record.availability === "string" ? undefined : value;
}

/** Keeps understood cost fields while degrading unknown future variants. */
export function projectKnownTokenCostSummary(value: unknown): unknown {
  const record = parseRecord(value);
  if (!record) {
    return value;
  }
  if (
    typeof record.completeness === "string" &&
    !Object.values(TokenCostCompleteness).some(
      (completeness) => completeness === record.completeness
    )
  ) {
    return undefined;
  }
  if (
    (record.completeness === TokenCostCompleteness.Partial ||
      record.completeness === TokenCostCompleteness.Unavailable) &&
    typeof record.reason === "string" &&
    !Object.values(TokenCostCompletenessReason).some(
      (reason) => reason === record.reason
    )
  ) {
    return undefined;
  }
  const lanes = projectKnownTokenCostLanes(record.lanes);
  if (!lanes.known) {
    return undefined;
  }
  if (record.completeness === TokenCostCompleteness.Complete) {
    return {
      completeness: record.completeness,
      subtotalUsd: record.subtotalUsd,
      ...(record.lanes === undefined ? {} : { lanes: lanes.value }),
    };
  }
  if (record.completeness === TokenCostCompleteness.Partial) {
    return {
      completeness: record.completeness,
      reason: record.reason,
      subtotalUsd: record.subtotalUsd,
      ...(record.lanes === undefined ? {} : { lanes: lanes.value }),
    };
  }
  if (record.completeness === TokenCostCompleteness.Unavailable) {
    return { completeness: record.completeness, reason: record.reason };
  }
  return value;
}

function projectKnownTokenCostLanes(value: unknown): {
  known: boolean;
  value: unknown;
} {
  if (!Array.isArray(value)) {
    return { known: true, value };
  }
  const projected: unknown[] = [];
  for (const lane of value) {
    const record = parseRecord(lane);
    if (!record) {
      projected.push(lane);
      continue;
    }
    if (
      typeof record.basis === "string" &&
      !Object.values(TokenCostBasis).some((basis) => basis === record.basis)
    ) {
      return { known: false, value };
    }
    projected.push({
      basis: record.basis,
      subtotalUsd: record.subtotalUsd,
    });
  }
  return { known: true, value: projected };
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
