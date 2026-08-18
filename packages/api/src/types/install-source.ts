/**
 * Install-source label contract (FEA-4090).
 *
 * The single member-facing "how did I get this pack" contract, shared by BOTH
 * the web surface (`apps/app`, resolving via `apps/api`) and the desktop
 * renderer (resolving via local IPC — `getInstalledPacks` + assigned
 * distributions). It answers, for a pack the current member already has
 * installed, whether it was auto-installed (pushed) by the org, offered and
 * opted into, self-installed, or required.
 *
 * ## Durable provenance, not mutable policy (wongk)
 *
 * The provenance a member sees MUST record how the pack actually arrived at the
 * moment it was installed — it must not be re-derived from the CURRENT
 * distribution policy, which is mutable and can change under the member's feet:
 *
 * - The reconciler returns "installed" when it finds a pack already present
 *   without running an install, so deriving the label from the current
 *   distribution mode relabels an earlier self-install as "Auto-installed" the
 *   moment an admin assignment reconciles. That is policy, not provenance.
 * - Current per-device `status` is mutable while `installedAt` is preserved, so
 *   a later failure would flip a "how I got it" label back. Provenance needs a
 *   monotonic milestone, not a mutable status read.
 * - The schema permits overlapping distributions for one pack. Deriving from a
 *   set of policy rows forces a precedence rule that two adapters (desktop
 *   oldest-first vs a newest-first web summary) can order differently, so they
 *   pick different sources for the same pack.
 *
 * The durable answer to all three is a single, write-once {@link InstallOrigin}
 * milestone stamped by whichever code path actually installs the pack. Once a
 * pack carries a recorded origin, the label is exactly that origin — there is
 * no policy set to order (no per-adapter precedence divergence), no reconcile
 * can relabel it, and no mutable status can flip it. {@link resolveInstallSource}
 * reads that recorded origin first and returns it verbatim.
 *
 * The legacy {@link DistributionMode}/`targetStatus` derivation is retained
 * ONLY as a clearly-named compat fallback for packs installed before origin
 * recording existed (version skew), and it is documented as reading current
 * policy — never mistaken for durable provenance.
 *
 * Derivation adds no new column in this contract; the persisted origin field
 * and the producer writes that stamp it are wired by the sibling install-path
 * FEAT (the write points are named at {@link InstallOrigin}). The deeper
 * per-device install-state model is out of scope here (deferred to FEA-4071).
 *
 * All enums follow the repo-sanctioned `{…} as const` +
 * `(typeof X)[keyof typeof X]` idiom — never a TypeScript `enum`.
 *
 * @repo/api MUST NOT import from @repo/app or apps/*.
 */

import {
  DistributionMode,
  DistributionTargetStatusValue,
} from "./distribution";

// ---------------------------------------------------------------------------
// InstallOrigin — the durable, write-once provenance milestone
// ---------------------------------------------------------------------------

/**
 * The durable, monotonic record of *how a pack actually arrived* on a member's
 * device, stamped once by the code path that installs it and never rewritten by
 * later policy reconciliation or a mutable status change. This is the
 * source-of-truth for the member-facing source label; every arrival path writes
 * exactly one of these at its install moment.
 *
 * - `auto_installed` — an `auto_install` distribution installed the pack with
 *   no member action. Written by the desktop auto-install path
 *   (`coaching-distribution-install` / `install-orchestrator`) when it performs
 *   the install for a non-required `auto_install` assignment.
 * - `opted_in`       — the member accepted an `opt_in` offer and the pack was
 *   installed as a result. Written by the opt-in acceptance path
 *   (`opt-in-distributions-banner` → coaching install) at the moment the
 *   install succeeds — the milestone wongk flagged as missing: the successful
 *   opt-in must stamp this, not merely dismiss the banner.
 * - `self_installed` — the member installed the pack on their own, with no
 *   distribution driving it. Written by the manual/self install path.
 * - `required`       — a mandatory distribution the member cannot remove.
 *   RESERVED: no production path stamps this yet — neither the persisted
 *   Distribution nor any API/desktop payload currently carries a mandatoriness
 *   signal (wongk). It is enumerated here so the origin→source mapping is
 *   exhaustive and typechecks the day a producer starts stamping it, rather
 *   than silently mislabeling a required pack as auto-installed. It has no
 *   member-facing behavior until that producer exists.
 */
export const InstallOrigin = {
  AutoInstalled: "auto_installed",
  OptedIn: "opted_in",
  SelfInstalled: "self_installed",
  Required: "required",
} as const;
export type InstallOrigin = (typeof InstallOrigin)[keyof typeof InstallOrigin];

// ---------------------------------------------------------------------------
// InstallSource — how the current member came to have an installed pack
// ---------------------------------------------------------------------------

/**
 * How the current member came to have a given installed pack (the read-side
 * label derived from the durable {@link InstallOrigin}, or — for pre-origin
 * packs — from the legacy policy fallback).
 * - `pushed`      — an `auto_install` distribution installed it without the
 *                   member acting (org pushed it to them).
 * - `opted-in`    — an `opt_in` distribution the org offered and the member
 *                   accepted (opted in).
 * - `self`        — self-installed: the member installed it on their own, with
 *                   no distribution driving it.
 * - `required`    — a mandatory distribution the member cannot remove. Kept
 *                   distinct from `pushed` so the label can be honest that the
 *                   pack is not optional.
 * - `unknown`     — the provenance cannot be determined (a version-skewed or
 *                   partial payload that carries neither a recorded origin nor
 *                   the policy fields this resolver reads, or an unrecognized/
 *                   legacy mode). Distinct from `self`: "we don't know how you
 *                   got this" is not the same claim as "you installed this
 *                   yourself", so the label degrades to a generic "Installed"
 *                   rather than over-claiming self-install.
 */
export const InstallSource = {
  Pushed: "pushed",
  OptedIn: "opted-in",
  Self: "self",
  Required: "required",
  Unknown: "unknown",
} as const;
export type InstallSource = (typeof InstallSource)[keyof typeof InstallSource];

/**
 * The read-side inputs the resolver needs to derive an {@link InstallSource}
 * for a pack the current member already has installed. Every field is optional
 * so a partial/version-skewed payload (an older API or IPC response that omits
 * a field) degrades to the compat-safe `unknown` fallback rather than throwing.
 */
export type InstallSourceInput = {
  /**
   * The durable, write-once provenance milestone stamped at the pack's install
   * moment. When present, this is authoritative: the resolver returns it
   * verbatim and NONE of the policy fields below are consulted, so a later
   * policy reconcile or status change cannot relabel the pack. Absent only for
   * a pack installed before origin recording existed (version skew), which
   * falls through to the legacy policy fallback.
   */
  recordedOrigin?: InstallOrigin | null;
  /**
   * Whether the producing payload is capable of reporting distribution linkage
   * at all — used by the legacy policy fallback only (packs with no
   * {@link recordedOrigin}). A modern producer that predates origin recording
   * sets this `true` (even when it found no link, so an absent
   * `distributionMode` genuinely means self-installed); an older or partial
   * payload that cannot report linkage leaves it absent, so the resolver
   * degrades to `unknown` instead of over-claiming `self`. This is the
   * distinction wongk flagged: "no link" and "can't report a link" are
   * different claims.
   */
  linkageKnown?: boolean;
  /**
   * COMPAT FALLBACK ONLY — the *current* distribution mode linking this pack to
   * the member. This is mutable policy, not provenance, so it is read only when
   * no durable {@link recordedOrigin} is present. Absent + `linkageKnown` means
   * genuinely self-installed; absent + `linkageKnown` unset means unknown.
   */
  distributionMode?: DistributionMode | null;
  /**
   * COMPAT FALLBACK ONLY — whether the current linking distribution is
   * mandatory. Only meaningful for a pushed (`auto_install`) distribution, and
   * only consulted when no durable {@link recordedOrigin} is present.
   */
  required?: boolean;
  /**
   * COMPAT FALLBACK ONLY — the member's mutable per-device status for the
   * current linking distribution. Read only when no durable
   * {@link recordedOrigin} is present. For an `opt_in` distribution, an accepted
   * (`opted_in`/`installed`/`enabled`) status is what distinguishes `opted-in`
   * from a merely offered pack.
   */
  targetStatus?: DistributionTargetStatusValue | null;
};

// ---------------------------------------------------------------------------
// InstallSource resolver
// ---------------------------------------------------------------------------

/**
 * Per-device statuses that count as the member having *accepted* an `opt_in`
 * distribution (as opposed to merely being offered it). An offered-but-not-yet-
 * accepted opt-in pack is not "installed" from the member's perspective, so it
 * never reaches this resolver; but if a caller does pass a pending/declined
 * opt-in, we do not claim it was org-blessed.
 */
const ACCEPTED_OPT_IN_STATUSES: ReadonlySet<DistributionTargetStatusValue> =
  new Set([
    DistributionTargetStatusValue.OptedIn,
    DistributionTargetStatusValue.Installed,
    DistributionTargetStatusValue.Enabled,
  ]);

/**
 * Resolve the {@link InstallSource} for a pack the current member already has
 * installed. Read-side only — it never mutates install state.
 *
 * Precedence:
 * 1. A durable {@link InstallSourceInput.recordedOrigin} (the provenance
 *    milestone stamped at install time) wins outright — it is returned verbatim
 *    via {@link sourceForOrigin}, immune to later policy change and free of any
 *    per-adapter precedence question (there is no policy set to order).
 * 2. Otherwise the legacy *policy* fallback applies, for packs installed before
 *    origin recording existed. This reads current distribution policy and is
 *    honestly labeled as such — it can go stale, which is exactly why new
 *    installs stamp a durable origin instead of relying on it:
 *    - No `linkageKnown` signal → `unknown` (version-skewed / partial payload).
 *    - `linkageKnown` with no distribution link → `self`.
 *    - `auto_install` + `required` → `required`; `auto_install` → `pushed`.
 *    - `opt_in` with an accepted target status → `opted-in`; otherwise `self`.
 *    - Any unrecognized / legacy mode → `unknown`.
 */
export function resolveInstallSource(input: InstallSourceInput): InstallSource {
  const {
    recordedOrigin,
    linkageKnown,
    distributionMode,
    required,
    targetStatus,
  } = input;

  if (recordedOrigin) {
    return sourceForOrigin(recordedOrigin);
  }

  if (!distributionMode) {
    return linkageKnown ? InstallSource.Self : InstallSource.Unknown;
  }

  return resolveFromMode(distributionMode, required, targetStatus);
}

/**
 * Map a durable {@link InstallOrigin} to its member-facing {@link InstallSource}
 * label. Exhaustive `switch` with a `never`-typed default: adding a new
 * `InstallOrigin` member fails typecheck here until it is intentionally mapped,
 * so a new provenance milestone can never silently mislabel (wongk's
 * exhaustiveness point applied to the origin axis). `Required` is mapped even
 * though no producer stamps it yet, so the day one does, the label is correct.
 */
function sourceForOrigin(origin: InstallOrigin): InstallSource {
  switch (origin) {
    case InstallOrigin.AutoInstalled:
      return InstallSource.Pushed;
    case InstallOrigin.OptedIn:
      return InstallSource.OptedIn;
    case InstallOrigin.SelfInstalled:
      return InstallSource.Self;
    case InstallOrigin.Required:
      return InstallSource.Required;
    default:
      return unknownForUnmappedOrigin(origin);
  }
}

/**
 * Map a recognized {@link DistributionMode} to an {@link InstallSource} in the
 * legacy *policy* fallback. The exhaustive `switch` with a `never`-typed default
 * makes a newly added `DistributionMode` fail typecheck here until it is
 * intentionally mapped, instead of silently compiling as `self` (wongk). A
 * runtime-unknown mode (a legacy value the union does not know) still degrades
 * safely to `unknown`.
 */
function resolveFromMode(
  mode: DistributionMode,
  required: boolean | undefined,
  targetStatus: DistributionTargetStatusValue | null | undefined
): InstallSource {
  switch (mode) {
    case DistributionMode.AutoInstall:
      return required ? InstallSource.Required : InstallSource.Pushed;
    case DistributionMode.OptIn:
      return targetStatus && ACCEPTED_OPT_IN_STATUSES.has(targetStatus)
        ? InstallSource.OptedIn
        : InstallSource.Self;
    default:
      return unknownForUnmappedMode(mode);
  }
}

/**
 * Compile-time exhaustiveness guard for {@link sourceForOrigin}. The `never`
 * parameter makes a newly added {@link InstallOrigin} fail typecheck at the call
 * site until that member is mapped in the `switch` above. At runtime a legacy
 * value outside the union lands here and degrades to `unknown`.
 */
function unknownForUnmappedOrigin(_origin: never): InstallSource {
  return InstallSource.Unknown;
}

/**
 * Compile-time exhaustiveness guard for {@link resolveFromMode}. The `never`
 * parameter makes a newly added `DistributionMode` fail typecheck at the call
 * site until that member is mapped in the `switch` above (instead of silently
 * mapping to `self`). At runtime a legacy value outside the union lands here and
 * degrades to `unknown`.
 */
function unknownForUnmappedMode(_mode: never): InstallSource {
  return InstallSource.Unknown;
}
