// @vitest-environment jsdom

import { GUIDED_ONBOARDING_FIRST_RUN_FLAG_KEY } from "@repo/api/src/types/guided-onboarding-first-run-flag";
import type { OnboardingJoinableOrganization } from "@repo/app/onboarding/components/guided-onboarding-data";
import { OnboardingJoinAuthority } from "@repo/app/onboarding/components/guided-onboarding-data";
import type { OrganizationDetails } from "@repo/app/onboarding/components/guided-onboarding-types";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

type CapturedGuidedHostProps = {
  allowStagedOrganizationLogo?: boolean;
  discovery?: unknown;
  brand?: ReactNode;
  joinableOrganization?: OnboardingJoinableOrganization;
  onCreateOrganization?: (
    organization: OrganizationDetails
  ) => Promise<void> | void;
  onJoinOrganization?: (join: {
    authority: string;
    id: string;
  }) => Promise<void> | void;
  onRetryJoinableOrganizationLookup?: () => Promise<void> | void;
};

function membershipPage(names: string[]) {
  return {
    data: names.map((name) => ({
      organization: { id: `org_${name.replace(/\s/g, "_")}`, name },
    })),
    isError: false,
    isFetching: false,
    isLoading: false,
    revalidate: mocks.revalidateMemberships,
  };
}

/**
 * The quiet, empty shape: `isFetching: false`, `isError: false`, `data: []`.
 * Online it is a completed read that found nothing; offline it is a PAUSED read
 * that never ran. The two are byte-identical, which is why connectivity is the
 * discriminator and why both cases are pinned below.
 */
function quietEmptyPage() {
  return {
    count: 0,
    data: [],
    isError: false,
    isFetching: false,
    isLoading: false,
  };
}

/** Puts the jsdom navigator offline (or back online) for one case. */
function setOnline(online: boolean) {
  Object.defineProperty(globalThis.navigator, "onLine", {
    configurable: true,
    value: online,
    writable: true,
  });
}

/** The shape Clerk reports while a read is genuinely in flight. */
function fetchingPage() {
  return { data: [], isError: false, isFetching: true, isLoading: true };
}

function invitationPage(names: string[]) {
  return {
    data: names.map((name) => ({
      accept: mocks.acceptInvitation,
      id: `inv_${name.replace(/\s/g, "_")}`,
      publicOrganizationData: { id: `org_${name.replace(/\s/g, "_")}`, name },
    })),
    isError: false,
    isFetching: false,
    isLoading: false,
    revalidate: mocks.revalidateInvitations,
  };
}

/**
 * Mounts the host the way production reaches a settled read: in flight first,
 * then quiet. Kept two-phase because that IS the common production path, not
 * because a quiet first render would be read differently — `useLookupReported`
 * deliberately does not latch on having seen a fetch, since a warm Clerk cache
 * serves a page with nothing ever fetching.
 */
function renderAfterLookupReports(settled: {
  invitations?: unknown;
  memberships?: unknown;
}) {
  mocks.userMemberships = fetchingPage();
  mocks.userInvitations = fetchingPage();
  // Through the same providers `renderHost` mounts: the host reads `/me` for the
  // organization it renames (ISS-11253), so a bare render of it has no
  // QueryClient and every case in this block throws before it can assert.
  const view = render(hostTree(), { wrapper: WebFeatureFlagProvider });
  mocks.userMemberships = settled.memberships ?? membershipPage([]);
  mocks.userInvitations = settled.invitations ?? invitationPage([]);
  view.rerender(hostTree());
}

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  createOrganization: vi.fn(),
  firstRunEnabled: true,
  organizationListRequest: vi.fn(),
  revalidateInvitations: vi.fn(),
  revalidateMemberships: vi.fn(),
  organizationListLoaded: true,
  organizationLoaded: true,
  userInvitations: null as unknown,
  userMemberships: null as unknown,
  githubStatus: { data: null },
  guidedHostProps: null as CapturedGuidedHostProps | null,
  navigate: vi.fn(),
  organization: null as { name?: string } | null,
  pathname: "/acme/dashboard",
  setActive: vi.fn(),
  setLogo: vi.fn(),
  signOut: vi.fn(),
  slug: "acme",
  user: {
    emailAddresses: [],
    primaryEmailAddress: { emailAddress: "ada@example.test" },
  },
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: mocks.apiGet,
    post: vi.fn(),
    put: mocks.apiPut,
  }),
}));

vi.mock(
  "@repo/app/onboarding/components/guided-onboarding-dialog-host",
  () => ({
    GuidedOnboardingDialogHost: (props: CapturedGuidedHostProps) => {
      mocks.guidedHostProps = props;
      return null;
    },
  })
);

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => mocks.githubStatus,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) =>
    key === GUIDED_ONBOARDING_FIRST_RUN_FLAG_KEY
      ? { enabled: mocks.firstRunEnabled }
      : undefined,
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: mocks.signOut }),
  useOrganization: () => ({
    isLoaded: mocks.organizationLoaded,
    organization: mocks.organization,
  }),
  useOrganizationList: (request?: unknown) => {
    mocks.organizationListRequest(request);
    return {
      createOrganization: mocks.createOrganization,
      isLoaded: mocks.organizationListLoaded,
      setActive: mocks.setActive,
      userInvitations: mocks.userInvitations,
      userMemberships: mocks.userMemberships,
    };
  },
  useUser: () => ({ user: mocks.user }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => mocks.pathname,
}));

vi.mock("@/hooks/use-github-authorize-href", () => ({
  useGitHubAuthorizeHref: () => "/github/connect",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useNavOrgSlug: () => mocks.slug,
}));

describe("WebGuidedOnboardingDialogHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom's `onLine` is a property of the shared navigator, so a case that
    // goes offline would otherwise leak into every case after it.
    setOnline(true);
    mocks.guidedHostProps = null;
    mocks.organization = null;
    mocks.firstRunEnabled = true;
    mocks.organizationLoaded = true;
    mocks.organizationListLoaded = true;
    mocks.userMemberships = membershipPage([]);
    mocks.userInvitations = invitationPage([]);
    mocks.pathname = "/acme/dashboard";
    mocks.slug = "acme";
    mocks.user = {
      emailAddresses: [],
      primaryEmailAddress: { emailAddress: "ada@example.test" },
    };
    mocks.createOrganization.mockResolvedValue({
      id: "org_created",
      setLogo: mocks.setLogo,
    });
    mocks.setLogo.mockResolvedValue({ id: "org_created" });
    mocks.setActive.mockResolvedValue(undefined);
    mocks.revalidateMemberships.mockResolvedValue(undefined);
    mocks.revalidateInvitations.mockResolvedValue(undefined);
    mocks.acceptInvitation.mockResolvedValue({
      publicOrganizationData: { id: "org_accepted" },
    });
    mocks.apiGet.mockResolvedValue({
      id: "user-a",
      organizationId: "org-db-a",
    });
  });

  // ISS-11470. The defect was the host's own `brand` argument, not the lockup:
  // web passed a bare `<span>` (wordmark, no mark) while desktop passed a bare
  // mark. A unit test of `ClosedloopBrandLockup` cannot see that — it stays
  // green with either host still passing its old half — so the assertion has to
  // start at the host and read what it actually handed down.
  it("hands the wizard the full brand lockup: one mark then one wordmark", () => {
    renderHost();

    // Wrapped so the slot's own root element is what `parts` reads: the
    // lockup is the wrapper's only child, and its children are the two halves.
    const { container } = render(<div>{expectGuidedHostProps().brand}</div>, {
      wrapper: WebFeatureFlagProvider,
    });
    const lockup = container.firstElementChild?.firstElementChild;
    const parts = [...(lockup?.children ?? [])];

    // Exactly two children in exactly this order pins BOTH halves and the count
    // at once: a host back on its old half fails on length, not on a `queryBy`
    // that would pass just as happily against a lockup that rendered nothing.
    expect(parts.map((part) => part.tagName.toLowerCase())).toEqual([
      "svg",
      "span",
    ]);
    expect(parts[1]?.textContent).toBe("Closedloop.ai");
    // One accessible name for the brand, carried by the wordmark: the mark must
    // stay hidden so the pair is announced once rather than twice.
    expect(parts[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  // ISS-11591's web half. The desktop adapter is the only producer of source
  // rows; the web shell measures nothing locally, so it must hand the wizard no
  // `discovery` at all and let the shared default carry the shipped empty
  // state. A web host that started passing a roster it had not measured is
  // exactly how "Not reported" rows would reach this shell.
  it("hands the wizard no locally-measured discovery, so it can list no sources", () => {
    renderHost();

    expect("discovery" in expectGuidedHostProps()).toBe(false);
  });

  it("persists created organization details and staged logo through Clerk", async () => {
    renderHost();

    const props = expectGuidedHostProps();
    const logoFile = new File(["logo"], "logo.png", { type: "image/png" });
    await props.onCreateOrganization?.({
      logoFile,
      name: "Acme Research",
      slug: "acme-research",
    });

    expect(props.allowStagedOrganizationLogo).toBe(true);
    expect(mocks.createOrganization).toHaveBeenCalledWith({
      name: "Acme Research",
      slug: "acme-research",
    });
    expect(mocks.setLogo).toHaveBeenCalledWith({ file: logoFile });
    expect(mocks.setActive).toHaveBeenCalledWith({
      organization: "org_created",
    });
  });

  // ISS-11145, the regression. Every shipped host passed `undefined` whenever
  // there was no ACTIVE organization, which the dialog defaults to `unknown` —
  // so the step's `none` arm had no producer at all and an existing member with
  // no active organization read a `role="status"` skeleton announcing a check
  // that had already finished. What makes this the load-bearing assertion is
  // that it is the PRODUCTION host's own output: with the resolver unwired it
  // reads `undefined`, not `{ status: "none" }`.
  it("states a settled, empty organization lookup as none rather than as a pending one", () => {
    renderAfterLookupReports({});

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "none",
    });
  });

  // Each conjunct of the host's `lookupSettled` / `lookupFailed` predicate is
  // varied on its own below, so dropping any one of them turns a case red
  // rather than leaving the suite green over a narrower predicate.
  it("keeps the pending arm while the membership lookup has not reported", () => {
    mocks.userMemberships = fetchingPage();

    render(hostTree(), { wrapper: WebFeatureFlagProvider });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });
  });

  it("keeps the pending arm while the invitation lookup has not reported", () => {
    mocks.userInvitations = fetchingPage();

    render(hostTree(), { wrapper: WebFeatureFlagProvider });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });
  });

  it("keeps the pending arm until the organization list itself has loaded", () => {
    mocks.organizationListLoaded = false;

    renderAfterLookupReports({});

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });
  });

  it("keeps the pending arm until the active organization has loaded", () => {
    mocks.organizationLoaded = false;

    renderAfterLookupReports({});

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });
  });

  // ISS-11158 CHANGED these two expectations deliberately: ISS-11145 routed a
  // failed read to `unknown` because no arm for it existed, and `unknown` renders
  // a live region announcing a check that Clerk's `isError` says has already
  // exhausted its retries. The arm exists now, so the host states the failure —
  // still never "you have nothing to join".
  it("reports a failed membership read as unavailable, never as an empty one", () => {
    renderAfterLookupReports({
      memberships: { ...membershipPage([]), isError: true },
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unavailable",
    });
  });

  it("reports a failed invitation read as unavailable, never as an empty one", () => {
    renderAfterLookupReports({
      invitations: { ...invitationPage([]), isError: true },
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unavailable",
    });
  });

  // ISS-11158: the retry must reach Clerk, and it must re-read BOTH lists —
  // the step states one combined answer, so re-running only the errored half
  // would leave the other's stale page standing behind it.
  it("re-reads both Clerk lists when the failed-lookup arm retries", async () => {
    renderAfterLookupReports({
      memberships: { ...membershipPage([]), isError: true },
    });

    await expectGuidedHostProps().onRetryJoinableOrganizationLookup?.();

    expect(mocks.revalidateMemberships).toHaveBeenCalledTimes(1);
    expect(mocks.revalidateInvitations).toHaveBeenCalledTimes(1);
  });

  // The other half of that retry, and the expectation ISS-11158 review
  // (tamsinb) CHANGED: this used to assert the pending arm, which unmounted the
  // failure card — and with it the Retry the reader had just pressed — dropping
  // keyboard focus to the dialog container. The failure arm now survives its own
  // retry and carries `lookupRetrying`, so the control stays mounted and goes
  // busy instead. The card's sentence is past tense, so it is still true while
  // the new read runs. `isFetching` is asserted on BOTH sides below so the flag
  // cannot be a constant.
  it("keeps the failure arm, marked retrying, while a failed read is re-fetched", () => {
    renderAfterLookupReports({
      memberships: { ...membershipPage([]), isError: true, isFetching: true },
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      lookupRetrying: true,
      status: "unavailable",
    });
  });

  it("leaves the failure arm unmarked while no re-read is in flight", () => {
    renderAfterLookupReports({
      memberships: { ...membershipPage([]), isError: true, isFetching: false },
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unavailable",
    });
  });

  it("offers a membership the account holds outside its active organization", () => {
    renderAfterLookupReports({
      memberships: membershipPage(["Acme Research"]),
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      join: {
        authority: OnboardingJoinAuthority.Membership,
        id: "org_Acme_Research",
      },
      name: "Acme Research",
      status: "available",
    });
  });

  // ISS-11145: Join must JOIN. A membership is activated through Clerk; the
  // shared host advances only once that resolves.
  it("activates a membership when the reader presses Join", async () => {
    renderAfterLookupReports({
      memberships: membershipPage(["Acme Research"]),
    });

    await expectGuidedHostProps().onJoinOrganization?.({
      authority: OnboardingJoinAuthority.Membership,
      id: "org_Acme_Research",
    });

    expect(mocks.setActive).toHaveBeenCalledWith({
      organization: "org_Acme_Research",
    });
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  // An invitation is not yet a membership, so it is ACCEPTED first and only the
  // resulting organization is made active.
  it("accepts an invitation before activating its organization", async () => {
    renderAfterLookupReports({
      invitations: invitationPage(["Acme Research"]),
    });

    await expectGuidedHostProps().onJoinOrganization?.({
      authority: OnboardingJoinAuthority.Invitation,
      id: "inv_Acme_Research",
    });

    expect(mocks.acceptInvitation).toHaveBeenCalledTimes(1);
    expect(mocks.setActive).toHaveBeenCalledWith({
      organization: "org_accepted",
    });
  });

  it("rejects rather than silently succeeding when the invitation is gone", async () => {
    renderAfterLookupReports({
      invitations: invitationPage(["Acme Research"]),
    });

    await expect(
      expectGuidedHostProps().onJoinOrganization?.({
        authority: OnboardingJoinAuthority.Invitation,
        id: "inv_revoked",
      })
    ).rejects.toThrow("That invitation is no longer available.");
    expect(mocks.setActive).not.toHaveBeenCalled();
  });

  it("propagates a failed activation instead of reporting a join it did not make", async () => {
    mocks.setActive.mockRejectedValue(new Error("clerk down"));
    renderAfterLookupReports({
      memberships: membershipPage(["Acme Research"]),
    });

    await expect(
      expectGuidedHostProps().onJoinOrganization?.({
        authority: OnboardingJoinAuthority.Membership,
        id: "org_Acme_Research",
      })
    ).rejects.toThrow("clerk down");
  });

  it("offers an organization the account was invited to", () => {
    renderAfterLookupReports({
      invitations: invitationPage(["Acme Research"]),
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      join: {
        authority: OnboardingJoinAuthority.Invitation,
        id: "inv_Acme_Research",
      },
      name: "Acme Research",
      status: "available",
    });
  });

  // The ACTIVE organization needs no join, so it carries no target — and the step
  // renders "Selected" for it rather than a Join button.
  it("names the active organization ahead of the lookup, with no join target", () => {
    mocks.organization = { name: "Acme" };

    renderAfterLookupReports({
      memberships: membershipPage(["Acme Research"]),
    });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      name: "Acme",
      status: "available",
    });
  });

  // The offline case. A paused TanStack query reports `isLoading: false`,
  // `isError: false` and an empty `data`, which is byte-identical to a completed
  // read that found nothing — so a predicate built on `!isLoading` would state
  // "No authorized organization is ready to join" over a fetch that never ran.
  it("does not mistake a paused, never-run lookup for a settled empty one", () => {
    setOnline(false);
    mocks.userMemberships = quietEmptyPage();
    mocks.userInvitations = quietEmptyPage();

    render(hostTree(), { wrapper: WebFeatureFlagProvider });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });
  });

  // PR #7877 review (whitlockk). Seeing `isFetching` once is not a report: a list
  // that starts online and then pauses before it returns comes back to the
  // quiet, empty shape, and a latch set on that first frame claimed `none` for
  // a lookup that never answered. The pending arm is held by connectivity, not
  // by a one-way flag, so the same sequence now stays `unknown`.
  it("keeps the pending arm when a started lookup pauses before it answers", () => {
    mocks.userMemberships = fetchingPage();
    mocks.userInvitations = fetchingPage();
    const view = render(hostTree(), { wrapper: WebFeatureFlagProvider });
    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });

    setOnline(false);
    mocks.userMemberships = quietEmptyPage();
    mocks.userInvitations = quietEmptyPage();
    view.rerender(hostTree());

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "unknown",
    });
  });

  // PR #7877 review (tamsinb). The mirror defect: Clerk keeps these lists in
  // one module-level QueryClient with a 60s staleTime, so a remount inside that
  // window serves the cached page with NOTHING ever fetching. A latch waiting to
  // see a fetch never sets, and the ISS-11145 skeleton returns on a second
  // mount. A first render that is already quiet, online, and empty is a report.
  it("reads a warm cache hit with nothing in flight as a settled empty lookup", () => {
    mocks.userMemberships = quietEmptyPage();
    mocks.userInvitations = quietEmptyPage();

    render(hostTree(), { wrapper: WebFeatureFlagProvider });

    expect(expectGuidedHostProps().joinableOrganization).toEqual({
      status: "none",
    });
  });

  it("keeps the pre-flag shape and requests no lists while the gate is closed", () => {
    mocks.firstRunEnabled = false;

    render(hostTree(), { wrapper: WebFeatureFlagProvider });

    expect(expectGuidedHostProps().joinableOrganization).toBeUndefined();
    expect(mocks.organizationListRequest).toHaveBeenCalledWith(undefined);
  });

  // This host mounts on every authenticated page, so the membership and
  // invitation lists are requested only behind the gate.
  it("requests the membership and invitation lists once the gate is open", () => {
    render(hostTree(), { wrapper: WebFeatureFlagProvider });

    expect(mocks.organizationListRequest).toHaveBeenCalledWith({
      userInvitations: true,
      userMemberships: true,
    });
  });
});

/**
 * The host reads `/me` for the organization row id and resolves the URL-resync
 * port off the auth adapter (ISS-11253), so it needs both providers even though
 * this file only exercises the create path.
 */
function renderHost() {
  render(hostTree(), { wrapper: WebFeatureFlagProvider });
}

/**
 * The host under the providers production gives it: a QueryClient for the `/me`
 * read behind `useCurrentUser`, and the auth adapter behind the organization
 * identity resync. Returned as an ELEMENT rather than rendered, so a case that
 * re-renders to move a lookup from in-flight to settled mounts the same tree.
 */
function hostTree() {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <WebGuidedOnboardingDialogHost />
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

function expectGuidedHostProps(): CapturedGuidedHostProps {
  if (!mocks.guidedHostProps) {
    throw new Error("Guided host props were not captured.");
  }
  return mocks.guidedHostProps;
}
