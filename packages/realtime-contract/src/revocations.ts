import { parseChannelAddress } from "./channels";
import type { RevokeTarget } from "./internal";
import { REALTIME_TOKEN_TTL_SECONDS, type RealtimeTokenClaims } from "./token";

/** A revoke and when it was taken, epoch milliseconds. */
export type Revocation = { target: RevokeTarget; at: number };

/**
 * The revokes this instance knows of. A revoke binds every token issued at or
 * before it: a socket holding such a token may not keep or rejoin a channel
 * the revoke covers, and a new connection presenting one may not join it
 * either. A token issued after the revoke is `apps/api`'s fresh decision and
 * is not bound.
 */
export type Revocations = {
  record(revocation: Revocation): void;
  covers(
    claims: Pick<RealtimeTokenClaims, "sub" | "iat">,
    channel: string
  ): boolean;
};

/**
 * Every token a revoke binds has expired once the token lifetime has passed,
 * and an expired token is disconnected, so a revoke is dropped after that.
 */
export const REVOCATION_RETENTION_MS = REALTIME_TOKEN_TTL_SECONDS * 1000;

export function createRevocations(now: () => number = Date.now): Revocations {
  const latestByTarget = new Map<string, number>();
  let nextSweepAt = 0;

  const liveAt = (key: string): number | undefined => {
    const at = latestByTarget.get(key);
    if (at === undefined || now() < at + REVOCATION_RETENTION_MS) {
      return at;
    }
    latestByTarget.delete(key);
    return undefined;
  };

  const sweep = (): void => {
    const current = now();
    if (current < nextSweepAt) {
      return;
    }
    nextSweepAt = current + SWEEP_INTERVAL_MS;
    for (const [key, at] of latestByTarget) {
      if (current >= at + REVOCATION_RETENTION_MS) {
        latestByTarget.delete(key);
      }
    }
  };

  return {
    record({ target, at }) {
      sweep();
      const key = targetKey(target);
      const known = latestByTarget.get(key);
      if (known === undefined || known < at) {
        latestByTarget.set(key, at);
      }
    },
    covers(claims, channel) {
      const issuedAtMs = claims.iat * 1000;
      const keys = [targetKey({ userId: claims.sub }), targetKey({ channel })];
      const orgId = parseChannelAddress(channel)?.orgId;
      if (orgId !== undefined) {
        keys.push(targetKey({ orgId }));
      }
      return keys.some((key) => {
        const at = liveAt(key);
        return at !== undefined && issuedAtMs <= at;
      });
    },
  };
}

function targetKey(target: RevokeTarget): string {
  if ("userId" in target) {
    return `user|${target.userId}`;
  }
  if ("channel" in target) {
    return `channel|${target.channel}`;
  }
  return `org|${target.orgId}`;
}

const SWEEP_INTERVAL_MS = 60_000;
