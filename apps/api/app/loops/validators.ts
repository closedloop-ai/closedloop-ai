import {
  LoopCommandSchema,
  LoopStatusSchema,
} from "@closedloop-ai/loops-api/commands";
import {
  LoopEventCompletedSchema,
  LoopEventErrorSchema,
  LoopEventOutputSchema,
  LoopEventTypeSchema,
} from "@closedloop-ai/loops-api/events";
import { EntityType } from "@repo/api/src/types/entity-link";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";

function jsonSizeWithinLimit(value: unknown, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf-8") <= maxBytes;
}

/** Validated repo schema — reuse wherever repo input is accepted. */
export const repoSchema = z.object({
  // "owner/repo" format — alphanumeric, dots, hyphens, underscores
  fullName: z
    .string()
    .max(256)
    .regex(
      /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/,
      "Must be in 'owner/repo' format"
    ),
  // Git branch name — no shell metacharacters, no path traversal
  branch: z
    .string()
    .max(256)
    .regex(/^[a-zA-Z0-9._/-]+$/, "Branch name contains invalid characters"),
});

export const createLoopValidator = z.object({
  command: LoopCommandSchema,
  documentId: z.uuidv7().optional(),
  workstreamId: z.uuidv7().optional(),
  prompt: z.string().max(100_000).optional(),
  repo: repoSchema.optional(),
  contextRefs: z
    .array(
      z.object({
        sourceId: z.uuidv7(),
        sourceType: z
          .enum([EntityType.Document, EntityType.Feature])
          .optional(),
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
 */
const loopEventType = LoopEventTypeSchema;

export const loopEventValidator = z
  .object({
    type: loopEventType,
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
export const loopEventPayloadValidator = z.union([
  loopEventValidator,
  z
    .object({ type: loopEventType })
    .catchall(z.unknown())
    .refine((val) => jsonSizeWithinLimit(val, 20_000_000), {
      message: "Event payload too large (max 20MB)",
    }),
]);

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
};

export function validateNormalizedEvent(
  event: Record<string, unknown>
): string | null {
  const entry = eventSchemaByType[event.type as string];
  if (entry) {
    const result = entry.schema.safeParse(event);
    if (!result.success) {
      return firstZodIssue(result.error.issues, entry.fallback);
    }
  }
  if (event.type === "cancelled" && typeof event.timestamp !== "string") {
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

export const listLoopsQueryValidator = z.object({
  status: LoopStatusSchema.optional(),
  command: LoopCommandSchema.optional(),
  documentId: uuidOrSlug().optional(),
  workstreamId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  limit: z.coerce.number().min(1).max(200).default(50).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});
