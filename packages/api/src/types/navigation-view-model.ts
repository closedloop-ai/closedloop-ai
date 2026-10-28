/**
 * @file navigation-view-model.ts
 * @description The shell navigation VIEW MODEL vocabulary (ISS-8377): what the
 * shared sidebar composite is told about the ACTOR, not about the routes.
 *
 * The split is deliberate and is the whole reason this module is separate from
 * a navigation manifest. A manifest answers "what destinations exist, in what
 * order, under which group" and is the same for everyone. This answers "what is
 * true of THIS actor, on THIS host, right now" — standing, per-destination
 * reachability, and counts — and is different per request and per surface. A
 * manifest is static data; a view model is a read that can be in flight, can
 * fail, and can be partial.
 *
 * Values only — no zod, no parser — so a bundle-sensitive `"use client"` sidebar
 * can render a row without pulling a validator into the browser bundle, the same
 * constraint `./org-admin-role.ts` documents for the role set this module reads.
 *
 * DESTINATION IDS ARE NOT OWNED HERE. Every type is generic over the id, with a
 * `string` default, so this contract composes with whichever manifest supplies
 * the identity rather than minting a competing set of ids that would have to be
 * kept in sync by hand. An adapter that has a closed id union instantiates the
 * generic with it and gets exhaustiveness for free.
 */

import { isOrgAdminRole } from "./org-admin-role.ts";

/**
 * Whether the actor's navigation projection was read at all.
 *
 * `Pending` and `Error` are NOT answers about the actor: neither may be folded
 * into a grant, a denial, or a zero. A read that never completed must not become
 * an empty, authorized, or completed state (PRD-692).
 */
export const NavigationProjectionStatus = {
  Ready: "ready",
  Pending: "pending",
  Error: "error",
} as const;

export type NavigationProjectionStatus =
  (typeof NavigationProjectionStatus)[keyof typeof NavigationProjectionStatus];

/**
 * The actor's standing in the organization the shell is rendering.
 *
 * `NotAMember` and `NoOrganization` are deliberately their own members rather
 * than flavours of `Member`. `./org-admin-role.ts` states the distinction this
 * encodes: an absent membership is "not a member", which is a different fact
 * from "a member without the role", and the two justify different navigation.
 * Folding the first into the second is what offers every org-scoped destination
 * to someone whose membership was just revoked — the collapse is easy to make
 * because the admin gate answers both with the same `isAdmin: false`.
 *
 * The two absences are themselves distinct: `NoOrganization` is "no organization
 * is resolved for this actor at all", `NotAMember` is "this organization is
 * resolved and the actor does not belong to it".
 *
 * `Unknown` is the standing when the membership read is pending or failed. It is
 * never an authorization answer.
 */
export const NavigationActorStanding = {
  Admin: "admin",
  Member: "member",
  NotAMember: "not-a-member",
  NoOrganization: "no-organization",
  Unknown: "unknown",
} as const;

export type NavigationActorStanding =
  (typeof NavigationActorStanding)[keyof typeof NavigationActorStanding];

/**
 * Outcome of resolving one destination for this actor on this host. Every value
 * renders DIFFERENTLY; folding any two together is the defect this union exists
 * to prevent.
 *
 * `Unavailable` means this host does not offer the destination at all — which is
 * why this module needs no host/surface axis of its own. The adapter already
 * knows which host it is running on and resolves that question before it builds
 * the projection, so the view model carries the ANSWER rather than the input,
 * and no third Web/Desktop enum joins the two the repo already has.
 */
export const NavigationDestinationStatus = {
  Ready: "ready",
  Pending: "pending",
  Unavailable: "unavailable",
  Forbidden: "forbidden",
  CapabilityError: "capability-error",
} as const;

export type NavigationDestinationStatus =
  (typeof NavigationDestinationStatus)[keyof typeof NavigationDestinationStatus];

/**
 * Whether a destination's count is a measurement.
 *
 * Only {@link NavigationCountStatus.Ready} carries a number. That is structural,
 * not a convention: a caller holding a pending or unavailable count has no
 * `value` property to read, so "render the count" cannot silently become
 * "render 0" the way it does when an unknown is modelled as `number` and
 * defaulted. This is the shape ISS-8377's central acceptance criterion asks for
 * — a failed projection never renders a fabricated zero.
 */
export const NavigationCountStatus = {
  Ready: "ready",
  Pending: "pending",
  Unavailable: "unavailable",
} as const;

export type NavigationCountStatus =
  (typeof NavigationCountStatus)[keyof typeof NavigationCountStatus];

export type NavigationDestinationCount =
  | {
      readonly status: typeof NavigationCountStatus.Ready;
      readonly value: number;
    }
  | { readonly status: typeof NavigationCountStatus.Pending }
  | { readonly status: typeof NavigationCountStatus.Unavailable };

/** What the shell knows about one destination for this actor. */
export type NavigationDestinationProjection = {
  readonly status: NavigationDestinationStatus;
  /**
   * Absent when the destination has no count concept at all, which is a
   * different fact from a count that could not be read — that one is present
   * and {@link NavigationCountStatus.Unavailable}.
   */
  readonly count?: NavigationDestinationCount;
};

/**
 * The actor-shaped half of shell navigation.
 *
 * `destinations` is partial on purpose: an id absent from it while
 * `projectionStatus` is `Ready` means "this actor has no projection for that
 * destination", which the fold treats as unreadable rather than as a denial —
 * an omission is not an authorization answer.
 */
export type NavigationViewModel<TDestinationId extends string = string> = {
  readonly projectionStatus: NavigationProjectionStatus;
  readonly standing: NavigationActorStanding;
  /** Null when no organization is resolved for the actor. */
  readonly organizationId: string | null;
  readonly destinations: Partial<
    Record<TDestinationId, NavigationDestinationProjection>
  >;
};

/**
 * The view model a surface uses before any read has been attempted, and the one
 * it falls back to when a projection cannot be built. It grants nothing and
 * counts nothing, so a consumer that ignores an error still cannot render an
 * authorization or a measurement it never received.
 */
export const PENDING_NAVIGATION_VIEW_MODEL: NavigationViewModel = {
  projectionStatus: NavigationProjectionStatus.Pending,
  standing: NavigationActorStanding.Unknown,
  organizationId: null,
  destinations: Object.create(null),
};

const PENDING_COUNT: NavigationDestinationCount = {
  status: NavigationCountStatus.Pending,
};

const UNAVAILABLE_COUNT: NavigationDestinationCount = {
  status: NavigationCountStatus.Unavailable,
};

/**
 * Whether a value is a number this domain can present as a count.
 *
 * Covers the whole impossible set, not the two that are usually remembered.
 * Negative and non-finite are the ones that get written; what actually reaches a
 * badge is the rest — a fractional count, a magnitude past the safe-integer
 * range, and a blank field arriving as the string `""`. Each renders as a
 * confident measurement, which is worse than refusing.
 *
 * A real `0` PASSES: a measured zero is data. The blank-field hazard is the
 * COERCION, not the zero — once a caller has run `Number("")` the result is
 * indistinguishable from a genuine count of none, so the defence is refusing the
 * string here rather than pretending this predicate can see through it.
 */
export function isPresentableCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A measured count, or {@link NavigationCountStatus.Unavailable} when the value
 * is not one this domain can present.
 *
 * Every producer — the cloud projection and each host adapter that layers a
 * count onto it — builds counts through here, so an impossible number is refused
 * once at the contract rather than once per host by hand, and never becomes a
 * badge that lies.
 */
export function toNavigationCount(value: unknown): NavigationDestinationCount {
  if (!isPresentableCount(value)) {
    return UNAVAILABLE_COUNT;
  }
  return { status: NavigationCountStatus.Ready, value };
}

/** A count whose read is still in flight. */
export function pendingNavigationCount(): NavigationDestinationCount {
  return PENDING_COUNT;
}

/** A count whose read completed without producing a usable number. */
export function unavailableNavigationCount(): NavigationDestinationCount {
  return UNAVAILABLE_COUNT;
}

/**
 * The view model with each host-read count attached to its destination.
 *
 * A count is only ever attached to a destination the projection already
 * answered for. Minting an entry for one it did not would turn a host count
 * into a claim about reachability, which is the server's answer to give.
 */
export function withNavigationCounts(
  viewModel: NavigationViewModel,
  counts: ReadonlyMap<string, NavigationDestinationCount>
): NavigationViewModel {
  const destinations: Record<string, NavigationDestinationProjection> =
    Object.create(null);
  for (const [destinationId, projection] of Object.entries(
    viewModel.destinations
  )) {
    if (projection === undefined) {
      continue;
    }
    const count = counts.get(destinationId);
    destinations[destinationId] =
      count === undefined ? projection : { ...projection, count };
  }
  return { ...viewModel, destinations };
}

/**
 * The actor's standing from the organization and role a surface resolved.
 *
 * A null `organizationId` is `NoOrganization` REGARDLESS of role, because a role
 * string with no organization behind it describes no membership this shell can
 * act on.
 *
 * A null `role` inside a real organization is `NotAMember` — NOT `Member`. Both
 * of this function's callers get null from a membership LOOKUP that found
 * nothing (Clerk's membership list is empty on the server, `membership?.role` is
 * undefined on the client), so null means "no membership here", not "a member
 * whose role we did not bother to read". Returning `Member` for it is what would
 * grant every org-scoped destination to a revoked user.
 */
export function deriveNavigationActorStanding({
  organizationId,
  role,
}: {
  organizationId: string | null;
  role: string | null;
}): NavigationActorStanding {
  if (organizationId === null) {
    return NavigationActorStanding.NoOrganization;
  }
  if (role === null) {
    return NavigationActorStanding.NotAMember;
  }
  if (isOrgAdminRole(role)) {
    return NavigationActorStanding.Admin;
  }
  return NavigationActorStanding.Member;
}

/**
 * Maximum destinations one projection answers for. The caller sends its
 * manifest's ids, so the bound is what keeps a hostile or buggy client from
 * turning one navigation read into an unbounded response. It lives beside the
 * view model rather than in the route so the shell manifest can be held to it by
 * a test instead of discovering it as a 400.
 */
export const NAVIGATION_DESTINATION_LIMIT = 64;

/**
 * The view model for a read that FINISHED without a projection: the request
 * failed, the API predates the route, or the body could not be used. Distinct
 * from {@link PENDING_NAVIGATION_VIEW_MODEL} because nothing is still in flight,
 * and like it, it grants nothing and counts nothing.
 */
export const ERRORED_NAVIGATION_VIEW_MODEL: NavigationViewModel = {
  projectionStatus: NavigationProjectionStatus.Error,
  standing: NavigationActorStanding.Unknown,
  organizationId: null,
  destinations: Object.create(null),
};
