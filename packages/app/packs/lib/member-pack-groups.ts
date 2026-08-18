/**
 * Member by-source grouping for the web-member Packs treatment (FEA-4089).
 *
 * The member surface is not a flat marketplace grid: it must tell an honest
 * story about *where each pack came from*. This module folds the shared
 * `PackView[]` the surface already loads into three source-truthful groups —
 * Required, Installed, Available — deriving each installed pack's provenance
 * from the canonical {@link InstallSource} contract (FEA-4090,
 * `packages/api/src/types/install-source.ts`), never from a hand-rolled source
 * string.
 *
 * The mapping is pure so it is unit-testable without a render, and it follows
 * the FEA-4088 Parker principle the sibling admin treatment set: the UI must not
 * lie. In particular a *required* pack whose push failed on this member's
 * machine is surfaced as an honest strand row inside the Required group
 * ("Required, install failed"), not silently dropped — a missing required pack
 * would read as "you don't have this", which is the opposite of the truth.
 *
 * ## Source derivation, and what "required" means here
 *
 * There is no mandatoriness signal on the wire yet: `DistributionMode` has only
 * `auto_install` and `opt_in`, and no producer stamps
 * {@link InstallOrigin.Required} (see the install-source contract). So a member
 * cannot *remove* an `auto_install` pack their org pushed — from the member's
 * seat an `auto_install` distribution IS the non-removable, required set. This
 * module therefore groups a pack whose resolved source is `pushed` or `required`
 * into {@link MemberPackGroup.Required}, and keeps the resolved source verbatim
 * on the row so the label still reads the honest "Auto-installed" / "Required"
 * word. `opted-in` (org-blessed) and `self` land in the Installed group; a pack
 * the member does not have installed and is not required for them is Available.
 *
 * The per-member install/target state (installed-here, failed-here) rides on the
 * pack's admin `PackDistribution.targets` when a detail read populated them;
 * absent that (the list read carries no per-target rows), the grouping degrades
 * gracefully — a `pushed` pack with no per-target failure is shown as installed,
 * not invented as failed. Dispatch mechanics (actually installing/uninstalling
 * from the web) are out of scope here and deferred to FEA-4071 / FEA-4082; this
 * slice is the treatment + source honesty.
 */

import {
  DistributionMode,
  DistributionTargetingType,
  type DistributionTargetStatusValue,
  DistributionTargetStatusValue as TargetStatus,
} from "@repo/api/src/types/distribution";
import {
  InstallSource,
  resolveInstallSource,
} from "@repo/api/src/types/install-source";
import type { PackDistribution, PackView } from "./pack-view";

/**
 * The three member-facing groups, in render order. Required leads (the packs
 * the member cannot opt out of), then everything else they have installed, then
 * the catalog they can add from.
 */
export const MemberPackGroup = {
  Required: "required",
  Installed: "installed",
  Available: "available",
} as const;
export type MemberPackGroup =
  (typeof MemberPackGroup)[keyof typeof MemberPackGroup];

/**
 * One row in a member group. Carries the pack identity plus its resolved
 * {@link InstallSource} (for the Required/Installed groups) so the row's source
 * label reads the honest provenance word, and the {@link installFailed} strand
 * flag so a required-but-failed pack renders as a visible failure rather than a
 * silent absence.
 */
export type MemberPackRow = {
  id: string;
  name: string;
  publisher: string;
  version: string;
  description: string;
  /**
   * The member-facing provenance for an installed/required pack, resolved once
   * from the {@link InstallSource} contract. `null` for an Available (not yet
   * installed) pack — nothing to say about where it came from.
   */
  source: InstallSource | null;
  /**
   * True only for a Required pack whose org push has failed to install on this
   * member's machine — the honest strand the member most needs to see. Never set
   * for an Installed or Available row.
   */
  installFailed: boolean;
};

/** The grouped member view: the three groups, each with its rows in order. */
export type MemberPackGroups = Record<MemberPackGroup, MemberPackRow[]>;

/**
 * Per-target statuses that mean the pack is *in the member's packs* — either
 * genuinely installed/enabled, or an offer the member accepted (`opted_in`).
 * An accepted opt-in belongs in the member's Installed group as org-blessed even
 * before the install run completes: the member chose it, so hiding it would be
 * the opposite of honest. (A merely `pending`/`declined` offer is NOT here — it
 * stays in Available.)
 */
const INSTALLED_TARGET_STATUSES: ReadonlySet<DistributionTargetStatusValue> =
  new Set([TargetStatus.Installed, TargetStatus.Enabled, TargetStatus.OptedIn]);

/**
 * Resolve the member-facing {@link InstallSource} for a pack from its admin
 * distribution summary. Feeds the durable-origin-aware resolver the legacy
 * policy fields it needs (there is no per-member recorded origin on this read
 * yet), and marks linkage known so an absent distribution resolves to `self`
 * rather than the `unknown` version-skew fallback — on this surface we DO know
 * whether a distribution links the pack.
 */
function memberInstallSource(
  distribution: PackDistribution | null | undefined
): InstallSource {
  if (!distribution) {
    return resolveInstallSource({ linkageKnown: true });
  }
  return resolveInstallSource({
    linkageKnown: true,
    distributionMode: distribution.mode,
    // The member's own accepted status, when the detail read populated it. An
    // `opt_in` distribution reads as org-blessed only once the member accepted
    // it; otherwise it is a mere offer and resolves to `self`/available.
    targetStatus: memberTargetStatus(distribution),
  });
}

/**
 * The member's per-target status for this distribution, when a detail read
 * populated per-target rows. Prefers an installed/accepted status if any target
 * has one, else the first reported status, else null (list read — unknown).
 */
function memberTargetStatus(
  distribution: PackDistribution
): DistributionTargetStatusValue | null {
  const targets = distribution.targets ?? [];
  const accepted = targets.find((target) =>
    ACCEPTED_MEMBER_STATUSES.has(target.status)
  );
  if (accepted) {
    return accepted.status;
  }
  return targets[0]?.status ?? null;
}

/**
 * Statuses that count as the member having accepted / installed an offered
 * pack — the ones that make an `opt_in` distribution read as org-blessed.
 */
const ACCEPTED_MEMBER_STATUSES: ReadonlySet<DistributionTargetStatusValue> =
  new Set([TargetStatus.OptedIn, TargetStatus.Installed, TargetStatus.Enabled]);

/**
 * True when this member's push of a required (`auto_install`) pack has failed on
 * at least one of their targets — the honest strand. Only meaningful once a
 * detail read populated per-target rows; a list read (no rows) is never treated
 * as a failure.
 */
function hasFailedInstall(distribution: PackDistribution): boolean {
  return (distribution.targets ?? []).some(
    (target) => target.status === TargetStatus.Failed
  );
}

/**
 * True when the member has this pack installed on at least one target. Reads the
 * per-target rows when present; otherwise falls back to the pack's own
 * `installedByMe` flag (single-player desktop / a surface that carries it).
 */
function isInstalledForMember(pack: PackView): boolean {
  const distributions = applicableDistributions(pack);
  const targets = distributions.flatMap(
    (distribution) => distribution.targets ?? []
  );
  if (targets.length > 0) {
    return targets.some((target) =>
      INSTALLED_TARGET_STATUSES.has(target.status)
    );
  }
  return pack.installedByMe;
}

/** Shape a `MemberPackRow` from a pack + its resolved source and strand flag. */
function toRow(
  pack: PackView,
  source: InstallSource | null,
  installFailed: boolean
): MemberPackRow {
  return {
    id: pack.id,
    name: pack.name,
    publisher: pack.publisher ?? "Your organization",
    version: pack.version ?? "—",
    description: pack.description ?? "",
    source,
    installFailed,
  };
}

/**
 * True when a resolved source means the pack is required — non-removable from
 * the member's seat. Both `pushed` (an `auto_install` distribution) and the
 * reserved `required` origin count: the member cannot remove either, so they
 * belong in the Required group.
 */
function isRequiredSource(source: InstallSource): boolean {
  return source === InstallSource.Pushed || source === InstallSource.Required;
}

/**
 * True when a `specific`-targeting distribution targets *this* member — i.e. a
 * targeting entry names their `userId`. Compute-target-only targeting cannot be
 * resolved from this read (the list carries no per-member device roster), so it
 * is NOT treated as targeting the member: better to under-claim Required than to
 * tell an untargeted member a pack is required for them (FEA-4089 review). When
 * the member's identity is unknown (no `memberUserId`), a specific distribution
 * likewise can't be confirmed to target them, so it is not required.
 */
function specificDistributionTargetsMember(
  distribution: PackDistribution,
  memberUserId: string | null | undefined
): boolean {
  if (!memberUserId) {
    return false;
  }
  return distribution.targetingEntries.some(
    (entry) => entry.userId === memberUserId
  );
}

/**
 * True when an `auto_install` distribution requires this member's seat. An `all`
 * distribution targets every member; a `specific` distribution requires the
 * member only when a targeting entry names their `userId`. Compute-target-only
 * or other-member targeting does NOT make the pack Required for this member.
 */
function isRequiredForMember(
  distribution: PackDistribution,
  source: InstallSource,
  memberUserId: string | null | undefined
): boolean {
  if (
    distribution.mode !== DistributionMode.AutoInstall ||
    !isRequiredSource(source)
  ) {
    return false;
  }
  if (distribution.targetingType === DistributionTargetingType.All) {
    return true;
  }
  return specificDistributionTargetsMember(distribution, memberUserId);
}

/**
 * Fold the shared `PackView[]` into the three member groups. Pure — no render,
 * no fetch. Order within each group is the input order (the surface pre-sorts /
 * the catalog read is already stably ordered).
 *
 * - Required: packs whose resolved source is `pushed`/`required` (an
 *   `auto_install` distribution the member can't opt out of). A required pack
 *   whose push failed on this machine is kept here with `installFailed: true` —
 *   the honest strand — instead of being dropped.
 * - Installed: every other pack the member actually has installed
 *   (org-blessed `opted-in`, or `self`), with its resolved source label.
 * - Available: the rest of the catalog — packs the member neither has installed
 *   nor is required to have. No source (nothing to say about provenance yet).
 *
 * A pack can carry more than one distribution (`pack.allDistributions`); the
 * grouping is evaluated across ALL of them — a pack is Required when ANY
 * applicable distribution requires this member, so an older `all` (or a
 * `specific` naming this member) still wins even when a newer distribution
 * targets someone else. Callers that only carry the single summary
 * `distribution` degrade to evaluating that one.
 *
 * `memberUserId` is the current member's user id, used to scope `specific`
 * distributions to the targeted cohort: an `auto_install specific` distribution
 * that does not name this member (or targets only devices) is NOT Required for
 * them. Omit it (or pass null) on surfaces without a resolved member identity —
 * a `specific` distribution then degrades to not-Required rather than
 * mislabelling every member's row.
 */
export function groupMemberPacks(
  packs: readonly PackView[],
  memberUserId?: string | null
): MemberPackGroups {
  const groups: MemberPackGroups = {
    [MemberPackGroup.Required]: [],
    [MemberPackGroup.Installed]: [],
    [MemberPackGroup.Available]: [],
  };

  for (const pack of packs) {
    // Evaluate the member's standing across EVERY distribution the org has for
    // this pack, not just the summary `distribution` — an older `all` (or a
    // `specific` that names this member) must still make the pack Required even
    // when a newer distribution targets someone else (FEA-4166 review).
    const distributions = applicableDistributions(pack);
    const requiredMatch = distributions.find((distribution) =>
      isRequiredForMember(
        distribution,
        memberInstallSource(distribution),
        memberUserId
      )
    );

    if (requiredMatch) {
      const source = memberInstallSource(requiredMatch);
      const installFailed = hasFailedInstall(requiredMatch);
      groups[MemberPackGroup.Required].push(toRow(pack, source, installFailed));
      continue;
    }

    if (isInstalledForMember(pack)) {
      // The summary distribution drives the Installed source label; it is the
      // one folded onto `pack.distribution`.
      const source = memberInstallSource(pack.distribution);
      groups[MemberPackGroup.Installed].push(toRow(pack, source, false));
      continue;
    }

    groups[MemberPackGroup.Available].push(toRow(pack, null, false));
  }

  return groups;
}

/**
 * Every distribution to evaluate for a pack's member standing. Prefers the
 * `allDistributions` list (FEA-4166 review — a catalog item can have several);
 * falls back to the single summary `distribution` for callers that only carry
 * it, and to an empty list when the pack has none.
 */
function applicableDistributions(pack: PackView): PackDistribution[] {
  if (pack.allDistributions && pack.allDistributions.length > 0) {
    return pack.allDistributions;
  }
  return pack.distribution ? [pack.distribution] : [];
}
