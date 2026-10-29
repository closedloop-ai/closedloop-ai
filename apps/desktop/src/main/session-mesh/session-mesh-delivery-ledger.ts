import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";

/**
 * The Session Mesh delivery ledger: its shape, and how a corrupt one is
 * recovered. Split out of `session-mesh-runtime.ts` (ISS-11425) so the runtime
 * carries behavior and this carries the persisted contract.
 *
 * Cloud inbox stays authoritative, so quarantining a ledger only re-delivers.
 */
const operation = z.object({
  id: z.string(),
  sourceKey: z.string(),
  path: z.string(),
  method: z.enum(["POST", "DELETE"]).default("POST"),
  body: z.unknown(),
  status: z.enum(OutboxStatus),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});
/**
 * A confirmed denial, persisted here so a restart resumes the escalating backoff
 * in `session-mesh-denial-policy.ts` instead of resetting it to zero — the
 * restart loop is how a latch becomes a request storm even with a long wait.
 *
 * The SHAPE lives in this module rather than with the policy so the persisted
 * contract stays dependency-free; the policy that reads it imports from here.
 */
export const sessionMeshDenialValidator = z.object({
  sourceKey: z.string(),
  /** Index into the policy's backoff steps, clamped on read. */
  step: z.number().int().nonnegative(),
  /** Epoch ms before which no probe is sent for this source. */
  retryAt: z.number().finite(),
});
export type SessionMeshDenial = z.infer<typeof sessionMeshDenialValidator>;

const receipt = z.object({
  sourceKey: z.string(),
  agentId: z.string(),
  messageIds: z.array(z.string()),
  createdAt: z.number(),
  // Additive and optional (ISS-11435): the delivered message's own subject text,
  // kept so engagement can be matched against it after the receipt confirms
  // delivery. A ledger written before this reads as "no subjects", which records
  // `delivered, not engaged` rather than guessing at engagement.
  summaries: z.record(z.string(), z.string().max(4000)).optional(),
  paths: z
    .record(z.string(), z.array(z.string().max(1000)).max(200))
    .optional(),
  /** Value prompts this delivery's context carried, marked asked on confirmation. */
  promptedMessageIds: z.array(z.string()).max(200).optional(),
  /**
   * Additive and optional (ISS-11755): the per-message usefulness evidence seeds
   * captured when the context was handed to the hook, so the confirmation can
   * start observing against the SERVER's relevance verdict rather than guessing
   * at it. A receipt written before this field reads as "no seeds", and the
   * delivery is simply not observed.
   */
  evidence: z
    .record(
      z.string(),
      z.object({
        subject: z.string().max(1000),
        placebo: z.string().max(1000).nullable(),
        intentBeforeDelivery: z.boolean(),
        claimExpiresAt: z.number().finite().nullable(),
      })
    )
    .optional(),
});
const ledgerSchema = z.object({
  version: z.literal(1),
  operations: z.array(operation).max(2000),
  receipts: z.record(z.string(), receipt),
  // Additive and optional: a ledger written by a build that predates ISS-11425
  // carries no denial and reads as "not denied", which is this field's default.
  denial: sessionMeshDenialValidator.optional(),
});
export type Ledger = z.infer<typeof ledgerSchema>;
export function readLedger(
  file: string,
  log: (message: string) => void
): Ledger {
  if (existsSync(file)) {
    try {
      return ledgerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      const quarantine = `${file}.corrupt-${randomUUID()}`;
      renameSync(file, quarantine);
      log(
        `Session Mesh invalid delivery ledger preserved at ${quarantine}: ${String(error)}`
      );
    }
  }
  return { version: 1, operations: [], receipts: {} };
}
