import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import {
  clampTimerDelayMs,
  type TimerDelayRejectionSink,
} from "@repo/shared-platform/parse-env-ms";

/**
 * The idempotency fingerprint of a desktop command: a stable hash of the
 * PERSISTABLE half of the request, used to decide whether a repeated
 * `Idempotency-Key` describes the same command or a colliding one.
 *
 * Split out of `desktop-command-store.ts` (ISS-6322) with
 * {@link stripTransientCommandFields}, because together they are the store's
 * only pure, crypto-shaped concern — no database, no transaction, no event
 * publishing — and they are the sole reason that module imported `node:crypto`
 * and `stableStringify`.
 */
export function fingerprintCommand(input: CreateDesktopCommandInput): string {
  return createHash("sha256")
    .update(stableStringify(stripTransientCommandFields(input)))
    .digest("hex");
}

/**
 * The command minus the fields that legitimately differ between two attempts at
 * the SAME command, and that is the whole contract: `commandId` is assigned per
 * attempt and the three signature fields are minted per attempt over a nonce, so
 * leaving any of them in would make two genuinely identical retries fingerprint
 * differently and defeat idempotency. Also the shape persisted as
 * `requestPayload`, so a per-attempt signature is never stored.
 */
export function stripTransientCommandFields(
  input: CreateDesktopCommandInput
): CreateDesktopCommandInput {
  const {
    commandId: _commandId,
    signature: _signature,
    signaturePayload: _signaturePayload,
    publicKeyFingerprint: _publicKeyFingerprint,
    ...persistable
  } = input;
  return persistable;
}

/**
 * The command with `timeoutMs` clamped to what a Node timer can honour, or the
 * field omitted when the value carries no usable timeout at all.
 *
 * Belongs at store ingress, BEFORE the fingerprint and the write, because the
 * timeout is part of the persisted `requestPayload` and therefore part of the
 * idempotency hash. The REST route's validator bounds the field `.positive()`
 * with no ceiling while the relay mapper clamps, so without this the SAME
 * effective timeout hashes differently depending on which transport it arrived
 * on, and a retry raises a false `IdempotencyConflictError`. Normalizing here
 * keeps one value in the column and one hash over it (ISS-8233).
 *
 * The field is DELETED rather than set to `undefined` when it is dropped, so
 * `stableStringify` sees the same shape as a request that never sent it.
 */
export function normalizeCommandInput(
  input: CreateDesktopCommandInput,
  onRejected?: TimerDelayRejectionSink
): CreateDesktopCommandInput {
  if (input.timeoutMs === undefined) {
    return input;
  }
  const timeoutMs = clampTimerDelayMs(input.timeoutMs, onRejected);
  if (timeoutMs === input.timeoutMs) {
    return input;
  }
  if (timeoutMs === undefined) {
    const { timeoutMs: _dropped, ...rest } = input;
    return rest;
  }
  return { ...input, timeoutMs };
}
