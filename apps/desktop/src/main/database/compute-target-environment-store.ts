/**
 * @file compute-target-environment-store.ts
 * @description The `compute_target_environments` mapping: which environment
 * (normalized apiOrigin) a compute target was registered in (ISS-7096).
 *
 * One table, one module, every function takes the `DesktopPrisma` handle
 * explicitly — the `sync-outbox-store.ts` conventions. Writes route through
 * `prisma.write`; reads use `prisma.client`.
 *
 * The binding is durable environment ATTRIBUTION — which environment each
 * compute target was registered in — recorded for diagnostics and for a later
 * key-level disposition to consume. It is deliberately NOT the partition
 * oracle: pre-M3 pollution left foreign rows under this environment's own
 * keys, so a key's rows are a mixed population and the partition decides from
 * each row's SESSION ownership instead (`outbox-environment-partition.ts`).
 * An UNMAPPED target reads as unknown — never as some default environment
 * (cr-81036).
 */
import type { DesktopPrisma } from "./prisma-client.js";
import { WriteQueueClass } from "./write-queue.js";

/**
 * Record (or refresh) the environment binding for one compute target. Latest
 * observation wins on `environment_key` — the live binding is authoritative —
 * while `first_seen_at` is preserved from the first record.
 */
export async function recordComputeTargetEnvironment(
  prisma: DesktopPrisma,
  computeTargetId: string,
  environmentKey: string
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write(
    (client) =>
      client.computeTargetEnvironment.upsert({
        where: { computeTargetId },
        create: {
          computeTargetId,
          environmentKey,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: { environmentKey, lastSeenAt: now },
      }),
    undefined,
    { class: WriteQueueClass.Bulk }
  );
}
