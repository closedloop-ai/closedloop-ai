/**
 * ISS-12251 (PLN-2176 T-6.7): the Session artifact's `created_at` from the
 * desktop's `createdAt`, the transcript file's birth time.
 *
 * The create arm writes a plausible value in place of the `now()` default, and
 * every later delivery may only move it earlier ({@link lowerSessionCreatedAt}).
 * A payload without the field (an older desktop) leaves the column alone, so it
 * keeps the first-sync time.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { AgentSessionUpsertTx } from "./records";

/** PLN-2176 T-6.7: a creation time must fall after this instant. */
const EARLIEST_PLAUSIBLE_CREATED_AT_MS = Date.UTC(2015, 0, 1);

export type IncomingSessionCreatedAt = {
  /** The value to store, or `null` when the payload offers none worth storing. */
  createdAt: Date | null;
  /** The payload carried a value that is unparseable or implausible. */
  dropped: boolean;
};

/**
 * Plausible means after 2015-01-01 and not after `syncTimestamp`, the bounds
 * PLN-2176 T-6.7 names. Anything else is dropped, never stored or clamped.
 */
export function resolveIncomingSessionCreatedAt(
  raw: string | undefined,
  syncTimestamp: Date
): IncomingSessionCreatedAt {
  if (raw === undefined) {
    return { createdAt: null, dropped: false };
  }
  const ms = Date.parse(raw);
  if (
    Number.isFinite(ms) &&
    ms > EARLIEST_PLAUSIBLE_CREATED_AT_MS &&
    ms <= syncTimestamp.getTime()
  ) {
    return { createdAt: new Date(ms), dropped: false };
  }
  return { createdAt: null, dropped: true };
}

/**
 * Min-wins: moves the artifact's `created_at` to `incoming` only while the
 * stored value is later. The predicate is the guard, so a concurrent writer
 * cannot be overwritten with a later value; `committed` (the upsert's
 * read-back) only skips the statement when there is nothing to lower.
 */
export async function lowerSessionCreatedAt(
  tx: AgentSessionUpsertTx,
  row: Readonly<{
    organizationId: string;
    artifactId: string;
    incoming: Date | null;
    committed: Date;
  }>
): Promise<void> {
  if (row.incoming === null || row.committed <= row.incoming) {
    return;
  }
  await tx.artifact.updateMany({
    where: {
      organizationId: row.organizationId,
      id: row.artifactId,
      type: ArtifactType.Session,
      createdAt: { gt: row.incoming },
    },
    data: { createdAt: row.incoming },
  });
}
