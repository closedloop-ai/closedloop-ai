import type {
  OnboardingJoinableOrganization,
  OnboardingOrganizationJoin,
} from "../components/guided-onboarding-data";
import {
  UNAVAILABLE_JOINABLE_ORGANIZATION,
  UNKNOWN_JOINABLE_ORGANIZATION,
} from "../components/guided-onboarding-data";

/**
 * What a shell can state about the organizations the signed-in account is
 * authorized to join, in surface-agnostic terms.
 *
 * ISS-11145: every production host used to pass `undefined` whenever there was
 * no ACTIVE organization, which the dialog defaults to
 * {@link UNKNOWN_JOINABLE_ORGANIZATION} — so the Choose-organization step's
 * `none` arm had no producer and an existing member with no active organization
 * sat on a `role="status"` skeleton announcing a check that had already
 * finished. This is the one place that decides which of the four arms a host
 * asks for, so web and desktop cannot drift into two answers (see
 * `packages/app/AGENTS.md` -> "Decide availability once").
 */
export type JoinableOrganizationLookup = {
  /**
   * The ACTIVE organization's name, when the account has one. Empty, blank, or
   * absent means there is no active organization — not that the lookup failed.
   */
  activeOrganizationName?: string | null;
  /**
   * Organizations the shell can substantiate as joinable by this account — a
   * real membership or a real invitation reported by the identity provider —
   * each with the `join` target the host needs to honor the Join button.
   *
   * The 2026-09-03 organization-discovery decision forbids claiming a hidden
   * domain match, and the domain prefill was never built, so an organization
   * derived from the account's email domain does NOT belong in this list.
   * Blank-named entries are ignored rather than offered as a nameless row.
   */
  joinableOrganizations?: readonly {
    join: OnboardingOrganizationJoin;
    name: string | null | undefined;
  }[];
  /**
   * Whether the membership/invitation read has REPORTED. False keeps the
   * skeleton, which is the one honest use for it. A read that FAILED has
   * reported — including while a retry of it is in flight, which
   * {@link JoinableOrganizationLookup.lookupRetrying} carries instead, so the
   * failure arm survives its own Retry rather than unmounting the control the
   * reader just pressed (ISS-11158 review, tamsinb).
   */
  lookupSettled: boolean;
  /**
   * Whether that read reported a FAILURE rather than an answer.
   *
   * A failed lookup is neither an empty one nor a slow one: "No authorized
   * organization is ready to join" states a fact the shell does not hold, and
   * the pending skeleton announces a check that has already resolved and will
   * not retry itself. ISS-11158 gave it its own `unavailable` arm for exactly
   * that reason; a host that reports one owes the step a retry.
   */
  lookupFailed?: boolean;
  /**
   * Whether a re-read of a FAILED lookup is in flight right now.
   *
   * It does not change WHICH arm resolves — a failure that is being retried is
   * still a failure, and the card's past-tense sentence stays true — it only
   * tells the step to render its Retry as busy, exactly as
   * `OnboardingStatusUnavailable` does. Moving to the pending arm instead would
   * unmount the failure card mid-press and drop keyboard focus to the dialog
   * container (ISS-11158 review, tamsinb).
   */
  lookupRetrying?: boolean;
};

/**
 * Resolve the step's arm from what the host actually knows.
 *
 * Precedence is deliberate, and two of its four steps outrank the failure on
 * purpose:
 *  - An active organization answers the question outright.
 *  - An UNREPORTED lookup withholds an answer. A FAILED one has reported, so a
 *    retry of it does NOT fall back here: the failure arm stays and carries
 *    `lookupRetrying`, which the step renders as a busy Retry. Unmounting the
 *    card mid-press would drop keyboard focus to the dialog container, and the
 *    card's sentence is past tense, so it stays true while the new read runs —
 *    the same pair `OnboardingStatusUnavailable` already ships (ISS-11158
 *    review, tamsinb).
 *  - A SUBSTANTIATED candidate still wins over a failure, because `lookupFailed`
 *    is the OR of two independent reads (memberships, invitations) while the
 *    candidate list is the union of their rows. A failed membership page beside
 *    an invitation the shell is actually holding must render that invitation's
 *    Join: answering the question is not something a partial failure gets to
 *    take away, and standing the failure card in its place would withhold an
 *    affordance the shell can honor (review-soul, ISS-11158). Winning is not the
 *    same as ERASING it — that arm carries `partialLookupFailure` so the step can
 *    offer the Join and still say a list went unread. Both rows state the one
 *    sentence the 2026-09-28 operator ruling fixed, so what separates them is the
 *    STRUCTURE (a named card in place of the Join, against an unnamed line
 *    beneath it) rather than the wording it used to be. An ACTIVE organization is the one case where
 *    the flag is deliberately not set: it answers the question before the
 *    joinable lookup is consulted at all, so nothing the reader acts on turns
 *    on whether that lookup finished.
 *  - Only a lookup that reported, produced nothing, and did not fail claims
 *    `none`; one that reported nothing because it FAILED says `unavailable`.
 */
export function resolveJoinableOrganization(
  lookup: JoinableOrganizationLookup
): OnboardingJoinableOrganization {
  const activeName = lookup.activeOrganizationName?.trim();
  if (activeName) {
    return { name: activeName, status: "available" };
  }

  if (!lookup.lookupSettled) {
    return UNKNOWN_JOINABLE_ORGANIZATION;
  }

  const joinable = (lookup.joinableOrganizations ?? [])
    .map((candidate) => ({ ...candidate, name: candidate.name?.trim() }))
    .find(
      (
        candidate
      ): candidate is { join: OnboardingOrganizationJoin; name: string } =>
        Boolean(candidate.name)
    );
  if (joinable) {
    // The failure is CARRIED, not dropped. `lookupFailed` is the OR of two
    // independent reads, so a candidate from the half that answered says nothing
    // about the half that errored, and a reader deciding between Join and Create
    // new organization needs to know a list went unread. Absent rather than
    // `false` when nothing failed, so the flag never appears on a clean read.
    return {
      join: joinable.join,
      name: joinable.name,
      status: "available",
      ...(lookup.lookupFailed === true
        ? {
            partialLookupFailure: true,
            ...(lookup.lookupRetrying === true
              ? { lookupRetrying: true }
              : undefined),
          }
        : undefined),
    };
  }

  if (lookup.lookupFailed === true) {
    return lookup.lookupRetrying === true
      ? { lookupRetrying: true, status: "unavailable" }
      : UNAVAILABLE_JOINABLE_ORGANIZATION;
  }

  return { status: "none" };
}
