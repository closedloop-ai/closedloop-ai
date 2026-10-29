/**
 * @file write-core-session-created-at.ts
 * @description ISS-12251 (PLN-2176 T-6.4): the value the import writes to
 * `sessions.created_at`, and how a re-import merges it into a stored one.
 */
import type { NormalizedSession } from "../collectors/types.js";
import type { Prisma } from "./generated/client.js";
import { enqueueCreatedAtResyncInTx } from "./session-created-at-sync-obligation.js";

/** The last instant `toISOString()` renders as a four-digit year. */
const MAX_FOUR_DIGIT_YEAR_MS = Date.parse("9999-12-31T23:59:59.999Z");

/**
 * The value the import writes to `sessions.created_at` and where it came from:
 * the transcript's birth time (`fromFile`), or the `startedAt` fallback.
 */
export type ImportedSessionCreatedAt =
  | { value: string; fromFile: true }
  | { value: string | null; fromFile: false };

/**
 * Canonical ISO UTC of `fileCreatedAt ?? startedAt`, with `value: null` when
 * neither is a usable instant. A `fileCreatedAt` that is not a usable birth
 * time is treated as absent, as its producer (`fileCreatedAtFromStats`) treats
 * one. Usable means after the epoch and within the four-digit-year range, so
 * every stored value is the same fixed-width form.
 */
export function importedSessionCreatedAt(
  session: Pick<NormalizedSession, "fileCreatedAt" | "startedAt">
): ImportedSessionCreatedAt {
  const fromFile = usableInstantIso(session.fileCreatedAt);
  if (fromFile !== null) {
    return { value: fromFile, fromFile: true };
  }
  return {
    value:
      session.startedAt == null
        ? null
        : usableInstantIso(Date.parse(session.startedAt)),
    fromFile: false,
  };
}

/**
 * "Created is always the file's creation time; never compared to mtime or
 * startedAt" (operator ruling, 2026-10-14). A NULL stored value, or one that
 * does not parse (only canonical `toISOString()` is ever written, so it is
 * corrupt), takes either incoming value. Otherwise only a birth time moves it,
 * and only ever lowers it, so a re-import of a later-copied transcript never
 * raises it. The `startedAt` fallback never changes a stored instant. Compared
 * as instants.
 */
export function mergeSessionCreatedAt(
  stored: string | null,
  incoming: ImportedSessionCreatedAt
): string | null {
  if (incoming.value === null) {
    return stored;
  }
  const storedMs = stored === null ? Number.NaN : Date.parse(stored);
  if (!Number.isFinite(storedMs)) {
    return incoming.value;
  }
  if (!incoming.fromFile) {
    return stored;
  }
  return Date.parse(incoming.value) < storedMs ? incoming.value : stored;
}

/**
 * Writes `created_at` on a re-import whose content gate did not fire (the
 * content UPDATE carries it otherwise), and records on the same transaction
 * that the row owes the cloud a re-send. `updated_at` is left alone: on Desktop
 * it is the record-mutation clock the Updated column and its sort read, so a
 * `created_at`-only change must not move it, and without that bump nothing else
 * re-selects the row. Sharing the transaction is what keeps an interrupted
 * rebuild pass or a crash from committing the value without the re-send, on the
 * rebuild and on an ordinary import alike.
 */
export async function writeImportedSessionCreatedAt(
  tx: Pick<Prisma.TransactionClient, "$executeRawUnsafe" | "$queryRawUnsafe">,
  args: { sessionId: string; createdAt: string; now: string }
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET created_at = $1 WHERE id = $2",
    args.createdAt,
    args.sessionId
  );
  await enqueueCreatedAtResyncInTx(tx, {
    sessionId: args.sessionId,
    now: args.now,
  });
}

function usableInstantIso(ms: number | undefined): string | null {
  if (
    ms === undefined ||
    !Number.isFinite(ms) ||
    ms <= 0 ||
    ms > MAX_FOUR_DIGIT_YEAR_MS
  ) {
    return null;
  }
  return new Date(ms).toISOString();
}
