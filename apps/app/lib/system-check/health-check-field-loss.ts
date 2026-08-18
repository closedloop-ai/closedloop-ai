import type { HealthCheckResponse } from "@repo/api/src/types/compute-target";
import { HarnessType } from "@repo/api/src/types/compute-target";
import {
  type ClientEventProperties,
  captureClientEvent,
} from "@/lib/analytics/client-event-sink";

/**
 * Field loss on the LIVE in-browser health-check parse.
 *
 * The API's persist boundary reports what it discards (ISS-5868), but a
 * LocalElectron response never goes near the API — the browser talks to the
 * gateway directly — so on that route the same `z.preprocess` guards drop the
 * same malformed fields with nothing anywhere saying so. Degrading is still the
 * right failure mode (the response is parsed as ONE unit, so rejecting costs the
 * whole panel rather than one field), but silence is not.
 *
 * The guarded set here is deliberately NOT the API's list. That boundary has no
 * `.passthrough()` and guards `severity` and `blockedBy` as well; this schema
 * DOES pass unknown keys through and never declares those two, so they cannot be
 * dropped here. Only the fields this schema actually preprocesses can go missing
 * on this path, and listing more would report losses that never happen.
 */
export const HEALTH_CHECK_FIELDS_DROPPED_EVENT =
  "health_check_fields_dropped_client";

/**
 * The check-row fields the in-browser schema degrades to absent. Hand-maintained
 * beside the `z.preprocess` guards it mirrors, so the schema's own suite pins it
 * behaviourally — a guard added here or there without the other is a field that
 * goes back to being dropped in silence.
 */
export const GUARDED_CHECK_FIELDS = ["enableOutcome", "updateOutcome"] as const;

/**
 * How many dropped names ride along. Every part of a name comes from the
 * gateway, so the COUNT is the signal and the sample is only enough to name the
 * producer's bug — same bound the API-side event uses.
 */
const DROPPED_FIELD_SAMPLE_LIMIT = 5;

/** Per-name cap, so one absurd check id cannot dominate the event. */
const DROPPED_FIELD_NAME_MAX_LENGTH = 120;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRawChecks(rawBody: unknown): unknown[] {
  const checks = asRecord(rawBody)?.checks;
  return Array.isArray(checks) ? checks : [];
}

function collectDroppedCheckFields(
  rawBody: unknown,
  parsed: HealthCheckResponse
): string[] {
  const rawChecks = getRawChecks(rawBody);
  const dropped: string[] = [];
  parsed.checks.forEach((parsedCheck, index) => {
    const rawCheck = asRecord(rawChecks[index]);
    if (!rawCheck) {
      return;
    }
    for (const field of GUARDED_CHECK_FIELDS) {
      if (rawCheck[field] !== undefined && parsedCheck[field] === undefined) {
        dropped.push(`${parsedCheck.id}.${field}`);
      }
    }
    const rawAction = asRecord(rawCheck.repair)?.action;
    if (rawAction !== undefined && parsedCheck.repair?.action === undefined) {
      dropped.push(`${parsedCheck.id}.repair.action`);
    }
  });
  return dropped;
}

function collectDroppedMcpRepairActions(
  rawBody: unknown,
  parsed: HealthCheckResponse
): string[] {
  const rawMcpServers = asRecord(asRecord(rawBody)?.mcpServers);
  if (!rawMcpServers) {
    return [];
  }
  const dropped: string[] = [];
  for (const harness of Object.values(HarnessType)) {
    const rawAction = asRecord(
      asRecord(rawMcpServers[harness])?.repair
    )?.action;
    const parsedAction = parsed.mcpServers?.[harness]?.repair?.action;
    if (rawAction !== undefined && parsedAction === undefined) {
      dropped.push(`mcpServers.${harness}.repair.action`);
    }
  }
  return dropped;
}

/**
 * `<checkId>.<field>` for every guarded field the in-browser schema discarded,
 * plus `mcpServers.<harness>.repair.action`. Empty when nothing was dropped —
 * the common case, so callers stay silent on an empty list.
 *
 * Index-aligned: `z.array` preserves order and length, so the Nth parsed row is
 * the Nth raw row.
 */
export function getDroppedHealthCheckFields(
  rawBody: unknown,
  parsed: HealthCheckResponse
): string[] {
  return [
    ...collectDroppedCheckFields(rawBody, parsed),
    ...collectDroppedMcpRepairActions(rawBody, parsed),
  ];
}

/**
 * Route the loss through the client monitoring path.
 *
 * Analytics, not a log: `console.*` in browser code is banned outright and never
 * reaches an aggregator anyway, so this is the only reporting path a client
 * module has. Silent when nothing was dropped, and it never throws — an
 * observability miss must not cost the panel the response it just parsed.
 */
export function reportDroppedHealthCheckFields(
  rawBody: unknown,
  parsed: HealthCheckResponse
): void {
  const droppedFields = getDroppedHealthCheckFields(rawBody, parsed);
  if (droppedFields.length === 0) {
    return;
  }
  const properties: ClientEventProperties = {
    droppedFieldCount: droppedFields.length,
    checkCount: parsed.checks.length,
    droppedFieldSample: droppedFields
      .slice(0, DROPPED_FIELD_SAMPLE_LIMIT)
      .map((field) => field.slice(0, DROPPED_FIELD_NAME_MAX_LENGTH)),
  };
  captureClientEvent(HEALTH_CHECK_FIELDS_DROPPED_EVENT, properties);
}
