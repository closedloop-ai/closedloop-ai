import { withDb } from "@repo/database";
import { BoundedMap } from "@repo/lib/bounded-map";
import { log } from "@repo/observability/log";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import {
  STORED_COMMAND_SELECT,
  type StoredCommand,
  toStoredCommand,
} from "@/lib/desktop-command-mappers";

/**
 * Resolving an EXISTING `desktop_commands` row — by id, by target-scoped id, or
 * by idempotency key — plus the dedupe cache and the conflict error that
 * resolution raises.
 *
 * Extracted from `desktop-command-store` so that module stays the write and
 * event-stream orchestration surface. The two idempotent resolvers are the only
 * readers of the cache, and both of the store's create paths reach an existing
 * command exclusively through them, so cache and resolvers travel together.
 */

export type CreateCommandResult = {
  command: StoredCommand;
  deduped: boolean;
};

type IdempotencyEntry = {
  commandId: string;
  fingerprint: string;
};

export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key collision with different payload") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

const CACHE_MAX_SIZE = 10_000;

const idempotencyCache = new BoundedMap<string, IdempotencyEntry>(
  CACHE_MAX_SIZE
);

/**
 * Record a freshly created command against its idempotency key, so the next
 * retry short-circuits in `resolveIdempotentCommand` without a database read.
 * Named rather than exporting the cache.
 */
export function rememberIdempotentCommand(
  computeTargetId: string,
  idempotencyKey: string,
  commandId: string,
  fingerprint: string
): void {
  idempotencyCache.set(`${computeTargetId}:${idempotencyKey}`, {
    commandId,
    fingerprint,
  });
}

export function clearIdempotencyCache(): void {
  idempotencyCache.clear();
}

export async function findCommandById(
  commandId: string
): Promise<StoredCommand | null> {
  const command = await withDb((db) =>
    db.desktopCommand.findUnique({
      where: { id: commandId },
      select: STORED_COMMAND_SELECT,
    })
  );
  if (!command) {
    return null;
  }
  return toStoredCommand(command);
}

export async function findCommandByIdScoped(
  commandId: string,
  computeTargetId?: string
): Promise<StoredCommand | null> {
  if (!computeTargetId) {
    return findCommandById(commandId);
  }
  const row = await withDb((db) =>
    db.desktopCommand.findFirst({
      where: { id: commandId, computeTargetId },
      select: STORED_COMMAND_SELECT,
    })
  );
  return row ? toStoredCommand(row) : null;
}

export async function recoverDuplicateCommand(
  computeTargetId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<CreateCommandResult> {
  const winner = await withDb((db) =>
    db.desktopCommand.findFirst({
      where: { computeTargetId, idempotencyKey },
      orderBy: { createdAt: "desc" },
      select: STORED_COMMAND_SELECT,
    })
  );
  if (!winner) {
    log.warn("recoverDuplicateCommand: no winner found for idempotency key", {
      computeTargetId,
      idempotencyKey,
      errorClass: ErrorClass.Protocol,
    });
    throw new IdempotencyConflictError();
  }
  const winnerCommand = toStoredCommand(winner);
  if (winnerCommand.requestFingerprint !== fingerprint) {
    log.warn(
      "recoverDuplicateCommand: fingerprint mismatch on idempotency key",
      {
        computeTargetId,
        idempotencyKey,
        errorClass: ErrorClass.Protocol,
      }
    );
    throw new IdempotencyConflictError();
  }
  return { command: winnerCommand, deduped: true };
}

export async function resolveIdempotentCommand(
  computeTargetId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<CreateCommandResult | null> {
  const cacheKey = `${computeTargetId}:${idempotencyKey}`;
  const cached = idempotencyCache.get(cacheKey);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      log.warn(
        "resolveIdempotentCommand: cache fingerprint mismatch on idempotency key",
        {
          computeTargetId,
          idempotencyKey,
          errorClass: ErrorClass.Protocol,
        }
      );
      throw new IdempotencyConflictError();
    }
    const existing = await findCommandById(cached.commandId);
    if (existing) {
      return { command: existing, deduped: true };
    }
  }

  const existing = await withDb((db) =>
    db.desktopCommand.findFirst({
      where: { computeTargetId, idempotencyKey },
      orderBy: { createdAt: "desc" },
      select: STORED_COMMAND_SELECT,
    })
  );

  if (!existing) {
    return null;
  }

  const existingCommand = toStoredCommand(existing);
  if (existingCommand.requestFingerprint !== fingerprint) {
    log.warn(
      "resolveIdempotentCommand: db fingerprint mismatch on idempotency key",
      {
        computeTargetId,
        idempotencyKey,
        errorClass: ErrorClass.Protocol,
      }
    );
    throw new IdempotencyConflictError();
  }
  idempotencyCache.set(cacheKey, {
    commandId: existingCommand.commandId,
    fingerprint,
  });
  return { command: existingCommand, deduped: true };
}
