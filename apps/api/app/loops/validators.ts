import {
  LoopCommandSchema,
  LoopStatusSchema,
} from "@closedloop-ai/loops-api/commands";
import {
  LoopEventCompletedSchema,
  LoopEventErrorSchema,
  LoopEventOutputSchema,
  LoopEventSupportBundleUploadedSchema,
  LoopEventType,
  LoopEventTypeSchema,
  RunnerLoopEventTypeSchema,
} from "@closedloop-ai/loops-api/events";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { HarnessType } from "@repo/api/src/types/compute-target";
import type { LoopEvent } from "@repo/api/src/types/loop";
import {
  LOOP_SUMMARIES_MAX_DOCUMENT_IDS,
  LoopStatus,
  MAX_ADDITIONAL_REPOS,
  ManualLoopEventType,
} from "@repo/api/src/types/loop";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import {
  repoBranchSchema,
  repoFullNameSchema,
} from "@/lib/repo-validator-helpers";

function jsonSizeWithinLimit(value: unknown, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf-8") <= maxBytes;
}

/** Validated repo schema — reuse wherever repo input is accepted. */
export const repoSchema = z.object({
  fullName: repoFullNameSchema,
  branch: repoBranchSchema,
});

/**
 * Validated additionalRepos schema — coerces empty arrays to undefined so
 * downstream consumers receive either a non-empty list or nothing at all.
 */
const additionalReposArraySchema = z
  .array(repoSchema)
  .max(MAX_ADDITIONAL_REPOS);

export const additionalReposSchema = additionalReposArraySchema
  .optional()
  .transform((value) => (value?.length ? value : undefined));

/**
 * Token refreshes use additionalRepos as an explicit subset selector. Empty
 * arrays mean "refresh only the primary token", so preserve [] instead of
 * normalizing it to an omitted field.
 */
export const tokenRefreshAdditionalReposSchema =
  additionalReposArraySchema.optional();

export const createLoopValidator = z.object({
  command: LoopCommandSchema,
  harness: z.enum([HarnessType.Claude, HarnessType.Codex]).optional(),
  documentId: uuidOrSlug().optional(),
  prompt: z.string().max(100_000).optional(),
  repo: repoSchema.optional(),
  additionalRepos: additionalReposSchema,
  contextRefs: z
    .array(
      z.object({
        sourceId: z.uuid(),
        sourceType: z.enum([ArtifactType.Document]).optional(),
        include: z.enum(["full", "summary"]),
      })
    )
    .optional(),
});

export const resumeLoopValidator = z.object({
  computeTargetId: z.uuid().optional(),
  prompt: z.string().max(100_000).optional(),
});

/**
 * Known event types from the container harness.
 * Restricts what the runner can send to prevent arbitrary data injection.
 * Omits system-internal audit events (`tokens_cleared`, `token_refreshed`)
 * that are emitted exclusively by the orchestrator.
 */
const loopEventType = RunnerLoopEventTypeSchema;

/**
 * Build envelope + flattened payload validators for a given event type enum.
 * Avoids duplicating the same structure for runner and manual event validators.
 */
function buildEventPayloadValidators(typeSchema: z.ZodType<string>) {
  const envelopeValidator = z
    .object({
      type: typeSchema,
      data: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .refine((val) => jsonSizeWithinLimit(val, 20_000_000), {
      message: "Event payload too large (max 20MB)",
    });

  /**
   * Accepts either envelope format { type, data } or flattened { type, ...fields }.
   * Shape-level validation only — terminal field enforcement happens post-normalization
   * via validateNormalizedEvent() so both branches are covered by one check.
   */
  const payloadValidator = z.union([
    envelopeValidator,
    z
      .object({ type: typeSchema })
      .catchall(z.unknown())
      .refine((val) => jsonSizeWithinLimit(val, 20_000_000), {
        message: "Event payload too large (max 20MB)",
      }),
  ]);

  return { envelopeValidator, payloadValidator } as const;
}

const runnerEventValidators = buildEventPayloadValidators(loopEventType);
export const loopEventValidator = runnerEventValidators.envelopeValidator;
export const loopEventPayloadValidator = runnerEventValidators.payloadValidator;

/**
 * Format the first Zod issue into a human-readable error string.
 */
function firstZodIssue(
  issues: Array<{ path: PropertyKey[]; message: string }>,
  fallback: string
): string {
  const issue = issues[0];
  const path = issue?.path.join(".");
  return path ? `${path}: ${issue.message}` : (issue?.message ?? fallback);
}

/**
 * Validate a normalized (flat) loop event against the shared schema.
 * Returns an error string if validation fails, or null if valid.
 */
const eventSchemaByType: Record<
  string,
  { schema: z.ZodType; fallback: string }
> = {
  output: {
    schema: LoopEventOutputSchema.omit({ type: true }),
    fallback: "invalid output event",
  },
  completed: {
    schema: LoopEventCompletedSchema.omit({ type: true }),
    fallback: "invalid completed event",
  },
  error: {
    schema: LoopEventErrorSchema.omit({ type: true }),
    fallback: "invalid error event",
  },
  support_bundle_uploaded: {
    schema: LoopEventSupportBundleUploadedSchema.omit({ type: true }),
    fallback: "invalid support bundle uploaded event",
  },
};

const normalizedEventShape = z
  .object({ type: z.string().optional() })
  .passthrough();

export function validateNormalizedEvent(event: unknown): string | null {
  const parsed = normalizedEventShape.safeParse(event);
  const eventObj: Record<string, unknown> = parsed.success ? parsed.data : {};
  const entry =
    typeof eventObj.type === "string"
      ? eventSchemaByType[eventObj.type]
      : undefined;
  if (entry) {
    const result = entry.schema.safeParse(eventObj);
    if (!result.success) {
      return firstZodIssue(result.error.issues, entry.fallback);
    }
  }
  if (eventObj.type === "cancelled" && typeof eventObj.timestamp !== "string") {
    return "cancelled event requires a timestamp string";
  }
  return null;
}

export const listLoopEventsQueryValidator = z.object({
  type: LoopEventTypeSchema.optional(),
  limit: z.coerce.number().min(1).max(500).default(100).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
  sort: z.enum(["asc", "desc"]).default("asc").optional(),
});

/**
 * Event types accepted by the manual-events route.
 * Manual loops support a subset of event types — no "started" (loop starts
 * in RUNNING) and no "tool_call" / "artifact_created" (those are runner-only).
 */
const manualEventType = z.enum(ManualLoopEventType);

const manualEventValidators = buildEventPayloadValidators(manualEventType);
export const manualEventValidator = manualEventValidators.envelopeValidator;
export const manualEventPayloadValidator =
  manualEventValidators.payloadValidator;

/**
 * Validator for PATCH /loops/[id] metadata updates.
 * Accepts optional prUrl, branchName, and summary fields.
 */
export const loopMetadataUpdateValidator = z
  .object({
    prUrl: z.string().url().max(2048).optional(),
    branchName: repoBranchSchema.optional(),
    summary: z.string().max(10_000).optional(),
  })
  .strict();

export const listLoopsQueryValidator = z.object({
  status: LoopStatusSchema.optional(),
  command: LoopCommandSchema.optional(),
  documentId: uuidOrSlug().optional(),
  projectId: z.uuid().optional(),
  limit: z.coerce.number().min(1).max(200).default(50).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});

/** Loop statuses that represent a terminal (finished) state. */
export const TERMINAL_LOOP_STATUSES = new Set<string>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

/** Event types that transition a loop to a terminal state. */
export const TERMINAL_LOOP_EVENTS = new Set<string>([
  LoopEventType.Completed,
  LoopEventType.Error,
  LoopEventType.Cancelled,
]);

const SUPPORT_EVENT_TERMINAL_STATUSES = new Set<string>([
  LoopStatus.Failed,
  LoopStatus.TimedOut,
]);

/**
 * Return true when a runner event should be ignored because the loop is already
 * terminal. Support bundle metadata is the only non-terminal event accepted
 * after FAILED/TIMED_OUT so Desktop crash recovery can publish support links.
 */
export function shouldIgnoreEventForTerminalLoop(
  status: string,
  eventType: string
): boolean {
  if (!TERMINAL_LOOP_STATUSES.has(status)) {
    return false;
  }
  if (TERMINAL_LOOP_EVENTS.has(eventType)) {
    return false;
  }
  return !(
    eventType === LoopEventType.SupportBundleUploaded &&
    SUPPORT_EVENT_TERMINAL_STATUSES.has(status)
  );
}

/**
 * Normalize a loop event from either envelope { type, data: {...} } or
 * flattened { type, ...fields } format into the canonical flat LoopEvent shape.
 * Shared by both runner and manual event routes.
 */
export function normalizeLoopEvent(body: unknown): LoopEvent {
  if (
    body &&
    typeof body === "object" &&
    "data" in body &&
    typeof (body as { data?: unknown }).data === "object" &&
    (body as { data?: unknown }).data !== null
  ) {
    const b = body as {
      type: LoopEvent["type"];
      data: Record<string, unknown>;
    };
    return { ...b.data, type: b.type } as LoopEvent;
  }
  return body as LoopEvent;
}

export const loopSummariesBodyValidator = z.object({
  documentIds: z.array(z.uuid()).min(1).max(LOOP_SUMMARIES_MAX_DOCUMENT_IDS),
});
