import { AsyncLocalStorage } from "node:async_hooks";
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression";
import {
  ListQueryExecution,
  type ListQueryObservation,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { z } from "zod";
import { reportInvalidDbHostQueryCountMetadata } from "../telemetry/db-host-telemetry-refusal.js";

const requestRecordSchema = z.record(z.string(), z.unknown());
const queryExecutionSchema = z.enum(ListQueryExecution);
const queryPopulationCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const observationStorage = new AsyncLocalStorage<ListQueryObservation>();

/** Run one Desktop IPC read with an isolated, value-free query observation. */
export function runWithSessionListQueryObservation<T>(
  request: unknown,
  handler: () => Promise<T>
): Promise<T> {
  return observationStorage.run({ source: listQuerySource(request) }, handler);
}

/** Record the list execution path selected inside the local projection. */
export function recordSessionListQueryExecution(
  execution: ListQueryExecution
): void {
  recordSessionListQueryObservation({ execution });
}

/** Merge bounded list-query facts into the active IPC observation. */
export function recordSessionListQueryObservation(
  update: ListQueryObservation
): void {
  const observation = observationStorage.getStore();
  if (observation) {
    Object.assign(observation, update);
  }
}

/** Read a copy so the telemetry emitter cannot mutate the active observation. */
export function currentSessionListQueryObservation(): ListQueryObservation {
  return { ...observationStorage.getStore() };
}

/** Validate optional DB-host query facts independently across version skew. */
export function sanitizeDbHostSessionListQueryObservation(input: {
  execution?: unknown;
  matchedCount?: unknown;
  scannedCount?: unknown;
}): ListQueryObservation {
  const execution = queryExecutionSchema.safeParse(input.execution);
  const matchedCount = queryPopulationCountSchema.safeParse(input.matchedCount);
  const scannedCount = queryPopulationCountSchema.safeParse(input.scannedCount);
  if (
    (input.matchedCount !== undefined && !matchedCount.success) ||
    (input.scannedCount !== undefined && !scannedCount.success)
  ) {
    reportInvalidDbHostQueryCountMetadata();
  }
  return {
    ...(execution.success ? { execution: execution.data } : {}),
    ...(matchedCount.success ? { matchedCount: matchedCount.data } : {}),
    ...(scannedCount.success ? { scannedCount: scannedCount.data } : {}),
  };
}

function listQuerySource(request: unknown) {
  const parsed = requestRecordSchema.safeParse(request);
  return parsed.success &&
    parsed.data[LIST_QUERY_EXPRESSION_PARAM] !== undefined
    ? ListQuerySource.Canonical
    : ListQuerySource.Legacy;
}
