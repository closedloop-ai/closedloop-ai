import {
  DesktopClientAttributionHeader,
  DesktopUpdaterRingHeader,
  parseDesktopUpdaterComputeTargetId,
} from "@repo/api/src/types/desktop-client-attribution";
import { DesktopReleaseRing } from "@repo/api/src/types/desktop-release";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { env } from "@/env";

/**
 * How long an id the database does not know stays known-unknown.
 *
 * The route is unauthenticated, so without this a caller could point it at
 * arbitrary UUIDs and turn one poll into one indexed read each. The existing
 * `consumeDesktopUpdaterRateLimit` bounds the request rate first; this dedupes
 * the database cost of the requests that get through. Short enough that a target
 * registered a moment ago is ringed on its next poll rather than in an hour.
 *
 * PER INSTANCE, not global. `apps/api` is on Vercel serverless, so this map and
 * the rate limiter beside it are both process-local: every warm instance pays
 * its own first read for the same id. The true ceiling is instances × the rate
 * limiter's allowance, and these routes issued NO database reads before ISS-9164
 * — so if production usage approaches that, the cache belongs in a shared store
 * rather than here.
 */
const UnknownComputeTargetTtlMs = 5 * 60_000;

/**
 * Hard ceiling on the negative cache, evicting oldest-first.
 *
 * Every key comes from an unauthenticated request, so the TTL alone is not a
 * bound — a burst inside one window would grow the map without limit. Matched to
 * `DesktopUpdaterRateLimitMaxEntries` for the same reason it exists.
 */
export const UnknownComputeTargetMaxEntries = 2000;

/** Applied to a ringed response, which is per-install and must not be shared-cached. */
export const DesktopUpdaterPerInstallCacheControl = "private, max-age=60";

export type DesktopUpdaterRingResolution = {
  ring: DesktopReleaseRing;
  /**
   * Whether the request named a compute target at all.
   *
   * Separate from `ring` because it answers a different question: `ring` says
   * which channel to serve, this says whether the answer was computed FOR THIS
   * INSTALL and therefore may not sit in a shared cache. A request with no header
   * — an install predating ISS-9164, a singleplayer client, a malformed value —
   * resolves to `general` and is not per-install, so it keeps the public feed's
   * shared-cache entry exactly as it does today.
   */
  perInstall: boolean;
};

/** Compute-target id → expiry, for ids the database has told us do not exist. */
const unknownComputeTargets = new Map<string, number>();

export const desktopUpdaterRingService = {
  /**
   * Resolve the release ring for one updater request.
   *
   * Fails safe at every step: an absent, malformed, or unknown compute-target id
   * and any database failure all resolve to `general`. The one thing this must
   * never do is fail the request — a packaged client cannot be told to stop
   * polling, and every ring serves the same channel in D0 anyway.
   */
  async resolveRing(request: Request): Promise<DesktopUpdaterRingResolution> {
    const computeTargetId = parseDesktopUpdaterComputeTargetId(request.headers);
    if (computeTargetId === undefined) {
      return { ring: DesktopReleaseRing.General, perInstall: false };
    }
    return {
      ring: await resolveRingForComputeTarget(computeTargetId),
      perInstall: true,
    };
  },
};

/** The ring and `Vary` headers every updater response carries, ringed or not. */
export function desktopUpdaterRingHeaders(
  resolution: DesktopUpdaterRingResolution
): Record<string, string> {
  return {
    [DesktopUpdaterRingHeader]: resolution.ring,
    // Without this a CDN holding the public (unringed) feed would answer a
    // header-bearing request from that entry, which is harmless while both rings
    // serve one channel and is exactly the D1 defect once they do not.
    Vary: DesktopClientAttributionHeader.ComputeTargetId,
  };
}

/** Test-only reset, so one case's negative cache cannot decide another's. */
export function resetDesktopUpdaterRingCacheForTests(): void {
  unknownComputeTargets.clear();
}

async function resolveRingForComputeTarget(
  computeTargetId: string
): Promise<DesktopReleaseRing> {
  // whitlockk, #6867: normalized ONCE, at the top, so every keyed read below agrees
  // on what one id is. `z.uuid()` accepts either casing and Postgres compares
  // `uuid` case-insensitively, so the raw header value is not a stable key: an
  // unauthenticated caller alternating the case of a single unknown id would
  // miss the negative cache on every poll and buy an indexed read each time —
  // the exact database cost that cache exists to dedupe.
  const targetId = normalizeRingIdentifier(computeTargetId);
  if (internalRingAllowList(env.DESKTOP_INTERNAL_RING_TARGETS).has(targetId)) {
    return DesktopReleaseRing.Internal;
  }
  const now = Date.now();
  if (isKnownUnknownComputeTarget(targetId, now)) {
    return DesktopReleaseRing.General;
  }
  try {
    const computeTarget = await withDb((db) =>
      db.computeTarget.findUnique({
        where: { id: targetId },
        select: { organizationId: true },
      })
    );
    if (computeTarget === null) {
      rememberUnknownComputeTarget(targetId, now);
      return DesktopReleaseRing.General;
    }
    return internalRingAllowList(env.DESKTOP_INTERNAL_RING_ORGANIZATIONS).has(
      normalizeRingIdentifier(computeTarget.organizationId)
    )
      ? DesktopReleaseRing.Internal
      : DesktopReleaseRing.General;
  } catch (error) {
    // Never the id itself: it identifies an install and an organisation, and this
    // is the one route that reads it with no session behind it.
    log.warn("[desktop/updates] Ring lookup failed; serving the general ring", {
      error: parseError(error),
    });
    return DesktopReleaseRing.General;
  }
}

/**
 * Parse a comma-separated allow-list.
 *
 * Re-parsed per request rather than resolved once at module scope: the string is
 * short, and a module-level constant would freeze whichever value `env` held when
 * this module was first imported.
 */
function internalRingAllowList(raw: string | undefined): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeRingIdentifier(entry))
      .filter((entry) => entry.length > 0)
  );
}

/**
 * Trim and case-fold one allow-list or database identifier.
 *
 * Both sides go through this, which is the point: a UUID is hex, `z.uuid()`
 * accepts either casing, and Postgres compares `uuid` values case-insensitively —
 * so an allow-list entry that differs from the stored row only in case would
 * otherwise be a silent non-match rather than an error.
 */
function normalizeRingIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function isKnownUnknownComputeTarget(
  computeTargetId: string,
  now: number
): boolean {
  const expiresAt = unknownComputeTargets.get(computeTargetId);
  if (expiresAt === undefined) {
    return false;
  }
  if (now >= expiresAt) {
    unknownComputeTargets.delete(computeTargetId);
    return false;
  }
  return true;
}

function rememberUnknownComputeTarget(
  computeTargetId: string,
  now: number
): void {
  // Memory hygiene only, and deliberately NOT behaviourally observable: the
  // read-side expiry delete in `isKnownUnknownComputeTarget` already decides
  // correctness, so a caller cannot tell whether this ran. Its job is to reclaim
  // entries nothing looks up again — a scan's worth of one-shot ids — instead of
  // holding them until the size cap evicts them. A test asserting read counts
  // cannot pin it; one was written, proved unfailable, and removed.
  for (const [id, expiresAt] of unknownComputeTargets) {
    if (now >= expiresAt) {
      unknownComputeTargets.delete(id);
    }
  }
  unknownComputeTargets.set(computeTargetId, now + UnknownComputeTargetTtlMs);
  while (unknownComputeTargets.size > UnknownComputeTargetMaxEntries) {
    const oldest = unknownComputeTargets.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    unknownComputeTargets.delete(oldest);
  }
}
