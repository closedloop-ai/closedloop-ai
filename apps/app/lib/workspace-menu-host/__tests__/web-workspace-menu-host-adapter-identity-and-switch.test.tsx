import {
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
  WorkspaceMenuProjectionStatus,
} from "@repo/api/src/types/workspace-menu";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";

/**
 * Covers the branches the sibling `web-workspace-menu-host-adapter.test.tsx`
 * does not: the membership-read `??` defaults when Clerk hands back no
 * paginated resource at all, the identity Pending/Error gates, the
 * already-listed active workspace, the actor's null fallbacks, and
 * `switchWorkspace` itself (untouched by the sibling file, which only reads
 * the projection and capabilities hooks).
 */

type ClerkOrganization = {
  id: string;
  name: string;
  slug: string | null;
  imageUrl: string | null;
};

type ClerkUserMemberships = {
  data: { organization: ClerkOrganization }[];
  hasNextPage: boolean;
  isError: boolean;
  isFetching: boolean;
  isLoading: boolean;
  fetchNext: () => void;
};

const auth = vi.hoisted(() => ({
  organization: {
    id: "org_1",
    name: "Closedloop",
    slug: "closedloop",
    imageUrl: null,
  } as ClerkOrganization | null,
  organizationLoaded: true,
  user: {
    fullName: "Ada Lovelace" as string | null,
    primaryEmailAddress: { emailAddress: "ada@closedloop.ai" } as {
      emailAddress: string;
    } | null,
    imageUrl: null as string | null,
  } as {
    fullName: string | null;
    primaryEmailAddress: { emailAddress: string } | null;
    imageUrl: string | null;
  } | null,
  userLoaded: true,
  organizationListLoaded: true,
  setActive: vi.fn() as
    | ((args: { organization: string }) => Promise<unknown>)
    | undefined,
  // `undefined` is the real Clerk shape for a call made with no
  // `userMemberships` argument — this file's whole point is exercising that
  // shape, which the sibling file's mock never produces.
  userMemberships: undefined as ClerkUserMemberships | undefined,
}));

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => ({
    organization: auth.organization,
    isLoaded: auth.organizationLoaded,
  }),
  useUser: () => ({
    user: auth.user,
    isLoaded: auth.userLoaded,
  }),
  useOrganizationList: () => ({
    isLoaded: auth.organizationListLoaded,
    setActive: auth.setActive,
    userMemberships: auth.userMemberships,
  }),
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => ({
    isPending: false,
    isError: false,
    data: { downloadUrl: "https://example.com/Closedloop-universal.dmg" },
  }),
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

// Partial mock: `withOrgSlug` runs the REAL implementation by default (most
// tests want the genuine route it composes) and is overridden to `null` in
// exactly one test to exercise `switchWorkspace`'s defensive `?? "/"` — a
// path today's real inputs cannot reach, since the route it is joined with
// is a non-null constant.
const withOrgSlugSpy = vi.hoisted(() => vi.fn());
vi.mock(
  "@repo/app/documents/lib/document-navigation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/documents/lib/document-navigation")
      >();
    withOrgSlugSpy.mockImplementation(actual.withOrgSlug);
    return { ...actual, withOrgSlug: withOrgSlugSpy };
  }
);

// ISS-12135: the product's org-name read needs a query client this suite
// does not mount; `null` keeps every case on Clerk's own name.
vi.mock("../use-active-organization-record-name", () => ({
  useActiveOrganizationRecordName: () => null,
}));

const { useWebWorkspaceMenuHostAdapter } = await import(
  "../web-workspace-menu-host-adapter"
);

function renderProjectionAndCapabilities(open = true) {
  const { result } = renderHook(
    () => {
      const adapter = useWebWorkspaceMenuHostAdapter();
      return {
        projection: adapter.useWorkspaceMenuProjection({ open }),
        capabilities: adapter.useWorkspaceMenuCapabilities({ open }),
      };
    },
    { wrapper: WebFeatureFlagProvider }
  );
  return result.current;
}

function renderAdapter() {
  const { result } = renderHook(() => useWebWorkspaceMenuHostAdapter(), {
    wrapper: WebFeatureFlagProvider,
  });
  return result.current;
}

/**
 * The web adapter always defines `switchWorkspace` — it is optional only
 * because a host without a switcher (Desktop) can omit it. Asserting that
 * here, once, keeps every call site below a plain, non-optional invocation.
 */
function renderSwitchWorkspace() {
  const { switchWorkspace } = renderAdapter();
  if (!switchWorkspace) {
    throw new Error("expected the web adapter to define switchWorkspace");
  }
  return switchWorkspace;
}

beforeEach(() => {
  auth.organization = {
    id: "org_1",
    name: "Closedloop",
    slug: "closedloop",
    imageUrl: null,
  };
  auth.organizationLoaded = true;
  auth.user = {
    fullName: "Ada Lovelace",
    primaryEmailAddress: { emailAddress: "ada@closedloop.ai" },
    imageUrl: null,
  };
  auth.userLoaded = true;
  auth.organizationListLoaded = true;
  auth.setActive = vi.fn().mockResolvedValue(undefined);
  auth.userMemberships = undefined;
  navigateMock.mockClear();
  withOrgSlugSpy.mockClear();
});

describe("a membership read Clerk was never asked to page through", () => {
  test("degrades every derived field to a safe empty default instead of throwing or stalling", () => {
    auth.userMemberships = undefined;

    const { projection, capabilities } = renderProjectionAndCapabilities();

    // No page, no error, no in-flight fetch — the switcher has nothing to
    // wait on and nothing to report as failed.
    expect(capabilities[WorkspaceMenuEntryId.SwitchWorkspace].status).toBe(
      WorkspaceMenuCapabilityStatus.Ready
    );
    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Ready);
    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error("expected Ready");
    }
    // `data` defaulted to `[]`, so the only workspace listed is the active one.
    expect(projection.workspaces).toEqual([projection.activeWorkspace]);
  });
});

describe("identity gates the menu, not the optional reads", () => {
  test("stays Pending while the organization identity has not loaded", () => {
    auth.organizationLoaded = false;

    const { projection } = renderProjectionAndCapabilities();

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Pending);
  });

  test("a settled read with no active organization is an Error, not Guest", () => {
    auth.organization = null;

    const { projection } = renderProjectionAndCapabilities();

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Error);
    if (projection.status !== WorkspaceMenuProjectionStatus.Error) {
      throw new Error("expected Error");
    }
    expect(projection.reason).toBe(WorkspaceMenuCapabilityReason.ReadFailed);
  });
});

describe("the active workspace's position in the membership page", () => {
  test("is not duplicated when the membership page already lists it", () => {
    auth.userMemberships = {
      data: [
        {
          organization: {
            id: "org_2",
            name: "Other Org",
            slug: "other-org",
            imageUrl: null,
          },
        },
        {
          organization: {
            id: "org_1",
            name: "Closedloop",
            slug: "closedloop",
            imageUrl: null,
          },
        },
      ],
      hasNextPage: false,
      isError: false,
      isFetching: false,
      isLoading: false,
      fetchNext: vi.fn(),
    };

    const { projection } = renderProjectionAndCapabilities();

    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error("expected Ready");
    }
    // Two memberships in, two workspaces out — a prepend here would make it
    // three, with the active organization listed twice.
    expect(projection.workspaces).toHaveLength(2);
    expect(projection.workspaces.map((workspace) => workspace.id)).toEqual([
      "org_2",
      "org_1",
    ]);
  });
});

describe("actor fields Clerk did not supply", () => {
  test("name and email fall back to null rather than an empty string or crash", () => {
    auth.user = {
      fullName: null,
      primaryEmailAddress: null,
      imageUrl: null,
    };

    const { projection } = renderProjectionAndCapabilities();

    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error("expected Ready");
    }
    expect(projection.actor.name).toBeNull();
    expect(projection.actor.email).toBeNull();
  });
});

describe("switchWorkspace", () => {
  test("does nothing when Clerk has not handed back an activation function", async () => {
    auth.setActive = undefined;

    const switchWorkspace = renderSwitchWorkspace();
    await switchWorkspace({
      id: "org_9",
      name: "Ninth",
      slug: "ninth",
      imageUrl: null,
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("activates by id and stays put when the workspace carries no slug", async () => {
    const switchWorkspace = renderSwitchWorkspace();
    await switchWorkspace({
      id: "org_9",
      name: "Ninth",
      slug: null,
      imageUrl: null,
    });

    expect(auth.setActive).toHaveBeenCalledWith({ organization: "org_9" });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("activates by id and navigates by slug to the canonical landing route", async () => {
    const switchWorkspace = renderSwitchWorkspace();
    await switchWorkspace({
      id: "org_9",
      name: "Ninth",
      slug: "ninth",
      imageUrl: null,
    });

    expect(auth.setActive).toHaveBeenCalledWith({ organization: "org_9" });
    expect(navigateMock).toHaveBeenCalledWith(
      `/ninth${WEB_CANONICAL_LANDING_HREF}`
    );
  });

  // Pins current behavior, and it looks wrong: this fallback is dead in
  // production — `withOrgSlug` only returns null when its `route` argument
  // is null, and `switchWorkspace` always calls it with the non-null
  // `WEB_CANONICAL_LANDING_HREF` constant, so the real function can never
  // produce the value this branch exists to handle. It is exercised here
  // only by forcing `withOrgSlug` itself to return null.
  test("falls back to the root path when the landing route cannot be composed", async () => {
    withOrgSlugSpy.mockReturnValueOnce(null);

    const switchWorkspace = renderSwitchWorkspace();
    await switchWorkspace({
      id: "org_9",
      name: "Ninth",
      slug: "ninth",
      imageUrl: null,
    });

    expect(auth.setActive).toHaveBeenCalledWith({ organization: "org_9" });
    expect(navigateMock).toHaveBeenCalledWith("/");
  });
});
