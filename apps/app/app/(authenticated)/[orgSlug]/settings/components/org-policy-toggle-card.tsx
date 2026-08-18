"use client";

import type { Organization } from "@repo/api/src/types/organization";
import {
  useOrganization,
  useUpdateOrganization,
} from "@repo/app/organizations/hooks/use-organizations";
import {
  OrgPolicyEditableCard,
  OrgPolicyErrorState,
  OrgPolicyLoadingState,
  OrgPolicyUnavailableState,
} from "@repo/app/settings/components/org-policy-toggle-card";
import {
  buildOrgPolicyUpdateInput,
  ORG_POLICY_SAVE_OUTCOME_ALERTS,
  type OrgPolicyField,
  OrgPolicyFieldState,
  type OrgPolicySaveState,
  readOrgPolicyField,
  resolveOrgPolicyFieldState,
  resolveOrgPolicySaveOutcome,
} from "@repo/app/settings/lib/org-policy-toggle-state";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";

type OrgPolicyToggleCardProperties = {
  isAdmin: boolean;
  /** Which optional org policy field this card reads and writes. */
  field: OrgPolicyField;
  title: string;
  description: string;
  toggleId: string;
  toggleLabel: string;
  toggleHelpText: string;
};

type OrganizationQuery = ReturnType<typeof useOrganization>;

type UpdateOrganizationMutation = ReturnType<typeof useUpdateOrganization>;

/**
 * Data container for the org privacy toggles that ride the optional
 * session-sync/search policy contract (ISS-4624, follow-up to #4070).
 *
 * ISS-4668 split this in two: the presentational cards live in
 * `@repo/app/settings/components/org-policy-toggle-card` (prop-driven, with
 * co-located stories for every state), and this wrapper owns the queries,
 * the mutation, and the choice of which card to render.
 *
 * The policy fields are OPTIONAL on the wire because a new app can be live
 * against a previous API that strips them. This container therefore
 * distinguishes three things that are easy to conflate and that the earlier
 * per-card implementations did conflate:
 *
 * 1. loading — the org query hasn't produced data yet;
 * 2. unknown — the query settled but the server sent no value for this field,
 *    so the app genuinely does not know the setting;
 * 3. a real `true`/`false` the server reported.
 *
 * It also refuses to call a save successful on a 200 alone: either the response
 * or the follow-up read has to show the value that was requested, otherwise the
 * write was silently dropped by a previous-generation API and the card says so.
 */
export function OrgPolicyToggleCard({
  isAdmin,
  field,
  title,
  description,
  toggleId,
  toggleLabel,
  toggleHelpText,
}: Readonly<OrgPolicyToggleCardProperties>) {
  const currentUserQuery = useCurrentUser();
  const currentOrganizationId = currentUserQuery.data?.organizationId ?? "";
  const organizationQuery = useOrganization(currentOrganizationId, {
    enabled: Boolean(currentOrganizationId),
  });
  const updateOrganization = useUpdateOrganization();

  if (!isAdmin) {
    return null;
  }

  if (currentUserQuery.isLoading || organizationQuery.isLoading) {
    return <OrgPolicyLoadingState title={title} />;
  }

  if (currentUserQuery.error) {
    return (
      <OrgPolicyErrorState
        description={description}
        message={currentUserQuery.error.message}
        title={title}
        toggleHelpText={toggleHelpText}
      />
    );
  }

  if (organizationQuery.error) {
    return (
      <OrgPolicyErrorState
        description={description}
        message={organizationQuery.error.message}
        title={title}
        toggleHelpText={toggleHelpText}
      />
    );
  }

  // The user settled without an organization, so the org query never runs and
  // never will. That is a settled unknown, not a load in progress — spinning
  // forever here would be its own lie.
  if (!currentOrganizationId) {
    return (
      <OrgPolicyUnavailableState
        description={description}
        title={title}
        toggleHelpText={toggleHelpText}
      />
    );
  }

  const organization = organizationQuery.data;
  if (!organization) {
    // The org query settled without data (e.g. a paused/offline fetch) but is
    // still expected to produce some. Hold the loading card rather than
    // returning null and vanishing the setting off the tab.
    return <OrgPolicyLoadingState title={title} />;
  }

  const state = resolveOrgPolicyFieldState(
    readOrgPolicyField(organization, field)
  );
  const saveState = computeOrgPolicySaveState({
    field,
    organization,
    organizationQuery,
    updateOrganization,
  });

  // A save can fail into the unavailable state: the toggle rendered from cached
  // data, the PUT + invalidated GET hit an older API, and the GET now omits the
  // field. Without carrying the outcome across, the editable card is replaced
  // before it can show the NotConfirmed alert and the admin never learns the
  // requested write was dropped. So the unavailable card keeps the alert.
  if (state === OrgPolicyFieldState.Unavailable) {
    return (
      <OrgPolicyUnavailableState
        description={description}
        saveAlert={saveState.saveAlert}
        title={title}
        toggleHelpText={toggleHelpText}
      />
    );
  }

  return (
    <OrgPolicyEditableCard
      description={description}
      onToggle={(nextChecked: boolean) =>
        updateOrganization.mutate(
          buildOrgPolicyUpdateInput(organization.id, field, nextChecked)
        )
      }
      saveState={saveState}
      state={state}
      title={title}
      toggleHelpText={toggleHelpText}
      toggleId={toggleId}
      toggleLabel={toggleLabel}
    />
  );
}

/**
 * Resolve everything the card needs to know about the last save for one field,
 * scoped to THIS org, so the editable card and the unavailable card agree.
 *
 * Only trust the mutation observer when its variables belong to this org:
 * TanStack retains the previous org's variables/data/status across an org
 * switch without a remount, so an unscoped read would let one org's save paint
 * the other org's card as pending, disabled, or stale-warning.
 *
 * `isSaving` holds the switch at the requested value (and keeps the control
 * disabled) for the whole window the live org read hasn't caught up — while the
 * PUT is pending OR a refetch is still running and `current` does not yet
 * reflect the request — not just while the PUT is pending, so the switch never
 * snaps back mid-reread after the echo already confirmed.
 */
function computeOrgPolicySaveState({
  field,
  organization,
  organizationQuery,
  updateOrganization,
}: {
  field: OrgPolicyField;
  organization: Organization;
  organizationQuery: OrganizationQuery;
  updateOrganization: UpdateOrganizationMutation;
}): OrgPolicySaveState {
  // Reject only a mutation that is provably a DIFFERENT org's (retained across
  // an org switch without a remount). A mutation with no variables yet — e.g. a
  // pending write whose variables the observer hasn't surfaced — can't be
  // disproven as ours, so it still gates the control rather than leaving the
  // switch live mid-write.
  const mutationOrgId = updateOrganization.variables?.id;
  const isOwnMutation =
    mutationOrgId === undefined || mutationOrgId === organization.id;
  const isPending = isOwnMutation && Boolean(updateOrganization.isPending);
  const requested = isOwnMutation
    ? readOrgPolicyField(updateOrganization.variables, field)
    : undefined;
  const echoed = isOwnMutation
    ? readOrgPolicyField(updateOrganization.data, field)
    : undefined;
  const current = readOrgPolicyField(organization, field);
  const isRereading = Boolean(organizationQuery.isFetching);
  const saveOutcome = resolveOrgPolicySaveOutcome({
    isPending,
    isError: isOwnMutation && Boolean(updateOrganization.isError),
    isRereading,
    requested,
    echoed,
    current,
  });
  const isAwaitingReread =
    requested !== undefined && current !== requested && isRereading;
  const isSaving = isPending || isAwaitingReread;

  return {
    requested,
    isSaving,
    saveAlert: ORG_POLICY_SAVE_OUTCOME_ALERTS[saveOutcome],
  };
}
