/**
 * ISS-8619 (PRD-699 §7.6): the ARM-INDEPENDENT column patches the detail upsert
 * spreads into both of its arms, split out of `session-slice-detail-write.ts`.
 *
 * Sibling to `upsert-arm-detail.ts`, which owns the CREATE arm's overrides: one
 * module per arm-ness, so "which arms does this column reach" is answered by
 * where the resolver lives rather than by reading the upsert object. Each one
 * here returns a PATCH — an omitted key means "leave the column alone", and for
 * every one of them that omission is the load-bearing case.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { Prisma } from "@repo/database";
import { projectNullableIndexKey } from "@/lib/index-key-projection";
import { toAttributionColumns } from "./persist-session-children";

/**
 * ISS-8069: `repository_full_name` carries its own single-column btree
 * (`@@index([repositoryFullName])`, the Sessions repository facet). The
 * remaining attribution columns are unindexed and pass through whole.
 */
export function toIndexBoundAttributionColumns(session: SyncedAgentSession) {
  const raw = toAttributionColumns(session);
  const repositoryFullNameKey = projectNullableIndexKey(raw.repositoryFullName);
  return {
    columns: { ...raw, repositoryFullName: repositoryFullNameKey.value },
    repositoryFullNameKey,
  };
}

/**
 * ISS-7516 — the `dataSyncLevel` column patch: the level when the batch carried
 * one, and NOTHING when it did not.
 *
 * The empty patch is the point. Writing `null` for an absent level would DELETE
 * a level an upgraded desktop had already recorded for this session, so the
 * column would flip between "reported" and "not reported" depending on which
 * build synced last — and the transcript panel's copy would flip with it. Leaving
 * the column alone means the newest reported level wins and nothing un-reports it.
 */
export function toDataSyncLevelPatch(level: DataSyncLevel | undefined): {
  dataSyncLevel?: DataSyncLevel;
} {
  return level === undefined ? {} : { dataSyncLevel: level };
}

/**
 * ISS-7229 — Claude's own reported cost, patched in ONLY when the payload
 * carries one.
 *
 * An OMITTED KEY, not an assigned `undefined`, and that distinction is the whole
 * contract: Prisma treats a present `undefined` as "leave alone" on an update
 * but the object shape still differs, and a plain
 * `authoritativeCostUsd: session.authoritativeCostUsd` is one refactor away from
 * becoming a `null` write. A STORED figure outlives the payload that wrote it,
 * whatever produced it (ISS-12435 backfilled the retired loop-event figures
 * into this column), so an absent field has to leave it standing. OTel capture
 * is gated on a Labs setting, so the same session can sync again from a build
 * that captured nothing, and overwriting would null what an earlier sync
 * legitimately recorded. The wire schema refuses `null` for the same reason, so there is no
 * "clear it" spelling to handle here.
 *
 * DELIVERY ORDER, not magnitude, decides a replacement. A first figure always
 * lands; once one IS stored, only a delivery the watermark calls fresh may
 * replace it, because delivery is at-least-once and the desktop re-sends only
 * when its own sum CHANGES — so a redelivered older sync would otherwise leave
 * an ended session's cost silently wrong with nothing left to correct it. An
 * earlier revision of this guard keyed on `incoming > stored` instead, and
 * magnitude is not a proxy for age: the desktop's cost upsert REPLACES `costUsd`
 * rather than summing it, so an OTel re-export carrying a corrected-LOWER figure
 * lowers the local sum and re-delivers, which a monotonic guard refuses — pinning
 * the column to a stale high number nothing can then correct, and inverting the
 * precedence this ticket exists to establish by letting the #5790 projection's
 * FALLBACK figure outrank the desktop's own measurement.
 *
 * Gated on `shouldUpdateTokenEventCosts` only to REPLACE a stored figure,
 * unlike the trace patch beside it, which takes that watermark unconditionally.
 * The watermark protects figures OUR pricing derives from token rows; this value
 * is Claude's own and carries no token dependency, so a stale-watermark session
 * must still receive its FIRST figure — hence the gate on the overwrite alone.
 *
 * Extracted (marisolashgrove on #6393) so the branch has a seam a test can hold:
 * inline, nothing pinned it, and swapping the spread for a plain assignment left
 * every suite green while the column started getting nulled on absence.
 *
 * THROUGH `Prisma.Decimal(toFixed(6))`, so the figure the guard CHECKED is the
 * figure the column RECEIVES. `canStoreAuthoritativeCostUsd` decides by rounding
 * in JS, and the raw double is a different number: `99999999.9999995` clears the
 * guard (its nearest double is …99999493…, so `toFixed(6)` gives
 * `99999999.999999`) while the value itself rounds half-up to
 * `100000000.000000` — nine integer digits, which `numeric(14, 6)` refuses with
 * 22003. Measured against a real column: that raise DOES fire when the value
 * arrives as text or as `float8`, and does NOT fire through Prisma's typed
 * Decimal path, which rounds to the field's declared scale before transmitting.
 * So the defect is latent rather than live, and this line is what keeps it that
 * way — the alternative is a guard whose correctness rests on an undocumented
 * rounding step in the client, one driver-adapter change away from raising
 * INSIDE the slice transaction, where `upsert-sessions-batch.ts` rethrows it and
 * fails the whole 200-session batch. Same canonicalization the projection writer
 * does (`authoritative-cost.ts`), for the same reason.
 */
export function toAuthoritativeCostPatch(
  session: Readonly<{ authoritativeCostUsd?: number }>,
  stored: { costUsd?: Prisma.Decimal | null; isFreshDelivery: boolean }
): { authoritativeCostUsd?: Prisma.Decimal } {
  if (session.authoritativeCostUsd === undefined) {
    return {};
  }
  if (stored.costUsd != null && !stored.isFreshDelivery) {
    return {};
  }
  return {
    authoritativeCostUsd: new Prisma.Decimal(
      session.authoritativeCostUsd.toFixed(6)
    ),
  };
}
