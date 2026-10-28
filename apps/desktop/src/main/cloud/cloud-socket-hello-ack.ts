import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import type { DesktopHelloAckEvent } from "./cloud-protocol.js";
import {
  asNonEmptyString,
  asObject,
  createEnvelope,
} from "./cloud-socket-payloads.js";

/**
 * Parses server-advertised Desktop capabilities.
 */
export function parseServerCapabilities(
  value: unknown
): ComputeTargetServerCapabilities | undefined {
  const record = asObject(value);
  const parsed: ComputeTargetServerCapabilities = {};
  for (const flag of SERVER_CAPABILITY_FLAGS) {
    if (record[flag] === true) {
      parsed[flag] = true;
    }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseDesktopHelloAck(
  payload: unknown
): DesktopHelloAckEvent | null {
  const event = asObject(payload);
  const computeTargetId = asNonEmptyString(event.computeTargetId);
  if (!computeTargetId) {
    return null;
  }
  const parsedServerCapabilities = parseServerCapabilities(
    event.serverCapabilities
  );
  // ISS-9081: absent unless the sender stated one. Spread conditionally rather
  // than assigned — an omitted field and a `null` one must stay distinguishable
  // to `remember`, which falls back to today's behaviour on the former.
  const mintingApiOrigin = asNonEmptyString(event.mintingApiOrigin);

  return {
    ...createEnvelope(),
    computeTargetId,
    sessionId: asNonEmptyString(event.sessionId) ?? "",
    serverTime: asNonEmptyString(event.serverTime) ?? new Date().toISOString(),
    ...(mintingApiOrigin ? { mintingApiOrigin } : {}),
    ...(parsedServerCapabilities
      ? { serverCapabilities: parsedServerCapabilities }
      : {}),
    resumeFromSequence:
      event.resumeFromSequence && typeof event.resumeFromSequence === "object"
        ? (event.resumeFromSequence as Record<string, number>)
        : undefined,
  };
}

/**
 * Every hello-ack capability flag, as one table instead of an `if` per flag.
 *
 * Typed as a `Record` over the capability keys so a flag added to
 * `ComputeTargetServerCapabilities` fails `tsc` HERE until it is listed. The
 * per-flag `if`s this replaces could be forgotten silently, which costs the
 * desktop a capability it was told the server has.
 *
 * `computeTargetSigning` is excluded: Desktop no longer enforces command
 * signing (ISS-12784), so a server that still advertises it is ignored.
 */
const SERVER_CAPABILITY_FLAG_SET: Record<
  Exclude<keyof ComputeTargetServerCapabilities, "computeTargetSigning">,
  true
> = {
  agentSessionSync: true,
  agentSessionSyncCompression: true,
  // ISS-4541 tiling, ISS-9859 PR refs: the server merges multi-part streams.
  agentSessionSyncActivityChunking: true,
  agentSessionSyncPrRefChunking: true,
  agentSessionSyncMonitoredActivity: true,
  // ISS-5850 / ISS-7896 / ISS-9864: the server stores the span extent and the
  // whole human- and agent-turn arrays, so this lane may stamp the cursor
  // revision that claims them.
  agentSessionSyncSpanExtent: true,
  agentSessionSyncHumanTurnTimestamps: true,
  agentSessionSyncAgentTurnTimestamps: true,
  // ISS-12552: the server accepts token-event owners.
  agentSessionSyncTokenEventOwner: true,
};

const SERVER_CAPABILITY_FLAGS = Object.keys(
  SERVER_CAPABILITY_FLAG_SET
) as (keyof typeof SERVER_CAPABILITY_FLAG_SET)[];
