import { SECRET_VALUE_REPLACE_PATTERN } from "@closedloop-ai/loops-api/secret-value-pattern";
import { z } from "zod";

/** Diagnostic log fields only; never use these identifiers as metric tags. */
export const invocationSyncDiagnosticIdSchema = z
  .string()
  .transform((value) => {
    if (
      value.length > 200 ||
      !diagnosticIdPattern.test(value) ||
      value.replace(SECRET_VALUE_REPLACE_PATTERN, "[redacted]") !== value
    ) {
      return "[redacted]";
    }
    return value;
  });

/**
 * The parent session's state in the desktop outbox, as the diagnostic read found
 * it.
 *
 * `Absent` is deliberately NOT "never queued". The verified-ack clear deletes the
 * outbox row (`sqliteClearOutboxEntries`), so a parent the cloud acked and then
 * lost reads exactly like one that was never enqueued, and nothing durable on the
 * desktop separates them — which is the very case this diagnostic exists to tell
 * apart from the rest. The name says only what the read can prove: no row under
 * this source key.
 */
export const InvocationSyncParentStatus = {
  Pending: "pending",
  DeadLettered: "dead_lettered",
  Withheld: "withheld",
  Absent: "absent",
  Unknown: "unknown",
} as const;

const parentStatusSchema = z.string().transform((value) => {
  for (const status of Object.values(InvocationSyncParentStatus)) {
    if (value === status) {
      return status;
    }
  }
  return InvocationSyncParentStatus.Unknown;
});

export const invocationSyncParentSchema = z
  .object({
    externalSessionId: invocationSyncDiagnosticIdSchema,
    sessionPresent: z.boolean(),
    outboxStatus: parentStatusSchema,
    // A diagnostic read must not assert that an absent outbox row was delivered.
    attemptCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    lastError: invocationSyncDiagnosticIdSchema.optional(),
    // Same treatment as `createdAt` on the part side, for the same reason: one
    // unreadable stored timestamp must not reject the whole ten-parent read and
    // send every parent to `parentReadFailed`. The flag says the column held
    // something, and that it could not be read.
    nextAttemptAt: z.iso.datetime().optional(),
    nextAttemptAtInvalid: z.boolean().optional(),
  })
  .strip();

export const invocationSyncMissingParentsSchema = z
  .object({
    computeTargetId: invocationSyncDiagnosticIdSchema,
    sessionSourceKey: invocationSyncDiagnosticIdSchema,
    observedAt: z.iso.datetime(),
    parentReadFailed: z.boolean().optional(),
    parts: z
      .array(
        z
          .object({
            externalSessionId: invocationSyncDiagnosticIdSchema,
            externalGenerationId: invocationSyncDiagnosticIdSchema,
            partIndex: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            partHash: invocationSyncDiagnosticIdSchema,
            // Both durable ladders exactly as the row carries them. A
            // `session_missing` rejection past the retry age horizon, or with an
            // unreadable `created_at`, advances `permanent_attempt_count` and
            // leaves `attempt_count` alone — and old rows past the horizon are
            // the spike population this diagnostic is for, so a derived
            // "attempts including this send" would report a number that is on
            // neither row.
            attemptCount: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            permanentAttemptCount: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            createdAt: z.iso.datetime().optional(),
            createdAtInvalid: z.boolean().optional(),
            parent: invocationSyncParentSchema.optional(),
          })
          .strip()
      )
      .min(1)
      .max(10),
  })
  .strip();

export type InvocationSyncParent = z.infer<typeof invocationSyncParentSchema>;
export type InvocationSyncMissingParents = z.infer<
  typeof invocationSyncMissingParentsSchema
>;

export const INVOCATION_SYNC_MISSING_PARENTS_CATEGORY =
  "sync.invocation.missing_parents";
const diagnosticIdPattern = /^[A-Za-z0-9_.:-]+$/;
