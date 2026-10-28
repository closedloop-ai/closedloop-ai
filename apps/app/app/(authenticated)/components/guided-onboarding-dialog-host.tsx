"use client";

import { GUIDED_ONBOARDING_FIRST_RUN_FLAG_KEY } from "@repo/api/src/types/guided-onboarding-first-run-flag";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  isBlockingPhase,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { ClosedloopBrandLockup } from "@repo/app/onboarding/components/closedloop-brand-lockup";
import type {
  OnboardingJoinableOrganization,
  OnboardingOrganizationJoin,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { OnboardingJoinAuthority } from "@repo/app/onboarding/components/guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "@repo/app/onboarding/components/guided-onboarding-dialog-host";
import type { OrganizationDetails } from "@repo/app/onboarding/components/guided-onboarding-types";
import { useGuidedOnboardingSnapshot } from "@repo/app/onboarding/hooks/use-guided-onboarding";
import { isDesktopAuthorizeConsentPath } from "@repo/app/onboarding/lib/desktop-authorize-consent-path";
import { resolveJoinableOrganization } from "@repo/app/onboarding/lib/guided-onboarding-joinable-organization";
import { useUpdateOrganization } from "@repo/app/organizations/hooks/use-organizations";
import { useOrganizationIdentityResync } from "@repo/app/shared/auth/use-organization-identity-resync";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import {
  useClerk,
  useOrganization,
  useOrganizationList,
  useUser,
} from "@repo/auth/client";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSyncExternalStore } from "react";
import { useGitHubAuthorizeHref } from "@/hooks/use-github-authorize-href";
import { useNavOrgSlug } from "@/hooks/use-org-slug";
import { isDesktopOwnedRun } from "./guided-onboarding-run-ownership";

/**
 * ISS-11910 / ISS-11912 — the takeover is suppressed on the desktop
 * authorize/consent page, the same exemption `OnboardingGuard` already applies
 * to its `/onboarding` redirect and for the same reason: the desktop is waiting
 * on a short-lived authorization code while this page is open.
 *
 * Mounted from the sidebar, this host opened on EVERY authenticated page,
 * including that one — so a desktop sign-up ran the entire web wizard (Welcome,
 * Choose organization, Invite, Download Mac Desktop App, Connect GitHub) on top
 * of the consent card before the reader could reach Connect. The measured cost
 * was ~2.5 minutes of browser detour, a second DMG download, an organization
 * named twice, and a desktop stuck on "Loading"; and because the detour posted
 * a WEB guided-onboarding attempt, the desktop then adopted that web position
 * instead of its own guest progress and never reached its own `SyncPolicy`
 * step — so the device was never asked for a sync level and uploaded nothing
 * (ISS-11912).
 *
 * Suppressing the takeover here is what lets the consent page hand back at
 * once; the desktop owns the rest of the run. The proxy already bounces every
 * other signed-in page back to this one while a run is pending
 * (`shouldBounceToDesktopAuthorizeRun`), so this single route is the whole
 * pending-run window.
 */
export function WebGuidedOnboardingDialogHost() {
  const pathname = usePath();
  const onDesktopAuthorizeConsent = isDesktopAuthorizeConsentPath(pathname);
  const orgSlug = useNavOrgSlug();
  const { navigate } = useNavigation();
  const { signOut } = useClerk();
  // ISS-11145 (ISS-4779 closed-by-default). ONE read site: this boolean picks
  // between two whole `joinableOrganization` shapes below and is never handed
  // onward. Off, the host keeps its shipped behavior exactly — `undefined`
  // whenever there is no active organization, which the dialog defaults to
  // `unknown` — and requests no membership or invitation list at all.
  const firstRunOrganizationDiscoveryEnabled = useFeatureFlagEnabled(
    GUIDED_ONBOARDING_FIRST_RUN_FLAG_KEY
  );
  const { isLoaded: organizationLoaded, organization } = useOrganization();
  // The memberships and invitations are what make "there is nothing here" a
  // statable fact. Requested only behind the gate, because this host mounts on
  // every authenticated page. Without `infinite`, because the question is
  // whether the account holds AT LEAST ONE joinable organization and the first
  // page already answers that — paging to the end would only add a way for the
  // lookup never to settle.
  //
  // The consent page is excluded for the same reason the GitHub status read
  // below is: these two lists feed only the Choose organization step, which
  // cannot render on a route this host returns `null` for, so requesting them
  // there buys two Clerk round trips and nothing a reader can see.
  const {
    createOrganization,
    isLoaded: organizationListLoaded,
    setActive,
    userInvitations,
    userMemberships,
  } = useOrganizationList(
    firstRunOrganizationDiscoveryEnabled && !onDesktopAuthorizeConsent
      ? { userInvitations: true, userMemberships: true }
      : undefined
  );
  const membershipsReported = useLookupReported(userMemberships);
  const invitationsReported = useLookupReported(userInvitations);
  const { user } = useUser();
  const currentUser = useCurrentUser();
  const updateOrganization = useUpdateOrganization();
  const resyncOrganizationIdentity = useOrganizationIdentityResync();
  const githubStatus = useGitHubIntegrationStatus({
    enabled: Boolean(orgSlug) && !onDesktopAuthorizeConsent,
  });
  const dashboardHref = orgSlug ? `/${orgSlug}/dashboard` : "/";
  const githubAuthorizeHref = useGitHubAuthorizeHref({ returnTo: pathname });
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses.at(0)?.emailAddress ??
    null;
  const organizationName = organization?.name ?? "";
  const joinableOrganization = firstRunOrganizationDiscoveryEnabled
    ? resolveJoinableOrganization({
        activeOrganizationName: organizationName,
        // Clerk's own membership/invitation authority. Nothing here is derived
        // from the account's email domain: the 2026-09-03 organization-discovery
        // decision forbids claiming a domain match, and no prefill exists.
        // Each carries the target the host needs to HONOR Join, so the button is
        // offered only where the join can actually be performed.
        joinableOrganizations: [
          ...(userMemberships?.data ?? []).map((membership) => ({
            join: {
              authority: OnboardingJoinAuthority.Membership,
              id: membership.organization.id,
            },
            name: membership.organization.name,
          })),
          ...(userInvitations?.data ?? []).map((invitation) => ({
            join: {
              authority: OnboardingJoinAuthority.Invitation,
              id: invitation.id,
            },
            name: invitation.publicOrganizationData.name,
          })),
        ],
        // An errored page is not an empty one, so it can never render "you have
        // nothing to join" — it resolves the `unavailable` arm, which says the
        // check could not be completed and carries the Retry below (ISS-11158).
        lookupFailed:
          (userMemberships?.isError ?? false) ||
          (userInvitations?.isError ?? false),
        // Which of the two errored does not matter: the step renders one Retry
        // that re-reads both, so either one being back in flight makes that
        // control busy.
        lookupRetrying:
          (userMemberships?.isError === true &&
            userMemberships?.isFetching === true) ||
          (userInvitations?.isError === true &&
            userInvitations?.isFetching === true),
        lookupSettled:
          organizationLoaded &&
          organizationListLoaded &&
          membershipsReported &&
          invitationsReported,
      })
    : legacyJoinableOrganization(organizationName);

  // The shared host observes this query key too. Poll only across the Desktop
  // handoff, so the browser notices the run completing on the other host.
  const guidedSnapshot = useGuidedOnboardingSnapshot(OnboardingHost.Web, {
    enabled: !onDesktopAuthorizeConsent,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => desktopHandoffPollInterval(query.state.data),
  });

  // After every hook, never before one: the suppression is a render decision,
  // and an early return above would make the hook order depend on the route.
  if (onDesktopAuthorizeConsent) {
    return null;
  }
  // Operator ruling, 2026-10-10: "web shouldn't start an onboarding if desktop
  // has started, no one should get 2 of them". A run Desktop starts or continues holds
  // Desktop-only phases, so Web restores it as a fresh Welcome; showing that
  // was the second wizard, and its first transition overwrote the Desktop run
  // on the server, which is what restarted the Desktop wizard afterwards.
  // Standing down here posts nothing, so the run stays Desktop's to finish.
  // A RESUMED step is not a second run: it is one the reader asked for from the
  // Getting started card on this page, so it still opens.
  if (isDesktopOwnedRun(guidedSnapshot.data)) {
    return null;
  }

  return (
    <GuidedOnboardingDialogHost
      account={email ? { email, status: "signed-in" } : undefined}
      allowStagedOrganizationLogo
      analysisStarted={false}
      brand={<ClosedloopBrandLockup />}
      dashboardActive={pathname === dashboardHref}
      desktopMode={false}
      githubStatus={githubStatus.data}
      host={OnboardingHost.Web}
      joinableOrganization={joinableOrganization}
      onBackFallback={() => navigate(dashboardHref)}
      onConnectGitHub={() => navigate(githubAuthorizeHref)}
      onCreateOrganization={handleCreateOrganization}
      onDashboardAvailable={() => navigate(dashboardHref)}
      onJoinOrganization={handleJoinOrganization}
      onRenameOrganization={handleRenameOrganization}
      onRetryJoinableOrganizationLookup={retryJoinableOrganizationLookup}
      // The raw promise, not a swallowed one: the shared host clears the
      // onboarding flow session only when the sign-out actually resolves.
      onSignOut={() => signOut()}
      organizationChosen={Boolean(organization)}
      organizationName={organizationName}
      organizationSlug={orgSlug}
    />
  );

  /**
   * Re-issue the membership and invitation reads after one of them errored.
   *
   * Clerk's own `revalidate` on each paginated resource, not a remount: these
   * lists live in one module-level `QueryClient`, so re-requesting them is the
   * only thing that clears an exhausted error. Both are re-run regardless of
   * which one failed — the step states one combined answer, so retrying only the
   * errored half would leave the other's stale page standing behind it.
   *
   * Absent on the pre-flag branch by construction: `useOrganizationList` with no
   * params returns `PaginatedResourcesWithDefault`, whose `revalidate` is
   * `undefined`, and that branch has no `unavailable` arm to retry from anyway.
   */
  async function retryJoinableOrganizationLookup() {
    await Promise.allSettled([
      userMemberships?.revalidate?.(),
      userInvitations?.revalidate?.(),
    ]);
  }

  /**
   * Honor Join for an organization this account holds but has not activated.
   *
   * A membership is activated. An invitation must be ACCEPTED first — accepting
   * is what turns it into a membership, and only then can it be made active.
   * Both THROW on failure, which is what keeps the shared host from advancing the
   * run past a join that did not happen.
   */
  async function handleJoinOrganization(join: OnboardingOrganizationJoin) {
    if (!setActive) {
      throw new Error("Organization switching is unavailable.");
    }
    if (join.authority === OnboardingJoinAuthority.Membership) {
      await setActive({ organization: join.id });
      return;
    }
    const invitation = (userInvitations?.data ?? []).find(
      (candidate) => candidate.id === join.id
    );
    if (!invitation) {
      throw new Error("That invitation is no longer available.");
    }
    const accepted = await invitation.accept();
    await setActive({ organization: accepted.publicOrganizationData.id });
  }

  /**
   * ISS-11253: names the organization the session is ALREADY acting in — the one
   * Clerk's signup task created for a first user. That is a DIFFERENT operation
   * from `createOrganization` below, and the distinction is the whole point: a
   * create here would add a second organization and restart the run on it, which
   * is the defect ISS-11090 fixed. No `setActive` either, because the session is
   * already active in this organization.
   *
   * Through `PUT /organizations/[id]`, not Clerk's client SDK. Clerk alone
   * leaves Closedloop's own `organizations` row on the old name and slug until
   * the `organization.updated` webhook lands — and if it is delayed or never
   * delivered, every database-backed read disagrees with Clerk while onboarding
   * has already advanced. The route writes Clerk and the database together,
   * resolves slug conflicts, and rolls Clerk back when the database write fails
   * (codex, ISS-11253 review).
   *
   * The resync is what MOVES THE READER. This dialog is mounted from the
   * sidebar, so a first user presses Continue while sitting on `/acme/...`; once
   * the token carries `ada-labs`, `OrgIdentityProvider` matches the old segment
   * against neither the JWT nor the membership list and the page underneath
   * would `notFound()`. `useOrganizationIdentityResync` reloads the Clerk
   * organization and session and re-anchors the URL onto the new slug — the same
   * contract the Settings rename already depends on (tamsinb, ISS-11253
   * review). It is a no-op for a name-only save.
   */
  async function handleRenameOrganization({
    name,
    slug,
  }: {
    name: string;
    slug: string;
  }) {
    const organizationId = currentUser.data?.organizationId;
    if (!organizationId) {
      throw new Error("No active organization to rename.");
    }
    const updated = await updateOrganization.mutateAsync({
      id: organizationId,
      name,
      slug,
    });
    await resyncOrganizationIdentity(updated.slug);
  }

  async function handleCreateOrganization({
    logoFile,
    name,
    slug,
  }: OrganizationDetails) {
    if (!(createOrganization && setActive)) {
      throw new Error("Organization creation is unavailable.");
    }

    const createdOrganization = await createOrganization({ name, slug });
    const activeOrganization = logoFile
      ? await createdOrganization.setLogo({ file: logoFile })
      : createdOrganization;
    await setActive({ organization: activeOrganization.id });
  }
}

/**
 * The shipped, pre-flag shape: an active organization or nothing at all, which
 * the dialog reads as `unknown`. Kept as the flag-off branch so a reader with the
 * gate closed sees exactly what they saw before.
 */
function legacyJoinableOrganization(
  organizationName: string
): OnboardingJoinableOrganization | undefined {
  return organizationName
    ? { name: organizationName, status: "available" }
    : undefined;
}

/**
 * The fields of a Clerk paginated resource this predicate reads. Structural and
 * fully optional so the two list shapes (`organization` vs
 * `publicOrganizationData`) and both halves of Clerk's
 * `PaginatedResources | PaginatedResourcesWithDefault` union share one
 * predicate without a cast.
 */
type ClerkLookupResource = {
  count?: number;
  data?: unknown;
  isError?: boolean;
  isFetching?: boolean;
  isLoading?: boolean;
};

const ONLINE_EVENTS = ["online", "offline"] as const;

function subscribeToConnectivity(onChange: () => void): () => void {
  const target = globalThis.window;
  if (!target) {
    return () => undefined;
  }
  for (const event of ONLINE_EVENTS) {
    target.addEventListener(event, onChange);
  }
  return () => {
    for (const event of ONLINE_EVENTS) {
      target.removeEventListener(event, onChange);
    }
  };
}

/**
 * Whether the browser currently has connectivity, re-rendering when that
 * changes. SSR and any runtime without `navigator` assume online, because the
 * pending arm this feeds must not be entered on a guess.
 */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToConnectivity,
    () => globalThis.navigator?.onLine !== false,
    () => true
  );
}

/**
 * Whether a Clerk list read has actually REPORTED.
 *
 * `!isLoading` alone is not that signal. Clerk's `isLoading` is TanStack's
 * `isPending && isFetching`, so a PAUSED query — the offline case — reports
 * `isLoading: false` AND `isError: false`, while Clerk masks the absent page as
 * `data: []` and `count: 0`. Read through `!isLoading`, that pause is
 * byte-indistinguishable from a completed read that found nothing, and the step
 * would state "No authorized organization is ready to join" over a fetch that
 * never ran — the exact conflation ISS-11145 exists to remove.
 *
 * A LATCH ON `isFetching` IS NOT THE ANSWER EITHER, in both directions, which is
 * why this reads the resource fresh every render instead:
 *  - Seeing a fetch START is not a report. A list that goes online, starts, and
 *    then pauses before it returns comes back to the empty, non-fetching shape
 *    with the latch already set, and the resolver claims `none` for a lookup
 *    that never answered.
 *  - Never seeing one is not a pending read. Clerk keeps these lists in one
 *    module-level `QueryClient` with a 60s `staleTime`, so a remount inside that
 *    window serves the cached page with nothing fetching at all; a latch that
 *    waits for a fetch it will never see shows the ISS-11145 skeleton again, on
 *    a second mount.
 *
 * `PaginatedResources` carries no `isFetched`/`fetchStatus`, so completed-empty
 * and paused-empty differ in exactly one observable: connectivity. SWR pauses
 * only while the browser is offline. So a read has reported when it FAILED, when
 * it produced rows or a count, or when nothing is in flight AND we are online —
 * and an offline reader keeps the pending arm, which is true, and is the honest
 * half of the pair.
 */
function useLookupReported(resource: ClerkLookupResource | undefined): boolean {
  const online = useOnline();
  if (!resource) {
    return false;
  }
  // An errored read HAS reported, in flight or not. A retry of it is carried as
  // `lookupRetrying` instead, which renders the SAME failure card with a busy
  // Retry: dropping to the pending arm here would unmount the control the reader
  // just pressed and hand keyboard focus back to the dialog container
  // (ISS-11158 review, tamsinb). TanStack keeps `isError` set across a refetch,
  // which is what makes both readings available from one resource.
  if (resource.isError === true) {
    return true;
  }
  if (
    (Array.isArray(resource.data) && resource.data.length > 0) ||
    (resource.count ?? 0) > 0
  ) {
    return true;
  }
  return online && resource.isFetching !== true && resource.isLoading !== true;
}

/** A browser left at the installer step observes the same run completing in Desktop. */
function desktopHandoffPollInterval(
  snapshot: GuidedOnboardingSnapshot | undefined
): number | false {
  if (
    !snapshot ||
    snapshot.state.resuming ||
    !isBlockingPhase(snapshot.state.phase)
  ) {
    return false;
  }
  return snapshot.state.phase === OnboardingPhase.DownloadDesktop ||
    snapshot.context.desktopAppDownloaded
    ? DESKTOP_HANDOFF_POLL_INTERVAL_MS
    : false;
}

const DESKTOP_HANDOFF_POLL_INTERVAL_MS = 5000;
