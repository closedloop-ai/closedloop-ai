import {
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
  WorkspaceMenuProjectionStatus,
} from "@repo/api/src/types/workspace-menu";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_ID,
} from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  WebFeatureFlagProvider,
  withWebFeatureFlagProvider,
} from "@/__tests__/helpers/web-feature-flag-provider";

/** What a `local_trusted` harness resolves when no ISS-10335 override is set. */
const LOCAL_TRUSTED_IDENTITY = {
  orgId: LOCAL_TRUSTED_ORG_ID,
  orgSlug: LOCAL_TRUSTED_ORG_SLUG,
  userId: LOCAL_TRUSTED_USER_ID,
};

/** The seeded sandbox identity the Clerk-free e2e lane binds instead. */
const SEEDED_SANDBOX_IDENTITY = {
  orgId: "org_2seededsandbox",
  orgSlug: "seed-sandbox",
  userId: "user_2seededsandbox",
};

/**
 * The web projection's LOADING GATE.
 *
 * The Desktop-release read is optional and, offline, a `useQuery` is PAUSED
 * rather than failed — `isPending` stays true indefinitely. Gating the whole
 * projection on it left Settings, Members and Log out behind a "Loading"
 * trigger for as long as the machine was offline. The membership read is the
 * opposite case: the switcher is unusable without the full list, so a further
 * page genuinely IS a reason to wait.
 */

const release = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  data: null as { downloadUrl: string } | null,
}));
const identity = vi.hoisted(() => ({
  organization: {
    id: "org_1",
    name: "Closedloop",
    slug: "closedloop",
    imageUrl: null,
  } as {
    id: string;
    name: string;
    slug: string;
    imageUrl: string | null;
  } | null,
  organizationLoaded: true,
  user: {
    fullName: "Ada Lovelace",
    primaryEmailAddress: { emailAddress: "ada@closedloop.ai" },
    imageUrl: null,
  } as {
    fullName: string | null;
    primaryEmailAddress: { emailAddress: string } | null;
    imageUrl: string | null;
  } | null,
  userLoaded: true,
}));
const routeParams = vi.hoisted(() => ({
  current: {
    orgSlug: "closedloop" as string | string[] | undefined,
  } as { orgSlug: string | string[] | undefined } | undefined,
}));
const memberships = vi.hoisted(() => ({
  data: [] as { organization: Record<string, unknown> }[],
  hasNextPage: false,
  isFetching: false,
  isLoading: false,
  isError: false,
  fetchNext: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useClerk: () => ({ signOut: () => Promise.resolve() }),
  useOrganization: () => ({
    organization: identity.organization,
    isLoaded: identity.organizationLoaded,
  }),
  useUser: () => ({
    user: identity.user,
    isLoaded: identity.userLoaded,
  }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: vi.fn(),
    userMemberships: memberships,
  }),
}));

const diagnosticsFlag = vi.hoisted(() => ({
  current: undefined as { enabled: boolean } | undefined,
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => release,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => routeParams.current,
}));

// ISS-10006 — the Diagnostics entry reads a PostHog key. `undefined` is the
// unresolved window, which the adapter must report as Pending rather than as a
// verdict about this host.
vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => diagnosticsFlag.current,
}));

// ISS-12135: the product's org-name read needs a query client this suite
// does not mount; `null` keeps every case on Clerk's own name.
vi.mock("../use-active-organization-record-name", () => ({
  useActiveOrganizationRecordName: () => null,
}));

const { useWebWorkspaceMenuHostAdapter } = await import(
  "../web-workspace-menu-host-adapter"
);

const RELEASE_DOWNLOAD_URL = "https://example.com/Closedloop-universal.dmg";

function readAdapter(
  open = true,
  wrapper?: (props: { children: ReactNode }) => ReactNode
) {
  const { result } = renderHook(
    () => {
      const adapter = useWebWorkspaceMenuHostAdapter();
      return {
        projection: adapter.useWorkspaceMenuProjection({ open }),
        capabilities: adapter.useWorkspaceMenuCapabilities({ open }),
      };
    },
    {
      wrapper: wrapper
        ? withWebFeatureFlagProvider(wrapper)
        : WebFeatureFlagProvider,
    }
  );
  return result.current;
}

beforeEach(() => {
  release.isPending = false;
  release.isError = false;
  release.data = { downloadUrl: RELEASE_DOWNLOAD_URL };
  identity.organization = {
    id: "org_1",
    name: "Closedloop",
    slug: "closedloop",
    imageUrl: null,
  };
  identity.organizationLoaded = true;
  identity.user = {
    fullName: "Ada Lovelace",
    primaryEmailAddress: { emailAddress: "ada@closedloop.ai" },
    imageUrl: null,
  };
  identity.userLoaded = true;
  routeParams.current = { orgSlug: "closedloop" };
  memberships.data = [];
  memberships.hasNextPage = false;
  memberships.isFetching = false;
  memberships.isLoading = false;
  memberships.isError = false;
  memberships.fetchNext = vi.fn();
});

describe("local trusted auth", () => {
  test("uses the synthetic auth identity when Clerk has no browser organization", () => {
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;
    routeParams.current = { orgSlug: "closedloop-ai" };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocalTrustedIdentityProvider identity={LOCAL_TRUSTED_IDENTITY}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            orgId: LOCAL_TRUSTED_ORG_ID,
            userId: LOCAL_TRUSTED_USER_ID,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </LocalTrustedIdentityProvider>
    );

    const { projection, capabilities } = readAdapter(true, wrapper);

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Unavailable
    );
  });

  test("falls back to normal Clerk states when route params are absent", () => {
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;
    routeParams.current = undefined;

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocalTrustedIdentityProvider identity={LOCAL_TRUSTED_IDENTITY}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            orgId: LOCAL_TRUSTED_ORG_ID,
            userId: LOCAL_TRUSTED_USER_ID,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </LocalTrustedIdentityProvider>
    );

    const { projection, capabilities } = readAdapter(true, wrapper);

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Pending);
    // BEHAVIOR CHANGE (ISS-11400 review, tamsinb): this used to expect `Ready`.
    // Switch workspace is now narrowed to the standing, and a `Pending`
    // projection renders `ProjectedWorkspaceMenu`, which mounts no switcher
    // submenu — so `Ready` there was a capability with no control behind it.
    // What the case exists to discriminate is unchanged and still asserted
    // below: this is the CLERK fallback, not the local-trusted branch, whose
    // arm would report `Unavailable/NotSupportedOnHost` instead.
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Pending
    );
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).not.toBe(
      WorkspaceMenuCapabilityStatus.Unavailable
    );
  });

  test("follows an OVERRIDDEN synthetic identity, not the fixed default ids", () => {
    // ISS-10335. The Clerk-free e2e lane binds the synthetic session to the
    // seeded sandbox org, so the projection has to key on the identity the
    // server resolved. Against the old literal comparison this case renders the
    // Clerk-backed projection instead — a `useOrganizationList` read with no
    // Clerk session behind it, which is a menu that never becomes ready.
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;
    routeParams.current = { orgSlug: SEEDED_SANDBOX_IDENTITY.orgSlug };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocalTrustedIdentityProvider identity={SEEDED_SANDBOX_IDENTITY}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            orgId: SEEDED_SANDBOX_IDENTITY.orgId,
            userId: SEEDED_SANDBOX_IDENTITY.userId,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </LocalTrustedIdentityProvider>
    );

    const { projection, capabilities } = readAdapter(true, wrapper);

    // Narrowed rather than optional-chained: the projection union has a `guest`
    // arm with no workspace at all, and `?.id` on it would read `undefined` and
    // fail on the VALUE rather than saying the arm was wrong.
    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error(`expected a Ready projection, got ${projection.status}`);
    }
    expect(projection.activeWorkspace?.id).toBe(SEEDED_SANDBOX_IDENTITY.orgId);
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Unavailable
    );
  });

  test("ignores a synthetic identity that is not the signed-in one", () => {
    // The negative half: the provider being present is not enough. A Clerk user
    // in some other org must keep the Clerk-backed projection, or a stale
    // provider value would hand every viewer the synthetic workspace.
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;
    routeParams.current = { orgSlug: LOCAL_TRUSTED_ORG_SLUG };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocalTrustedIdentityProvider identity={LOCAL_TRUSTED_IDENTITY}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            orgId: SEEDED_SANDBOX_IDENTITY.orgId,
            userId: SEEDED_SANDBOX_IDENTITY.userId,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </LocalTrustedIdentityProvider>
    );

    const { projection } = readAdapter(true, wrapper);

    expect(projection.status).not.toBe(WorkspaceMenuProjectionStatus.Ready);
  });

  test("carries the resolved release URL, so the download row can render", () => {
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;
    routeParams.current = { orgSlug: "closedloop-ai" };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocalTrustedIdentityProvider identity={LOCAL_TRUSTED_IDENTITY}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            orgId: LOCAL_TRUSTED_ORG_ID,
            userId: LOCAL_TRUSTED_USER_ID,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </LocalTrustedIdentityProvider>
    );

    const { projection } = readAdapter(true, wrapper);

    // The status alone cannot hold this: the projection was already Ready with
    // `downloadUrl` hardcoded null, so the entry resolved and the row still
    // rendered nothing — `DownloadDesktopItem` returns null without a URL.
    expect(projection).toMatchObject({
      status: WorkspaceMenuProjectionStatus.Ready,
      downloadUrl: RELEASE_DOWNLOAD_URL,
    });
  });
});

describe("the download read does not gate the menu", () => {
  test("a pending release still yields a Ready projection", () => {
    release.isPending = true;
    release.data = null;

    const { projection, capabilities } = readAdapter();

    // The menu is usable...
    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    // ...and the download entry alone carries the not-yet-resolved state.
    expect(capabilities[WorkspaceMenuEntryId.DownloadDesktop].status).toBe(
      WorkspaceMenuCapabilityStatus.Pending
    );
  });

  test("a pending release is Pending, never Unavailable or Error", () => {
    release.isPending = true;
    release.data = null;

    const status =
      readAdapter().capabilities[WorkspaceMenuEntryId.DownloadDesktop].status;

    expect(status).not.toBe(WorkspaceMenuCapabilityStatus.Unavailable);
    expect(status).not.toBe(WorkspaceMenuCapabilityStatus.Error);
  });

  test("a failed release is an Error, and the menu is still Ready", () => {
    release.isError = true;
    release.data = null;

    const { projection, capabilities } = readAdapter();

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    expect(capabilities[WorkspaceMenuEntryId.DownloadDesktop].status).toBe(
      WorkspaceMenuCapabilityStatus.Error
    );
  });
});

describe("the membership read gates only the SWITCHER", () => {
  test("an unfinished page leaves the menu Ready and the switcher Pending", () => {
    // Holding the whole projection here is what stranded Settings, Members and
    // Log out behind a permanent "Loading".
    memberships.hasNextPage = true;

    const { projection, capabilities } = readAdapter();

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Pending
    );
  });

  test("a failed page is an Error, and does not wait forever", () => {
    // A failed fetch leaves hasNextPage true, so without an error path the walk
    // never ends and the switcher never resolves.
    memberships.hasNextPage = true;
    memberships.isError = true;

    const { projection, capabilities } = readAdapter();

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Error
    );
    expect(memberships.fetchNext).not.toHaveBeenCalled();
  });

  test("a further page is fetched rather than silently dropped", () => {
    memberships.hasNextPage = true;

    readAdapter();

    expect(memberships.fetchNext).toHaveBeenCalled();
  });

  test("no further fetch is issued while one is already in flight", () => {
    memberships.hasNextPage = true;
    memberships.isFetching = true;

    readAdapter();

    expect(memberships.fetchNext).not.toHaveBeenCalled();
  });
});

describe("a closed menu fetches nothing", () => {
  test("no membership pagination runs while the menu is shut", () => {
    // The menu sits in the sidebar header, so it renders on every authenticated
    // page load. Walking Clerk's pages for a dropdown nobody opened is the cost
    // `packages/app/AGENTS.md` forbids.
    memberships.hasNextPage = true;

    readAdapter(false);

    expect(memberships.fetchNext).not.toHaveBeenCalled();
  });

  test("the trigger still names the workspace with the menu shut", () => {
    // Gating must not cost the closed-state trigger its identity.
    const { projection } = readAdapter(false);

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error("expected Ready");
    }
    expect(projection.activeWorkspace.name).toBe("Closedloop");
  });

  describe("the Diagnostics entry (ISS-10006)", () => {
    test("is Pending while PostHog has not answered, not a verdict about this host", () => {
      diagnosticsFlag.current = undefined;

      const { capabilities } = readAdapter();

      expect(capabilities[WorkspaceMenuEntryId.Diagnostics].status).toBe(
        WorkspaceMenuCapabilityStatus.Pending
      );
    });

    test("is Ready with the key on, and Unavailable with it settled off", () => {
      diagnosticsFlag.current = { enabled: true };
      expect(
        readAdapter().capabilities[WorkspaceMenuEntryId.Diagnostics].status
      ).toBe(WorkspaceMenuCapabilityStatus.Ready);

      // The paired opposite on the same entry: without it, "Ready" could be what
      // this entry always is, and the row would render over a 404.
      diagnosticsFlag.current = { enabled: false };
      expect(
        readAdapter().capabilities[WorkspaceMenuEntryId.Diagnostics]
      ).toStrictEqual({
        reason: WorkspaceMenuCapabilityReason.NotSupportedOnHost,
        status: WorkspaceMenuCapabilityStatus.Unavailable,
      });
    });

    test("points at this org's route, and at nothing until the slug resolves", () => {
      diagnosticsFlag.current = { enabled: true };
      routeParams.current = { orgSlug: "closedloop" };
      expect(readAdapterHref()).toBe("/closedloop/diagnostics");

      // An absent href and a broken one are different: the menu renders the row
      // only with one, so `/undefined/diagnostics` must never be built.
      routeParams.current = { orgSlug: undefined };
      expect(readAdapterHref()).toBeUndefined();
    });
  });
});

function readAdapterHref(): string | undefined {
  const { result } = renderHook(() => useWebWorkspaceMenuHostAdapter(), {
    wrapper: WebFeatureFlagProvider,
  });
  return result.current.diagnosticsHref;
}

/**
 * ISS-11400. The menu now opens on a failed or unsettled projection, which on
 * web is exactly the state in which there is no organization slug — and
 * Settings and Members are org-RELATIVE routes that `useOrgPathBuilder` emits
 * unprefixed without one, landing on `[orgSlug]` matches that resolve nothing.
 * They have to be withheld by capability rather than rendered as dead links.
 */
describe("org-scoped destinations follow the slug the link builder reads", () => {
  test("a settled read with no organization reports them as a failed read", () => {
    identity.organization = null;

    const { projection, capabilities } = readAdapter();

    // The projection the render reaches with; without it this asserts a
    // capability nothing is looking at.
    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Error);
    for (const entry of [
      WorkspaceMenuEntryId.Settings,
      WorkspaceMenuEntryId.Members,
    ]) {
      expect(capabilities[entry].status).toBe(
        WorkspaceMenuCapabilityStatus.Error
      );
      expect(capabilities[entry]).toMatchObject({
        reason: WorkspaceMenuCapabilityReason.ReadFailed,
      });
    }
  });

  test("an unresolved organization is Pending, not a verdict about this host", () => {
    // Same three-state rule the Diagnostics flag follows: nobody has answered
    // yet is not "web cannot reach Settings".
    identity.organization = null;
    identity.organizationLoaded = false;

    const { capabilities } = readAdapter();

    expect(capabilities[WorkspaceMenuEntryId.Settings].status).toBe(
      WorkspaceMenuCapabilityStatus.Pending
    );
  });

  test("a resolved organization keeps both entries Ready", () => {
    // The covering permutation: without it the two cases above would pass with
    // the entries hardcoded to Error.
    const { capabilities } = readAdapter();

    for (const entry of [
      WorkspaceMenuEntryId.Settings,
      WorkspaceMenuEntryId.Members,
    ]) {
      expect(capabilities[entry].status).toBe(
        WorkspaceMenuCapabilityStatus.Ready
      );
    }
  });

  test("the switcher entries follow the standing that decides the body", () => {
    // ISS-11400 review (tamsinb) — the sweep across the remaining entries.
    // `WorkspaceSwitcherSubmenu` and the create-workspace dialog live ONLY in
    // `ReadyWorkspaceMenu`, so on a Pending or Error projection these two were
    // `Ready` with nothing mounted behind them. Withheld rather than carried
    // through: both need a settled organization to act on — `setActive`
    // activates one by id, and the create slot is a Clerk embed.
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;

    const pending = readAdapter().capabilities;
    expect(pending[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Pending
    );
    expect(pending[WorkspaceMenuEntryId.CreateWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Pending
    );

    // Settled with no organization is the failed read, kept distinct.
    identity.organizationLoaded = true;
    identity.userLoaded = true;
    const errored = readAdapter().capabilities;
    expect(errored[WorkspaceMenuEntryId.SwitchWorkspace]).toMatchObject({
      reason: WorkspaceMenuCapabilityReason.ReadFailed,
      status: WorkspaceMenuCapabilityStatus.Error,
    });
    expect(errored[WorkspaceMenuEntryId.CreateWorkspace]).toMatchObject({
      reason: WorkspaceMenuCapabilityReason.ReadFailed,
      status: WorkspaceMenuCapabilityStatus.Error,
    });

    // Log out is deliberately NOT narrowed on web, and that is the asymmetry
    // with desktop rather than an oversight: web's `Pending` is a real session
    // with Clerk still hydrating, so signing out works and withholding it would
    // take away a control that does exactly what its label says.
    identity.organizationLoaded = false;
    identity.userLoaded = false;
    expect(readAdapter().capabilities[WorkspaceMenuEntryId.LogOut].status).toBe(
      WorkspaceMenuCapabilityStatus.Ready
    );
  });

  test("a settled organization keeps both switcher entries Ready", () => {
    // The covering permutation for the case above: without it, both assertions
    // there would pass with these two entries withheld unconditionally.
    const { capabilities } = readAdapter();

    for (const entry of [
      WorkspaceMenuEntryId.SwitchWorkspace,
      WorkspaceMenuEntryId.CreateWorkspace,
    ]) {
      expect(capabilities[entry].status).toBe(
        WorkspaceMenuCapabilityStatus.Ready
      );
    }
  });

  test("a local_trusted slug wins over a Clerk read that never settles", () => {
    // ISS-11400 review. `AUTH_MODE=local_trusted` is a Clerk-free session, so
    // `useOrganization().isLoaded` stays false for the life of the process while
    // `useNavOrgSlug()` has already answered with the synthetic org's slug.
    // Asking Clerk FIRST pinned both rows on `Pending` forever — Settings
    // permanently unreachable, which is this ticket's own defect wearing a
    // different label rather than a new one.
    identity.organization = null;
    identity.organizationLoaded = false;
    identity.user = null;
    identity.userLoaded = false;
    routeParams.current = { orgSlug: LOCAL_TRUSTED_ORG_SLUG };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocalTrustedIdentityProvider identity={LOCAL_TRUSTED_IDENTITY}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            orgId: LOCAL_TRUSTED_ORG_ID,
            userId: LOCAL_TRUSTED_USER_ID,
          })}
        >
          {children}
        </AuthAdapterProvider>
      </LocalTrustedIdentityProvider>
    );

    const { capabilities } = readAdapter(true, wrapper);

    for (const entry of [
      WorkspaceMenuEntryId.Settings,
      WorkspaceMenuEntryId.Members,
    ]) {
      expect(capabilities[entry].status).toBe(
        WorkspaceMenuCapabilityStatus.Ready
      );
    }
    // The gate is still LIVE rather than deleted: strip the synthetic identity
    // and the same unsettled Clerk read goes back to `Pending`.
    identity.organizationLoaded = false;
    expect(
      readAdapter().capabilities[WorkspaceMenuEntryId.Settings].status
    ).toBe(WorkspaceMenuCapabilityStatus.Pending);
  });
});
