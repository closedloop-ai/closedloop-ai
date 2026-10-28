"use client";

import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import {
  type WorkspaceMenuCapabilities,
  type WorkspaceMenuCapability,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  WorkspaceMenuHostId,
  type WorkspaceMenuProjection,
  WorkspaceMenuProjectionStatus,
  type WorkspaceMenuWorkspaceSummary,
  workspaceMenuCapabilityError,
  workspaceMenuCapabilityPending,
  workspaceMenuCapabilityReady,
  workspaceMenuCapabilityUnavailable,
} from "@repo/api/src/types/workspace-menu";
import { useLatestElectronRelease } from "@repo/app/desktop/hooks/use-electron-release";
import { withOrgSlug } from "@repo/app/documents/lib/document-navigation";
import { useOptionalAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import {
  useFeatureFlagEnabled,
  useFeatureFlagResolved,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  WEB_CANONICAL_LANDING_HREF,
  WEB_SHELL_ROUTE_HREFS,
} from "@repo/app/shared/lib/primary-nav-destinations";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import {
  buildWebWorkspaceMenuCapabilities,
  narrowCapabilityToStanding,
  STANDINGS_WITHOUT_A_WORKSPACE,
} from "@repo/app/shared/workspace-menu-host/workspace-menu-capabilities";
import type { WorkspaceMenuHostAdapter } from "@repo/app/shared/workspace-menu-host/workspace-menu-host-adapter";
import {
  type LocalTrustedIdentity,
  resolveLocalTrustedUserProfile,
} from "@repo/auth/auth-mode";
import {
  CreateOrganization,
  useClerk,
  useOrganization,
  useOrganizationList,
  useUser,
} from "@repo/auth/client";
import { useLocalTrustedIdentity } from "@repo/auth/local-trusted-client";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useEffect, useMemo } from "react";
import { ThirdPartyHeadingScope } from "@/components/third-party-heading-scope";
import { useNavOrgSlug } from "@/hooks/use-org-slug";
import {
  buildDesktopOrgReturnHref,
  isDesktopAuthorizeRunPathname,
} from "@/lib/desktop-org-return";
import { useActiveOrganizationRecordName } from "./use-active-organization-record-name";

/**
 * ISS-8363 (PRD-691) — the web shell's implementation of the workspace-menu
 * port.
 *
 * It lives in `apps/app` because it imports Clerk, which `packages/app` is gated
 * from doing. Every capability it exposes is an EXISTING production owner
 * rebound to the port — Clerk's organization list, `<CreateOrganization>`,
 * `signOut()`, and the ISS-6877 release lookup — rather than a parallel
 * implementation, which the PRD's Settings ownership clause forbids.
 */

/**
 * The release read, as a capability.
 *
 * A failed or rejected read is an `Error`, never `Unavailable`: web HAS the
 * download feature, and reporting an outage as "this host does not offer it"
 * would tell the user something false about the product. `sanitizeElectronRelease
 * Info` returning null is a rejection of a non-allowlisted URL — also a failure,
 * not an absence.
 */
function toDownloadCapability(
  isPending: boolean,
  isError: boolean,
  downloadUrl: string | null
): WorkspaceMenuCapability {
  // Still in flight is neither a failure nor an absence. The entry is simply not
  // rendered yet, and the MENU does not wait for it — see the projection's gate.
  if (isPending) {
    return workspaceMenuCapabilityPending();
  }
  if (isError || downloadUrl === null) {
    return workspaceMenuCapabilityError(
      WorkspaceMenuCapabilityReason.ReadFailed
    );
  }
  return workspaceMenuCapabilityReady();
}

function useWebDownloadUrl(open: boolean): {
  pending: boolean;
  isError: boolean;
  url: string | null;
} {
  // Not fetched until the menu is open. `isPending` stays true for a disabled
  // query, which is exactly right here: the entry is not renderable yet.
  const release = useLatestElectronRelease({ enabled: open });
  return {
    pending: release.isPending,
    isError: release.isError,
    url: release.data?.downloadUrl ?? null,
  };
}

/**
 * The membership read, as its own capability.
 *
 * Every non-Ready outcome belongs to the SWITCHER, never to the menu: holding
 * the whole projection until the last page lands is how a slow or failing page
 * fetch strands Settings, Members and Log out behind a "Loading" trigger. A
 * failed page also leaves `hasNextPage` true forever, so an error path is not
 * optional here.
 */
function toSwitchCapability(input: {
  isError: boolean;
  isLoading: boolean;
  hasNextPage: boolean;
}): WorkspaceMenuCapability {
  if (input.isError) {
    return workspaceMenuCapabilityError(
      WorkspaceMenuCapabilityReason.ReadFailed
    );
  }
  if (input.isLoading || input.hasNextPage) {
    return workspaceMenuCapabilityPending();
  }
  return workspaceMenuCapabilityReady();
}

/**
 * The paginated membership resource, with its pages followed to the end.
 *
 * Clerk hands back only the pages fetched so far, and this menu is the only
 * switch affordance, so a truncated list makes workspaces UNREACHABLE rather
 * than merely unlisted. Not requested at all until the menu opens.
 */
function useWebMemberships(open: boolean) {
  const { userMemberships, isLoaded, setActive } = useOrganizationList(
    open ? { userMemberships: { infinite: true } } : undefined
  );

  const hasNextPage = userMemberships?.hasNextPage ?? false;
  const isError = userMemberships?.isError ?? false;
  const fetchNext = userMemberships?.fetchNext;
  const isFetching = userMemberships?.isFetching ?? false;

  useEffect(() => {
    // An errored page must stop the walk, or `hasNextPage` stays true and the
    // switcher waits forever on a page that will never arrive.
    if (open && hasNextPage && !(isFetching || isError)) {
      fetchNext?.();
    }
  }, [fetchNext, hasNextPage, isError, isFetching, open]);

  return {
    setActive,
    data: userMemberships?.data ?? [],
    hasNextPage,
    isError,
    isLoading: !isLoaded || (userMemberships?.isLoading ?? false),
  };
}

function useWebWorkspaceMenuProjection({
  open,
}: {
  open: boolean;
}): WorkspaceMenuProjection {
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const { user, isLoaded: userLoaded } = useUser();
  const routeParams = useRouteParams();
  const auth = useOptionalAuthSnapshot();
  const memberships = useWebMemberships(open);
  const download = useWebDownloadUrl(open);
  const localTrustedIdentity = useLocalTrustedIdentity();
  const organizationRecordName = useActiveOrganizationRecordName(
    organization?.id ?? null
  );
  // The release lookup answers the same on every standing — it needs no
  // workspace identity — so the link is resolved ONCE here and rides out on
  // whichever projection this hook returns.
  const downloadUrl = download.isError ? null : download.url;
  const localTrustedProjection = getLocalTrustedProjection(
    {
      identity: localTrustedIdentity,
      orgId: auth.orgId,
      routeOrgSlug: routeParams?.orgSlug,
      userId: auth.userId,
    },
    downloadUrl
  );

  if (localTrustedProjection && !organization) {
    return localTrustedProjection;
  }

  // The SAME answer the capability hook narrows its identity-bound entries with
  // — one owner, so the body that mounts and the rows claiming to be in it
  // cannot disagree about whether this menu has a workspace.
  const standing = webWorkspaceMenuStanding({
    hasLocalTrustedIdentity: localTrustedProjection !== null,
    organization,
    organizationLoaded,
    userLoaded,
  });

  if (standing === WorkspaceMenuProjectionStatus.Pending) {
    return { status: WorkspaceMenuProjectionStatus.Pending, downloadUrl };
  }

  if (standing === WorkspaceMenuProjectionStatus.Error || !organization) {
    return {
      status: WorkspaceMenuProjectionStatus.Error,
      reason: WorkspaceMenuCapabilityReason.ReadFailed,
      downloadUrl,
    };
  }

  // ISS-12135: the active workspace carries the product's own name for it once
  // read, in the trigger and its switcher row alike; Clerk's until then.
  const activeWorkspaceName = organizationRecordName ?? organization.name;
  const workspaces: WorkspaceMenuWorkspaceSummary[] = memberships.data.map(
    ({ organization: membershipOrganization }) => ({
      id: membershipOrganization.id,
      name:
        membershipOrganization.id === organization.id
          ? activeWorkspaceName
          : membershipOrganization.name,
      slug: membershipOrganization.slug,
      imageUrl: membershipOrganization.imageUrl,
    })
  );
  const activeWorkspace: WorkspaceMenuWorkspaceSummary = {
    id: organization.id,
    name: activeWorkspaceName,
    slug: organization.slug,
    imageUrl: organization.imageUrl,
  };

  return {
    status: WorkspaceMenuProjectionStatus.Ready,
    activeWorkspace,
    // The active workspace is always present, even if the membership page has
    // not reached it, so the radio group can always mark the current row.
    workspaces: workspaces.some((workspace) => workspace.id === organization.id)
      ? workspaces
      : [activeWorkspace, ...workspaces],
    actor: {
      name: user?.fullName ?? null,
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      imageUrl: user?.imageUrl ?? null,
    },
    downloadUrl,
  };
}

function useWebWorkspaceMenuCapabilities({
  open,
}: {
  open: boolean;
}): WorkspaceMenuCapabilities {
  const routeParams = useRouteParams();
  const auth = useOptionalAuthSnapshot();
  const download = useWebDownloadUrl(open);
  const memberships = useWebMemberships(open);
  const diagnostics = useDiagnosticsCapability();
  // ISS-11400. Settings and Members are ORG-RELATIVE routes, joined by
  // `useOrgPathBuilder`, which emits them UNPREFIXED when this same hook answers
  // empty — `/settings?panel=members` then matches `[orgSlug]` with
  // `orgSlug = "settings"` and resolves nothing. The menu now opens on a failed
  // or unsettled projection, which is exactly when the slug is missing, so the
  // two entries have to be withheld HERE rather than rendered as dead links.
  // Read from the one source the builder reads, so the row and the href it would
  // have built cannot disagree — the same rule `diagnosticsHref` follows above.
  const { isLoaded: organizationLoaded, organization } = useOrganization();
  const { isLoaded: userLoaded } = useUser();
  const orgSlug = useNavOrgSlug();
  const orgScoped = orgScopedCapability(organizationLoaded, orgSlug);
  const localTrustedIdentity = useLocalTrustedIdentity();
  const localTrusted = isLocalTrustedProjectionInput({
    identity: localTrustedIdentity,
    orgId: auth.orgId,
    routeOrgSlug: routeParams?.orgSlug,
    userId: auth.userId,
  });
  // ISS-11400 review (tamsinb). Switch workspace and Create a workspace are the
  // only two web entries whose controller lives exclusively in
  // `ReadyWorkspaceMenu` — the switcher submenu and its create dialog — so on a
  // Pending or Error standing they were `Ready` with nothing mounted behind
  // them, the same claim-with-no-action the download and invite entries were.
  // Both need a settled organization to do their job (`setActive` activates one
  // by id; the create slot is a Clerk embed), so they are withheld rather than
  // carried through. Log out is deliberately NOT narrowed here: web's `Pending`
  // is a real session with Clerk still hydrating, so signing out works.
  const standing = webWorkspaceMenuStanding({
    hasLocalTrustedIdentity: localTrusted && !organization,
    organization,
    organizationLoaded,
    userLoaded,
  });

  return {
    ...buildWebWorkspaceMenuCapabilities({
      download: toDownloadCapability(
        download.pending,
        download.isError,
        download.url
      ),
    }),
    [WorkspaceMenuEntryId.SwitchWorkspace]: localTrusted
      ? workspaceMenuCapabilityUnavailable(
          WorkspaceMenuCapabilityReason.NotSupportedOnHost
        )
      : narrowCapabilityToStanding(
          toSwitchCapability(memberships),
          standing,
          STANDINGS_WITHOUT_A_WORKSPACE
        ),
    [WorkspaceMenuEntryId.CreateWorkspace]: localTrusted
      ? workspaceMenuCapabilityUnavailable(
          WorkspaceMenuCapabilityReason.NotSupportedOnHost
        )
      : narrowCapabilityToStanding(
          workspaceMenuCapabilityReady(),
          standing,
          STANDINGS_WITHOUT_A_WORKSPACE
        ),
    [WorkspaceMenuEntryId.Diagnostics]: diagnostics,
    [WorkspaceMenuEntryId.Settings]: orgScoped,
    [WorkspaceMenuEntryId.Members]: orgScoped,
  };
}

/**
 * Whether an org-relative destination can be linked at all.
 *
 * THE SLUG DECIDES, and Clerk only breaks the tie it leaves. A slug in hand is
 * the whole operand these two rows need — `useOrgPathBuilder` joins the href
 * from it and from nothing else — so asking `useOrganization().isLoaded` first
 * withheld a row whose link was already valid. Under `AUTH_MODE=local_trusted`
 * that read belongs to a Clerk-free session and never settles, so Settings and
 * Members sat on `Pending` FOREVER while `useNavOrgSlug()` was answering with
 * the synthetic organization's slug: a permanently unreachable Settings, which
 * is the ISS-11400 defect itself wearing `Pending` instead of a disabled
 * trigger.
 *
 * `organizationLoaded` answers only the question that survives an empty slug —
 * whether the read is still arriving (`Pending`) or has settled with nothing
 * (`ReadFailed`, a failure of THIS host's own read rather than "web does not
 * have Settings"). That is the same three-state shape {@link useDiagnosticsCapability}
 * uses; only the order of the two gates changed.
 */
function orgScopedCapability(
  organizationLoaded: boolean,
  orgSlug: string
): WorkspaceMenuCapability {
  if (orgSlug !== "") {
    return workspaceMenuCapabilityReady();
  }
  if (!organizationLoaded) {
    return workspaceMenuCapabilityPending();
  }
  return workspaceMenuCapabilityError(WorkspaceMenuCapabilityReason.ReadFailed);
}

/**
 * ISS-10006 — web HAS a Diagnostics page now, behind the same key that gates
 * the surface on desktop. Off, the route itself 404s, so the entry must be
 * absent rather than a row that lands on "Page not found".
 *
 * THREE STATES, not two. The flag reads unresolved until PostHog has replied,
 * and folding that into `false` would label an unresolved read "this host does
 * not have this concept at all" — a verdict, in place of the `Pending` this
 * menu has for exactly that window. So unresolved is `Pending`, and only a
 * settled `false` is a verdict about this host. The flag is read here, where
 * it is branched on, rather than handed in.
 */
function useDiagnosticsCapability(): WorkspaceMenuCapability {
  const enabled = useFeatureFlagEnabled(DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY);
  const resolved = useFeatureFlagResolved(
    DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY
  );
  if (!resolved) {
    return workspaceMenuCapabilityPending();
  }
  return enabled
    ? workspaceMenuCapabilityReady()
    : workspaceMenuCapabilityUnavailable(
        WorkspaceMenuCapabilityReason.NotSupportedOnHost
      );
}

type LocalTrustedProjectionInput = {
  /**
   * ISS-10335: the resolved synthetic identity, not the fixed literals. The
   * Clerk-free e2e lane binds the synthetic session to the seeded sandbox org,
   * and a literal comparison would go false there — dropping the menu back onto
   * the Clerk-backed projection, whose `useOrganizationList` read has no session
   * to answer it.
   */
  identity: LocalTrustedIdentity | null;
  orgId: string | null;
  routeOrgSlug: string | string[] | undefined;
  userId: string | null;
};

function getLocalTrustedProjection(
  input: LocalTrustedProjectionInput,
  downloadUrl: string | null
): WorkspaceMenuProjection | null {
  if (!isLocalTrustedProjectionInput(input)) {
    return null;
  }

  // ISS-12135: `pnpm vibe up` names the seeded org and owner through the
  // identity's display overrides; every other lane keeps these defaults.
  const workspace = {
    id: input.identity.orgId,
    name: input.identity.orgName ?? LOCAL_TRUSTED_WORKSPACE_NAME,
    slug: input.routeOrgSlug,
    imageUrl: null,
  };
  const profile = resolveLocalTrustedUserProfile(input.identity);

  return {
    status: WorkspaceMenuProjectionStatus.Ready,
    activeWorkspace: workspace,
    workspaces: [workspace],
    actor: {
      name: profile.fullName,
      email: profile.email,
      imageUrl: null,
    },
    // The synthetic identity changes WHO the actor is, not what the host can
    // do: web has the download feature either way, and the release read behind
    // it is already resolved by the time this branch is taken. Hardcoding null
    // dropped the entry on this host entirely — and this is the host every
    // `local_trusted` E2E runs against, so the workspace menu's download row was
    // unreachable there and no spec could observe it on any platform.
    downloadUrl,
  };
}

function isLocalTrustedProjectionInput(
  input: LocalTrustedProjectionInput
): input is LocalTrustedProjectionInput & {
  identity: LocalTrustedIdentity;
  routeOrgSlug: string;
} {
  return (
    input.identity !== null &&
    input.orgId === input.identity.orgId &&
    input.userId === input.identity.userId &&
    typeof input.routeOrgSlug === "string"
  );
}

export function useWebWorkspaceMenuHostAdapter(): WorkspaceMenuHostAdapter {
  const { navigate } = useNavigation();
  const { signOut } = useClerk();
  const createWorkspaceReturnHref = useCreateWorkspaceReturnHref();
  // ISS-10006. Read from `WEB_SHELL_ROUTE_HREFS` rather than spelled again here,
  // so the menu row and the shell's own reachability answer cannot disagree
  // about whether this build has a Diagnostics page.
  //
  // The slug comes from the ROUTE, the way this adapter's capability hook
  // already takes it, rather than from `useOrgSlug()` — that hook also reads
  // Clerk's `useAuth` and the local-trusted identity, which would make every
  // consumer of this adapter owe two more mocks for a string the URL already
  // holds. `undefined` until it resolves: the menu renders the row only with an
  // href, and an absent href and a broken one are different things.
  const menuRouteParams = useRouteParams();
  const menuOrgSlug =
    typeof menuRouteParams?.orgSlug === "string" ? menuRouteParams.orgSlug : "";
  const diagnosticsHref =
    menuOrgSlug === ""
      ? undefined
      : (withOrgSlug(
          menuOrgSlug,
          WEB_SHELL_ROUTE_HREFS[ShellNavigationRouteId.Diagnostics]
        ) ?? undefined);
  // Bare, with no `userMemberships` argument: this call yields `setActive`
  // WITHOUT triggering the membership fetch, so mounting the provider at the
  // composition root costs nothing. The paged read lives in the projection hook,
  // which only runs when the menu itself renders.
  const { setActive } = useOrganizationList();

  const switchWorkspace = useCallback(
    async (workspace: WorkspaceMenuWorkspaceSummary) => {
      if (!setActive) {
        return;
      }
      // Activate by id; navigate by slug. They are different keys, and a route
      // built from the id resolves to nothing.
      await setActive({ organization: workspace.id });
      if (workspace.slug === null) {
        // Nothing safe to navigate to. The activation still succeeded, and
        // `OrgIdentityProvider` reconciles the URL on the next render — better
        // than routing to a path that cannot resolve.
        return;
      }
      // The canonical v2 landing route, not the legacy `/my-tasks` the old menu
      // used. This component only exists inside the v2 tree, so it lands where
      // ISS-8355 says that tree starts — read as a constant, never as a flag.
      navigate(withOrgSlug(workspace.slug, WEB_CANONICAL_LANDING_HREF) ?? "/");
    },
    [navigate, setActive]
  );

  return useMemo<WorkspaceMenuHostAdapter>(
    () => ({
      host: WorkspaceMenuHostId.Web,
      useWorkspaceMenuProjection: useWebWorkspaceMenuProjection,
      useWorkspaceMenuCapabilities: useWebWorkspaceMenuCapabilities,
      diagnosticsHref,
      switchWorkspace,
      // An element, not a mounted component: React does not run
      // `<CreateOrganization>` until the menu renders it inside its dialog.
      //
      // Level 3, not the default 2: the menu's dialog already renders a
      // `DialogTitle`, which is an `h2`. Demoting to 2 would make Clerk's
      // injected headings PEERS of that title instead of children, and leaving
      // the embed unscoped ships a second `h1` on the page (WCAG 2.2 SC 1.3.1).
      // The legacy account menu scopes its own `<CreateOrganization>` the same
      // way for the same reason.
      createWorkspaceSlot: (
        <ThirdPartyHeadingScope level={3}>
          <CreateOrganization
            afterCreateOrganizationUrl={createWorkspaceReturnHref}
            skipInvitationScreen
          />
        </ThirdPartyHeadingScope>
      ),
      signOut: async () => {
        await signOut();
      },
    }),
    [createWorkspaceReturnHref, diagnosticsHref, signOut, switchWorkspace]
  );
}

/**
 * Where Clerk sends the person after they create a workspace here.
 *
 * `/:slug` + the web landing route is the answer for a run that started in the
 * browser, and Clerk substitutes the new organization's slug into it. It is the
 * WRONG answer when the DESKTOP started the run: the desktop opened the
 * authorize URL in the browser and is now sitting on a loopback listener, so
 * landing on the web canonical destination strands it there until it times out
 * (ISS-11272). The sibling sign-in detour already routes either flow back to
 * the authorize page for exactly this reason.
 *
 * The run is recognized from the page the menu is open ON — the authorize
 * consent route is where a desktop-originated run parks while the person is in
 * the browser — and the authorize query rides through so the PKCE challenge,
 * `state`, loopback `redirect_uri` and gateway key reach the consent intact.
 *
 * The BARE authorize path, never the org-scoped one currently in the URL: that
 * slug names the organization the person is LEAVING, and the proxy re-prefixes
 * whichever org the session has active once the new one exists.
 *
 * Nothing here is trusted. The href points at a server route that re-derives
 * the target and validates it before anything navigates.
 */
function useCreateWorkspaceReturnHref(): string {
  const pathname = usePath();
  const searchParams = useSearchParamsValue();

  return useMemo(() => {
    if (!isDesktopAuthorizeRunPathname(pathname)) {
      return `/:slug${WEB_CANONICAL_LANDING_HREF}`;
    }
    const query = searchParams.toString();
    const authorizeTarget = query
      ? `${DESKTOP_AUTHORIZE_PATHNAME}?${query}`
      : DESKTOP_AUTHORIZE_PATHNAME;
    return buildDesktopOrgReturnHref(authorizeTarget);
  }, [pathname, searchParams]);
}

/**
 * WHICH standing the web workspace menu is in, given the four facts that decide
 * it. The twin of desktop's `desktopWorkspaceMenuProjectionStatus`, and exported
 * to nobody: both readers live in this file.
 *
 * ONE owner, read by the projection AND by the capability hook, because a second
 * copy is exactly how "which body mounts" and "which rows claim to be in it"
 * came to disagree.
 *
 * Neither the membership walk nor the release lookup appears here. Each carries
 * its own capability, so a slow, paused or failed one costs its own entry and
 * nothing else — gating the menu on either is how Settings, Members and Log out
 * ended up unreachable behind a permanent "Loading".
 */
function webWorkspaceMenuStanding(input: {
  hasLocalTrustedIdentity: boolean;
  organization: unknown;
  organizationLoaded: boolean;
  userLoaded: boolean;
}): WorkspaceMenuProjectionStatus {
  // The synthetic session resolved server-side before the document was sent, so
  // it is settled even though the Clerk-free reads beside it never will be.
  if (input.hasLocalTrustedIdentity) {
    return WorkspaceMenuProjectionStatus.Ready;
  }
  if (!(input.organizationLoaded && input.userLoaded)) {
    return WorkspaceMenuProjectionStatus.Pending;
  }
  // Every authenticated web route is org-scoped and `OrgIdentityProvider`
  // reconciles the slug before rendering, so a settled read with no active
  // organization is a genuine failure rather than a signed-out state.
  if (!input.organization) {
    return WorkspaceMenuProjectionStatus.Error;
  }
  return WorkspaceMenuProjectionStatus.Ready;
}

/** The local-trusted workspace's name when no display override names it. */
const LOCAL_TRUSTED_WORKSPACE_NAME = "ClosedLoop";
