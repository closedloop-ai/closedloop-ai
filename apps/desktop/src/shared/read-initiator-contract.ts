import { ReadInitiator } from "@repo/api/src/types/read-initiator";

/**
 * ISS-12039: carry a read's {@link ReadInitiator} across the IPC bridge as
 * transport metadata, on the ISS-9802 `cancellationToken` precedent. The request
 * schemas do not model the key and strip it, and an older main ignores it.
 */
export type SharedAgentSessionReadOptions = { readInitiator?: ReadInitiator };

/**
 * Stamp the initiator on a read request, or hand the request back untouched.
 * Omission, never `undefined`: a caller that has no initiator sends the request
 * it always sent.
 */
export function withReadInitiator<TRequest extends object>(
  request: TRequest,
  readInitiator: ReadInitiator | undefined
): TRequest {
  return readInitiator === undefined ? request : { ...request, readInitiator };
}

/**
 * The initiator an untrusted IPC payload declares. An absent key (an older
 * renderer) or an unknown value reads as `undefined`, never as an error.
 */
export function requestReadInitiator(
  payload: unknown
): ReadInitiator | undefined {
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  const value = (payload as { readInitiator?: unknown }).readInitiator;
  return Object.values(ReadInitiator).find((initiator) => initiator === value);
}
