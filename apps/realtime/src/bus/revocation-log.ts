import { log } from "@repo/observability/log";
import { revokeTargetSchema } from "@repo/realtime-contract/internal";
import {
  REVOCATION_RETENTION_MS,
  type Revocation,
} from "@repo/realtime-contract/revocations";
import { z } from "zod";

/**
 * The commands the revocation log runs, each on its one key, so none raises
 * CROSSSLOT on a cluster-mode endpoint.
 */
export type RevocationLogClient = {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: string, max: number): Promise<unknown>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  zrangebyscore(key: string, min: number, max: string): Promise<string[]>;
};

/**
 * Every revoke of the last token lifetime, scored by when it was taken. Pub/sub
 * keeps nothing, so an instance whose subscription was down reads what it
 * missed from here when it subscribes again. Trimmed on every append, and the
 * whole key expires one lifetime after the last one.
 */
export const REVOCATION_LOG_KEY = "rt:revocations";

export async function appendRevocation(
  client: RevocationLogClient,
  revocation: Revocation
): Promise<void> {
  await Promise.all([
    client.zadd(REVOCATION_LOG_KEY, revocation.at, JSON.stringify(revocation)),
    client.zremrangebyscore(
      REVOCATION_LOG_KEY,
      "-inf",
      revocation.at - REVOCATION_RETENTION_MS
    ),
    client.pexpire(REVOCATION_LOG_KEY, REVOCATION_RETENTION_MS),
  ]);
}

/** The revokes still inside the retention window; a malformed entry is dropped with a warning. */
export async function readRevocations(
  client: RevocationLogClient,
  now: number
): Promise<Revocation[]> {
  const members = await client.zrangebyscore(
    REVOCATION_LOG_KEY,
    now - REVOCATION_RETENTION_MS,
    "+inf"
  );
  const revocations: Revocation[] = [];
  for (const member of members) {
    const parsed = revocationSchema.safeParse(parseJson(member));
    if (parsed.success) {
      revocations.push(parsed.data);
    } else {
      log.warn("Realtime revocation log entry dropped", {
        event: REVOCATION_DROPPED_EVENT,
        bytes: Buffer.byteLength(member, "utf8"),
      });
    }
  }
  return revocations;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const revocationSchema = z.object({
  target: revokeTargetSchema,
  at: z.number().int().nonnegative(),
});

export const REVOCATION_DROPPED_EVENT = "realtime.revocation_dropped";
