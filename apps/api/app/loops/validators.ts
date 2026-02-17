import { z } from "zod";

function jsonSizeWithinLimit(value: unknown, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf-8") <= maxBytes;
}

export const createLoopValidator = z.object({
  command: z.enum(["PLAN", "EXECUTE", "CHAT", "EXPLORE", "REQUEST_CHANGES"]),
  artifactId: z.string().uuid().optional(),
  workstreamId: z.string().uuid().optional(),
  prompt: z.string().max(100_000).optional(),
  repo: z
    .object({
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
    })
    .optional(),
  contextRefs: z
    .array(
      z.object({
        artifactId: z.string().uuid(),
        include: z.enum(["full", "summary"]),
      })
    )
    .optional(),
});

export const resumeLoopValidator = z.object({
  prompt: z.string().max(100_000).optional(),
});

/**
 * Known event types from the container harness.
 * Restricts what the runner can send to prevent arbitrary data injection.
 */
const loopEventType = z.enum([
  "started",
  "output",
  "progress",
  "tool_call",
  "artifact_created",
  "completed",
  "error",
  "cancelled",
]);

export const loopEventValidator = z
  .object({
    type: loopEventType,
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((val) => jsonSizeWithinLimit(val, 1_000_000), {
    message: "Event payload too large (max 1MB)",
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
    .refine((val) => jsonSizeWithinLimit(val, 1_000_000), {
      message: "Event payload too large (max 1MB)",
    }),
]);

/**
 * Validate required fields on a normalized (flat) loop event.
 * Applied post-normalization so both envelope and flattened paths are covered.
 * Returns an error string if validation fails, or null if valid.
 */
export function validateNormalizedEvent(
  event: Record<string, unknown>
): string | null {
  if (event.type === "completed") {
    const tu = event.tokensUsed;
    if (
      !tu ||
      typeof tu !== "object" ||
      typeof (tu as Record<string, unknown>).input !== "number" ||
      typeof (tu as Record<string, unknown>).output !== "number"
    ) {
      return "completed event requires tokensUsed with numeric input and output";
    }
    if (typeof event.timestamp !== "string") {
      return "completed event requires a timestamp string";
    }
  }
  if (
    event.type === "error" &&
    (typeof event.code !== "string" || typeof event.message !== "string")
  ) {
    return "error event requires code and message strings";
  }
  if (event.type === "cancelled" && typeof event.timestamp !== "string") {
    return "cancelled event requires a timestamp string";
  }
  return null;
}

export const listLoopEventsQueryValidator = z.object({
  type: z
    .enum([
      "started",
      "output",
      "progress",
      "tool_call",
      "artifact_created",
      "completed",
      "error",
      "cancelled",
    ])
    .optional(),
  limit: z.coerce.number().min(1).max(500).default(100).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});

export const listLoopsQueryValidator = z.object({
  status: z
    .enum([
      "PENDING",
      "CLAIMED",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
    ])
    .optional(),
  command: z
    .enum(["PLAN", "EXECUTE", "CHAT", "EXPLORE", "REQUEST_CHANGES"])
    .optional(),
  artifactId: z.string().uuid().optional(),
  workstreamId: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).default(50).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});
