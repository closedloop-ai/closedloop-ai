import "server-only";

import type { ComponentSourceProvenance } from "@repo/api/src/types/component-source";
import {
  SYNCED_COMPONENT_VARIANTS_MAX,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import type { withDb } from "@repo/database";
import {
  type ComponentVersionHistory,
  getVersionsForComponent,
} from "../../definition-registry/service";

/**
 * @file detail-version-history.ts
 * @description The agent-components detail read's version-history lane: its own
 * row bound, the bounded read, and the ISS-5029 "this history is partial" fold.
 *
 * Extracted from `detail-read.ts` (ISS-5029) — that module is a grandfathered
 * over-size composition root, and this is one cohesive concern ("what revisions
 * does the detail show, and does it show all of them"), so it moves out rather
 * than pushing the root further past the ceiling.
 */

/**
 * Hard cap on the number of full-content version-history rows the detail endpoint
 * materializes (FEA-2923 review). Each `agent_component_versions.content` body can
 * be up to the per-component sync cap (256 KiB), so an unbounded — or loosely
 * bounded — history bloats the detail response: at the previous `take: 50` a
 * pathological component could ship ~12 MB of revision bodies in one payload,
 * though the Prompt panel only renders one revision at a time. 20 revisions keeps
 * the version selector's history deep while bounding the worst-case payload to
 * ~5 MB. The rows are ordered newest-first, so the cap deterministically drops the
 * oldest revisions rather than truncating arbitrarily — and since ISS-5029 the
 * read reports when it did.
 */
export const MAX_COMPONENT_VERSION_ROWS = 20;

/**
 * Content-hash version history (FEA-2923), newest-first and bounded.
 *
 * F1 (FEA-3290, Slice 6): delegates to the definition-registry read so each
 * revision is joined to its exact provenance-free `DefinitionVersion` and
 * carries `definitionHash`/`normalizerContractVersion` **once linked**. During
 * the pre-backfill window a still-unlinked revision is UNION-fallback preserved
 * (surfaced by its legacy `hash`/`content` alone) so no version disappears. The
 * shipped Prompt-panel selector keys off `hash`, so the F1 fields are purely
 * additive. Org-scoping (AC-019) is enforced inside the registry read — the
 * `organizationId` participates in the `where` there.
 *
 * FEA-4335 / #4391: `keys` is the identity's COMPLETE normalized name set, so a
 * revision attached under an alternate name of the same content is neither
 * omitted from the selector nor invisible to the `truncated` probe.
 */
export function loadComponentVersionHistory(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  keys: readonly string[],
  currentHash: string | null,
  /**
   * ISS-6232: the identity's captured provenance, passed straight through so
   * every revision reports a real `source` instead of the stored `""` sentinel.
   */
  provenance: ComponentSourceProvenance
): Promise<ComponentVersionHistory> {
  return getVersionsForComponent(
    db,
    organizationId,
    kind,
    keys,
    currentHash,
    MAX_COMPONENT_VERSION_ROWS,
    provenance
  );
}

/**
 * ISS-5029 — the detail DTO's `versionsTruncated` field, or nothing.
 *
 * The field claims `versions` is PARTIAL, so it is emitted only when that is
 * PROVABLE from this response. Two independent grounds, either sufficient:
 *
 * 1. **This read's own {@link MAX_COMPONENT_VERSION_ROWS} bound.** Reported by
 *    the query whose `take` bound, never by comparing a result length against a
 *    cap — that comparison is wrong whenever dedupe, a UNION fallback, or a
 *    family boundary changes the count (the ISS-4797/4799 lesson, PR #4354).
 *
 * 2. **A device could not ship everything it holds AND the cloud demonstrably
 *    has less than that device could have sent.** A device's
 *    `variantsTruncated` alone is NOT sufficient, and treating it as sufficient
 *    was wrong: the desktop's `agent_component_versions` is append-only (no
 *    prune exists), so a definition edited more than
 *    `SYNCED_COMPONENT_VARIANTS_MAX + 1` times leaves that device's per-family
 *    cap bound on EVERY subsequent sync — while the cloud, which accumulates the
 *    union of every subset ever shipped, may by then hold the complete history.
 *    A bare OR therefore printed "this history is incomplete" over a provably
 *    complete list, forever (closedloop-ai review, ISS-5029).
 *
 *    The sound test: one sync can carry at most
 *    `SYNCED_COMPONENT_VARIANTS_MAX + 1` revisions of a family (the variants cap
 *    plus the primary). So when a device reports it holds MORE than it shipped
 *    and the cloud's whole stored family is at or under that ceiling, the cloud
 *    is provably missing at least one revision. Above the ceiling the cloud has
 *    caught up across syncs and nothing is provable, so the marker stays silent.
 *
 *    That ceiling argument only holds for the cap it is derived FROM, and the
 *    device has two (wongk, #4391). A per-family cap — the packer's SQL rank cap
 *    or its entry cap — cannot bind unless the family holds more revisions than
 *    one sync can carry, which is precisely the lower bound the ceiling
 *    compares against. The per-component BYTE BUDGET has no such property: a
 *    component with large bodies can stop at two shipped revisions on every
 *    sync, so the device reports truncation forever while the stored count sits
 *    far under the ceiling and the cloud may already hold everything —
 *    reproducing the same false positive one cap over. So the proof requires the
 *    reason to be {@link SyncedComponentVariantsTruncatedReason.FamilyCap};
 *    `byte_budget`, an unrecognized reason from a newer desktop, and a missing
 *    reason are all treated as no proof, which degrades to today's rendering.
 *
 *    `history.versions.length` is the cloud's COMPLETE stored count here, not a
 *    capped page: this branch is only reached when `history.truncated` is false,
 *    which is itself reported by the read's own bound rather than inferred. That
 *    is what keeps this a reconciliation of two independently-derived facts
 *    rather than the length-vs-cap inference rule 1 forbids.
 *
 *    Both sides of that reconciliation must name the SAME families, or it
 *    compares a cap on family B against a count for family A (closedloop-ai-
 *    stage, #4391). Two changes hold that line. The count now spans the
 *    identity's whole normalized name set, because a content-hash identity can
 *    span several names (the same bytes installed twice — FEA-4335) and reading
 *    one name under-read it. And the device rows are filtered to that same
 *    `scopedKeys` set, because the inventory predicate for a content-hash
 *    identity is `contentHash IN (…)` and can therefore select a row whose name
 *    carries no revision at all — a family the count cannot see. Either mismatch
 *    on its own makes `storedFitsOneSync` hold spuriously and prints partiality
 *    over a complete list.
 *
 *    The ceiling stays sound across a multi-name set: if the union across names
 *    is at or under the one-sync ceiling then every individual family is too, so
 *    a device that capped any one of them still proves the cloud is short at
 *    least one revision of that family.
 *
 * Both grounds are one-directional: they can only fail to prove partiality, never
 * assert it wrongly. A device row this detail's identity scope did not select, or
 * one selected under a name the count carries no revisions for, simply does not
 * contribute — a false NEGATIVE, which degrades to today's rendering, and never a
 * false claim of incompleteness.
 *
 * Returns an EMPTY object when nothing is provable, so the field is omitted
 * rather than serialized as `false`: a version-skewed reader then sees exactly
 * today's payload, and "absent" unambiguously means "no evidence of truncation".
 */
export function emitVersionsTruncated(
  history: ComponentVersionHistory,
  inventoryRows: readonly DeviceTruncationRow[],
  scopedKeys: readonly string[]
): { versionsTruncated?: true } {
  if (history.truncated) {
    return { versionsTruncated: true };
  }
  const countedFamilies = new Set(
    scopedKeys.map((scopedKey) => scopedKey.toLowerCase().trim())
  );
  const deviceTruncated = inventoryRows.some(
    (row) => provesDeviceHeldMore(row) && isCountedFamily(row, countedFamilies)
  );
  const storedFitsOneSync =
    history.versions.length <= MAX_REVISIONS_PER_FAMILY_PER_SYNC;
  return deviceTruncated && storedFitsOneSync
    ? { versionsTruncated: true }
    : {};
}

/**
 * ISS-5029: the most revisions of one family a single sync can carry — the
 * variants cap plus the one primary revision that rides as
 * `content`/`contentHash`. Mirrors `VERSION_CANDIDATES_PER_FAMILY` in the desktop
 * packer, which is the same arithmetic on the same shared constant.
 *
 * Used as the ceiling below which a truncating device proves the cloud is
 * missing something. Derived from the shared constant rather than restated, so a
 * change to the cap cannot leave the two sides disagreeing.
 */
const MAX_REVISIONS_PER_FAMILY_PER_SYNC = SYNCED_COMPONENT_VARIANTS_MAX + 1;

/**
 * The inventory-row fields {@link emitVersionsTruncated} reconciles: the device's
 * own truncation report plus the name that report is ABOUT. Falls back to `name`
 * when `componentKey` is absent, mirroring the name-level inventory predicate
 * (FEA-3750) so an event-minted row resolves the same way here as it does there.
 */
type DeviceTruncationRow = {
  variantsTruncated: boolean;
  /**
   * ISS-5029 (wongk, #4391): which cap bound. Reconciled, not just read — see
   * {@link provesDeviceHeldMore}.
   */
  variantsTruncatedReason: string | null;
  componentKey: string | null;
  name: string | null;
};

/**
 * The name set the detail's version history is read — and reconciled — over.
 *
 * `content-hash-identity.ts` names version history among the reads that "scope
 * usage across EVERY name that shares the content", so the identity's whole
 * normalized key set is the scope, not its primary representative (#4391).
 * `keys` is `[key]` for a legacy name key, leaving that path unchanged; the
 * fallback only covers a degenerate empty set.
 */
export function resolveVersionScopeKeys(
  keys: readonly string[],
  primaryKey: string
): readonly string[] {
  return keys.length > 0 ? keys : [primaryKey];
}

/**
 * Does this device row report on one of the families the stored count was
 * actually read over? Case-insensitively, because an event-minted row stores the
 * raw-case subagent type (`Explore`) while the read keys are normalized.
 */
function isCountedFamily(
  row: DeviceTruncationRow,
  countedFamilies: ReadonlySet<string>
): boolean {
  const rowKey = (row.componentKey ?? row.name ?? "").toLowerCase().trim();
  return rowKey.length > 0 && countedFamilies.has(rowKey);
}

/**
 * ISS-5029 (wongk, #4391): does this device row put a LOWER BOUND on how many
 * revisions the device holds — the thing the one-sync ceiling is compared
 * against?
 *
 * Only a per-family cap does. It cannot bind unless the family holds more
 * revisions than a single sync can carry, so a stored count at or under the
 * ceiling is provably short of that device.
 *
 * A `byte_budget` stop does not, and this is the whole reason the reason exists:
 * a component with large definition bodies can stop at two shipped revisions on
 * every sync forever, while the cloud — which accumulates the union of every
 * subset ever shipped — may already hold the complete history. The stored count
 * stays far under the ceiling the entire time, so the ceiling test would fire
 * over a complete list.
 *
 * An absent or unrecognized reason is treated the same as `byte_budget`: no
 * proof. That is the safe direction (a false NEGATIVE degrades to today's
 * rendering) and it is what lets the wire field stay an unconstrained string, so
 * a reason a newer desktop introduces never rejects a batch or invents a claim.
 */
function provesDeviceHeldMore(row: DeviceTruncationRow): boolean {
  return (
    row.variantsTruncated &&
    row.variantsTruncatedReason ===
      SyncedComponentVariantsTruncatedReason.FamilyCap
  );
}
