import { type TransactionClient, withDb } from "@repo/database";
import { z } from "zod";
import { writeOrganizationSettingsKey } from "@/lib/organization-settings-write";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-7721: the durable per-organization run gate that background lanes share —
 * the GitHub backfill sweep (ISS-7408) and the post-connect observed sync.
 *
 * Each lane needs the same three things: an advisory lock, so two serverless
 * instances cannot both claim; an in-flight lease, so a run the platform kills
 * mid-sweep does not wedge the lane forever; and a post-run cooldown, so a
 * client that re-fires the trigger does not re-run the work. Only the settings
 * key, the lock name, and the two durations differ, and a second copy of the
 * read-decide-write trio is the drift-by-copy this repo keeps paying for.
 */
const organizationRunGateSchema = z
  .object({
    inFlightUntil: z.number().int().min(0),
    cooldownUntil: z.number().int().min(0),
  })
  .strict();

export type OrganizationRunGateDefinition = {
  /** Top-level `Organization.settings` key holding this lane's gate value. */
  settingsKey: string;
  /**
   * Advisory-lock discriminator. Distinct per lane: two lanes sharing one would
   * serialize against each other for no reason.
   */
  lockName: string;
  /** How long a claim stays in flight before another caller may take the lane. */
  leaseMs: number;
  /** How long after a release the lane refuses a fresh claim. */
  cooldownMs: number;
  /** Names this lane's writer in the shared row-count guard's messages. */
  writeSubject: string;
};

export type OrganizationRunClaim =
  | { claimed: true }
  | {
      claimed: false;
      /**
       * The settings snapshot the refusal was decided on, read inside the same
       * transaction as the gate. Callers that answer a refusal with stored state
       * (the backfill's last summary) read it from here rather than issuing a
       * second, potentially newer, read.
       */
      settings: Record<string, unknown>;
      blockedUntil: number;
    };

const settingsObjectSchema = z.record(z.string(), z.unknown());

/** Whether this lane holds an unexpired in-flight lease. */
export function isOrganizationRunInFlight(
  settings: Record<string, unknown>,
  definition: OrganizationRunGateDefinition,
  nowMs: number = Date.now()
): boolean {
  const gate = organizationRunGateSchema.safeParse(
    settings[definition.settingsKey]
  );
  return gate.success && gate.data.inFlightUntil > nowMs;
}

/**
 * Take the lane for this organization, or report why not.
 *
 * The advisory lock is held for the whole read-decide-write, so two callers that
 * arrive together cannot both observe a free gate. `bypassCooldown` honors the
 * in-flight lease and skips only the post-release window — a trusted
 * continuation resuming its own bounded work, never a client retry.
 */
export function claimOrganizationRun(
  organizationId: string,
  definition: OrganizationRunGateDefinition,
  options: {
    bypassCooldown?: boolean;
    now?: Date;
    /**
     * Runs on the claim's transaction once the lease is written (ISS-12552);
     * a refused claim writes nothing and does not call it.
     */
    recordClaim?: RecordWriteInTransaction<OrganizationWriteOutcome>;
  } = {}
): Promise<OrganizationRunClaim> {
  return withDb.tx(async (tx) => {
    await lockOrganizationRunGate(tx, organizationId, definition.lockName);
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = settingsObjectSchema.parse(organization?.settings ?? {});
    const now = options.now?.getTime() ?? Date.now();
    const gate = organizationRunGateSchema.safeParse(
      settings[definition.settingsKey]
    );
    const blockedUntil = gate.success
      ? Math.max(
          gate.data.inFlightUntil,
          options.bypassCooldown ? 0 : gate.data.cooldownUntil
        )
      : 0;
    if (blockedUntil > now) {
      return { claimed: false, settings, blockedUntil };
    }
    await writeOrganizationSettingsKey(
      organizationId,
      definition.settingsKey,
      {
        inFlightUntil: now + definition.leaseMs,
        cooldownUntil: now + definition.cooldownMs,
      },
      definition.writeSubject
    );
    await options.recordClaim?.(tx, { changed: true });
    return { claimed: true };
  });
}

/**
 * Give the lane back and start its cooldown. Clearing the lease is what lets the
 * next claim through before the lease would have expired on its own.
 */
export async function releaseOrganizationRun(
  organizationId: string,
  definition: OrganizationRunGateDefinition,
  options: { now?: Date } = {}
): Promise<void> {
  await withDb.tx(async (tx) => {
    await lockOrganizationRunGate(tx, organizationId, definition.lockName);
    const now = options.now?.getTime() ?? Date.now();
    await writeOrganizationSettingsKey(
      organizationId,
      definition.settingsKey,
      {
        inFlightUntil: 0,
        cooldownUntil: now + definition.cooldownMs,
      },
      definition.writeSubject
    );
  });
}

async function lockOrganizationRunGate(
  tx: TransactionClient,
  organizationId: string,
  lockName: string
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${organizationId}),
      hashtext(${lockName})
    )
  `;
}
