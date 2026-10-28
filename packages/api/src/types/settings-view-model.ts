/**
 * @file settings-view-model.ts
 * @description The tenant-scoped Settings view model (ISS-8378): what the actor
 * is, what they may do with each domain, and — separately — whether either
 * question could be answered at all.
 *
 * ONE RESPONSE, NOT ONE PER PANEL. Every `apps/api` admin gate not driven by
 * the session claim costs its own uncached Clerk membership round-trip, and the
 * v1 page answers the same question in the BROWSER from one `isAdmin` boolean
 * while each server gate decides independently. Deriving every panel's
 * capabilities from ONE membership read is this endpoint's whole justification.
 * The count is deliberately not written out here: it is
 * `SETTINGS_PANEL_IDS.length`, and a number in this sentence is the copy that
 * goes stale the next time a panel lands (ISS-10286 made it twelve).
 * It aggregates AUTHORIZATION, not data — panels keep their own reads.
 *
 * An unresolved role produces {@link SettingsViewModelStatus.Error} and
 * per-domain `Error`, never a denial and never an empty grant: PRD-692 forbids
 * folding a failed read into an authorized, empty, or forbidden one.
 */

import type {
  SettingsActorRole,
  SettingsActorRoleResolution,
} from "./settings-actor-role.ts";
import { SettingsActorRoleStatus } from "./settings-actor-role.ts";
import type {
  SettingsDomainFailureReason,
  SettingsDomainGrants,
  SettingsDomainId,
} from "./settings-domain.ts";
import {
  NO_SETTINGS_DOMAIN_GRANTS,
  resolveSettingsDomainGrants,
  SETTINGS_PANEL_DOMAIN,
  SettingsDomainFailureReason as SettingsDomainFailureReasonValues,
  SettingsDomainStatus,
} from "./settings-domain.ts";
import type {
  SettingsActorCapabilities,
  SettingsPanelCapability,
  SettingsPanelId,
} from "./settings-panel.ts";
import {
  SETTINGS_PANEL_IDS,
  SettingsActorCapabilityStatus,
  SettingsPanelCapability as SettingsPanelCapabilityValues,
} from "./settings-panel.ts";

/**
 * The actor half. `staleSessionRole` says the session claim disagreed with the
 * live read (a role changed since the token was minted). Reported so a surface
 * can prompt a refresh; never authorized on — the live read wins.
 */
export type SettingsActorProjection = SettingsActorRoleResolution & {
  staleSessionRole: boolean;
};

/**
 * A domain's authorization outcome, with no payload — panels fetch their own
 * data. Separate arms rather than an optional `reason`, so a consumer cannot
 * read one off a domain that did not fail, nor miss one on a domain that did.
 */
export type SettingsDomainAccess =
  | {
      status:
        | typeof SettingsDomainStatus.Ready
        | typeof SettingsDomainStatus.Forbidden
        | typeof SettingsDomainStatus.Unavailable;
      grants: SettingsDomainGrants;
    }
  | {
      status: typeof SettingsDomainStatus.Error;
      grants: SettingsDomainGrants;
      reason: SettingsDomainFailureReason;
    };

/**
 * The surface-wide outcome. `Partial` means the actor WAS resolved and some
 * domains still could not be decided — neither a working surface nor a broken
 * one, and a reader must not see it as either.
 */
export const SettingsViewModelStatus = {
  Ready: "ready",
  Partial: "partial",
  Error: "error",
} as const;

export type SettingsViewModelStatus =
  (typeof SettingsViewModelStatus)[keyof typeof SettingsViewModelStatus];

export type SettingsViewModel = {
  status: SettingsViewModelStatus;
  actor: SettingsActorProjection;
  /**
   * The panel-keyed projection, in exactly the shape ISS-8362's resolver
   * consumes. Derived from {@link SettingsViewModel.domains} rather than
   * computed twice, so the nav and the panel bodies cannot disagree.
   */
  capabilities: SettingsActorCapabilities;
  domains: Record<SettingsDomainId, SettingsDomainAccess>;
};

/** Input to the projection. `unreadableDomains` is what makes a result partial. */
export type SettingsViewModelInput = {
  resolution: SettingsActorRoleResolution;
  /** Whether the request's session role claim disagreed with the live read. */
  staleSessionRole: boolean;
  /**
   * Domains whose access could not be decided even though the actor WAS
   * resolved. Supplied by a caller that probed a domain-specific authority and
   * got no answer; the aggregate route supplies none today, because it reads
   * exactly one upstream and a failure there is a whole-surface `Error` rather
   * than a per-domain one. Kept in the contract because a domain that gains a
   * second authority must have somewhere to report it that is not a denial.
   */
  unreadableDomains?: readonly SettingsDomainId[];
  /** Domains this host or build does not offer. Distinct from a denial. */
  unavailableDomains?: readonly SettingsDomainId[];
};

const SETTINGS_DOMAIN_IDS: readonly SettingsDomainId[] = SETTINGS_PANEL_IDS.map(
  (panelId) => SETTINGS_PANEL_DOMAIN[panelId]
);

function accessForResolvedRole(
  domain: SettingsDomainId,
  role: SettingsActorRole,
  unreadable: ReadonlySet<SettingsDomainId>,
  unavailable: ReadonlySet<SettingsDomainId>
): SettingsDomainAccess {
  const grants = resolveSettingsDomainGrants(domain, role);

  // Unavailable outranks every capability answer: a domain this build does not
  // offer cannot become reachable by the actor holding more authority.
  if (unavailable.has(domain)) {
    return { status: SettingsDomainStatus.Unavailable, grants };
  }
  // An unreadable domain outranks its own grant, mirroring ISS-8362's rule that
  // `unreadable` beats `grants`: a stale grant must not paper over a failed read.
  if (unreadable.has(domain)) {
    return {
      status: SettingsDomainStatus.Error,
      grants: NO_SETTINGS_DOMAIN_GRANTS,
      reason: SettingsDomainFailureReasonValues.UpstreamUnavailable,
    };
  }
  return grants.read
    ? { status: SettingsDomainStatus.Ready, grants }
    : { status: SettingsDomainStatus.Forbidden, grants };
}

function failedAccess(
  reason: SettingsDomainFailureReason
): SettingsDomainAccess {
  return {
    status: SettingsDomainStatus.Error,
    grants: NO_SETTINGS_DOMAIN_GRANTS,
    reason,
  };
}

/**
 * A NOT-A-MEMBER actor is a settled ANSWER — the removed-member and cross-org
 * case — so every domain is `Forbidden`, not `Error`. Reporting it as an outage
 * would invite retries against a state that will never change on its own.
 */
function accessForUnresolvableActor(
  resolution: Exclude<
    SettingsActorRoleResolution,
    { status: typeof SettingsActorRoleStatus.Resolved }
  >
): SettingsDomainAccess {
  if (resolution.status === SettingsActorRoleStatus.NotAMember) {
    return {
      status: SettingsDomainStatus.Forbidden,
      grants: NO_SETTINGS_DOMAIN_GRANTS,
    };
  }
  return failedAccess(SettingsDomainFailureReasonValues.RoleUnresolved);
}

/**
 * Which panel capability each grant publishes as. A `Record` keyed on
 * `SettingsDomainGrants`, not an array of pairs: adding a grant must fail `tsc`
 * HERE rather than silently omitting that capability from every projection,
 * which would hide an authority the command guard had already begun honouring —
 * the exact "two rules that agree until one is edited" split that sharing one
 * policy table exists to prevent.
 */
const DOMAIN_GRANT_CAPABILITY: Record<
  keyof SettingsDomainGrants,
  SettingsPanelCapability
> = {
  read: SettingsPanelCapabilityValues.Read,
  edit: SettingsPanelCapabilityValues.Edit,
  admin: SettingsPanelCapabilityValues.Admin,
  owner: SettingsPanelCapabilityValues.Owner,
};

/**
 * Grant order, least privileged first, so a projected list reads predictably.
 * DERIVED from the table above rather than restated, because a hand-written
 * second list is the same drift the `Record` was just made exhaustive to stop:
 * it would compile unchanged while quietly omitting a new grant from every
 * projection.
 */
const DOMAIN_GRANT_ORDER = Object.keys(
  DOMAIN_GRANT_CAPABILITY
) as (keyof SettingsDomainGrants)[];

/**
 * Turn the domain projection into ISS-8362's panel-keyed
 * {@link SettingsActorCapabilities}. Derived, never computed independently:
 * `settings-panel-resolution.ts` and the panel bodies must not be able to reach
 * different answers about the same actor.
 */
function projectCapabilities(
  domains: Record<SettingsDomainId, SettingsDomainAccess>,
  resolution: SettingsActorRoleResolution
): SettingsActorCapabilities {
  if (resolution.status === SettingsActorRoleStatus.Unresolved) {
    return { status: SettingsActorCapabilityStatus.Error };
  }

  const grants: Partial<
    Record<SettingsPanelId, readonly SettingsPanelCapability[]>
  > = {};
  const unreadable: SettingsPanelId[] = [];

  for (const panelId of SETTINGS_PANEL_IDS) {
    const access = domains[SETTINGS_PANEL_DOMAIN[panelId]];
    if (access.status === SettingsDomainStatus.Error) {
      unreadable.push(panelId);
      continue;
    }
    const held = DOMAIN_GRANT_ORDER.filter((grant) => access.grants[grant]).map(
      (grant) => DOMAIN_GRANT_CAPABILITY[grant]
    );
    if (held.length > 0) {
      grants[panelId] = held;
    }
  }

  return {
    status: SettingsActorCapabilityStatus.Ready,
    grants,
    ...(unreadable.length > 0 ? { unreadable } : {}),
  };
}

/**
 * Build the whole view model from one resolved (or unresolved) role. Pure, so
 * the eight-case authorization matrix is provable without a database or Clerk.
 */
export function projectSettingsViewModel(
  input: SettingsViewModelInput
): SettingsViewModel {
  const unreadable = new Set(input.unreadableDomains ?? []);
  const unavailable = new Set(input.unavailableDomains ?? []);
  const domains = {} as Record<SettingsDomainId, SettingsDomainAccess>;

  for (const domain of SETTINGS_DOMAIN_IDS) {
    domains[domain] =
      input.resolution.status === SettingsActorRoleStatus.Resolved
        ? accessForResolvedRole(
            domain,
            input.resolution.role,
            unreadable,
            unavailable
          )
        : accessForUnresolvableActor(input.resolution);
  }

  return {
    status: resolveViewModelStatus(input.resolution, domains),
    actor: { ...input.resolution, staleSessionRole: input.staleSessionRole },
    capabilities: projectCapabilities(domains, input.resolution),
    domains,
  };
}

/**
 * `Error` when the actor itself could not be read — nothing downstream is
 * trustworthy. `Partial` when the actor WAS read and at least one domain still
 * failed. `Ready` otherwise, including the settled not-a-member answer, whose
 * uniform denial is a complete and correct result rather than a degraded one.
 */
function resolveViewModelStatus(
  resolution: SettingsActorRoleResolution,
  domains: Record<SettingsDomainId, SettingsDomainAccess>
): SettingsViewModelStatus {
  if (resolution.status === SettingsActorRoleStatus.Unresolved) {
    return SettingsViewModelStatus.Error;
  }
  const anyFailed = SETTINGS_DOMAIN_IDS.some(
    (domain) => domains[domain].status === SettingsDomainStatus.Error
  );
  return anyFailed
    ? SettingsViewModelStatus.Partial
    : SettingsViewModelStatus.Ready;
}
