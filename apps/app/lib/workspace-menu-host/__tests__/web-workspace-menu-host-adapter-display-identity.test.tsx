import { WorkspaceMenuProjectionStatus } from "@repo/api/src/types/workspace-menu";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_FULL_NAME,
  LOCAL_TRUSTED_USER_ID,
  type LocalTrustedIdentity,
} from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { withWebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";

/**
 * ISS-12135: which names the web workspace menu shows. A `just vibe-up` stack
 * names the seeded org and owner through the local-trusted display overrides,
 * every other local-trusted lane keeps the fixed defaults, and a Clerk session
 * shows the product's own record of the active org (the seeded Vercel preview
 * binds a real Clerk org to the seeded org row without renaming it).
 */

type ClerkOrganization = {
  id: string;
  name: string;
  slug: string | null;
  imageUrl: string | null;
};

const auth = vi.hoisted(() => ({
  organization: null as ClerkOrganization | null,
  organizationLoaded: false,
  memberships: [] as { organization: ClerkOrganization }[],
}));
const recordName = vi.hoisted(() => ({
  current: null as string | null,
  requestedFor: [] as (string | null)[],
}));
const routeParams = vi.hoisted(() => ({
  current: { orgSlug: "acme-co" } as { orgSlug: string } | undefined,
}));

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => ({
    organization: auth.organization,
    isLoaded: auth.organizationLoaded,
  }),
  useUser: () => ({
    user: auth.organization
      ? {
          fullName: "Ottilie Eastwick",
          primaryEmailAddress: { emailAddress: "ottilie@closedloop.ai" },
          imageUrl: null,
        }
      : null,
    isLoaded: auth.organizationLoaded,
  }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: vi.fn(),
    userMemberships: {
      data: auth.memberships,
      hasNextPage: false,
      isError: false,
      isFetching: false,
      isLoading: false,
      fetchNext: vi.fn(),
    },
  }),
}));

vi.mock("../use-active-organization-record-name", () => ({
  useActiveOrganizationRecordName: (clerkOrganizationId: string | null) => {
    recordName.requestedFor.push(clerkOrganizationId);
    return recordName.current;
  },
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => ({
    isPending: false,
    isError: false,
    data: { downloadUrl: "https://example.com/Closedloop-universal.dmg" },
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => routeParams.current,
}));

const { useWebWorkspaceMenuHostAdapter } = await import(
  "../web-workspace-menu-host-adapter"
);

const DEFAULT_IDENTITY: LocalTrustedIdentity = {
  orgId: LOCAL_TRUSTED_ORG_ID,
  orgSlug: LOCAL_TRUSTED_ORG_SLUG,
  userId: LOCAL_TRUSTED_USER_ID,
};

const VIBE_IDENTITY: LocalTrustedIdentity = {
  ...DEFAULT_IDENTITY,
  orgSlug: "acme-co",
  orgName: "Acme Co",
  userEmail: "maya.okafor@closedloop.ai",
  userFirstName: "Maya",
  userLastName: "Okafor",
};

const REAL_CLERK_ORG: ClerkOrganization = {
  id: "org_2realclosedloop",
  name: "ClosedLoop",
  slug: "closedloop-ai",
  imageUrl: null,
};

beforeEach(() => {
  auth.organization = null;
  auth.organizationLoaded = false;
  auth.memberships = [];
  recordName.current = null;
  recordName.requestedFor = [];
  routeParams.current = { orgSlug: "acme-co" };
});

function readProjection(identity: LocalTrustedIdentity | null) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LocalTrustedIdentityProvider identity={identity}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          orgId: identity?.orgId ?? auth.organization?.id ?? null,
          userId: identity?.userId ?? "user_2ottilie",
        })}
      >
        {children}
      </AuthAdapterProvider>
    </LocalTrustedIdentityProvider>
  );
  const { result } = renderHook(
    () =>
      useWebWorkspaceMenuHostAdapter().useWorkspaceMenuProjection({
        open: true,
      }),
    { wrapper: withWebFeatureFlagProvider(wrapper) }
  );
  const projection = result.current;
  if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
    throw new Error(`expected a Ready projection, got ${projection.status}`);
  }
  return projection;
}

describe("local trusted", () => {
  test("a vibe stack shows the seeded org and the seeded person", () => {
    const projection = readProjection(VIBE_IDENTITY);

    expect(projection.activeWorkspace).toEqual({
      id: LOCAL_TRUSTED_ORG_ID,
      name: "Acme Co",
      slug: "acme-co",
      imageUrl: null,
    });
    expect(projection.actor).toEqual({
      name: "Maya Okafor",
      email: "maya.okafor@closedloop.ai",
      imageUrl: null,
    });
  });

  test("every other lane keeps the fixed workspace and actor", () => {
    routeParams.current = { orgSlug: LOCAL_TRUSTED_ORG_SLUG };

    const projection = readProjection(DEFAULT_IDENTITY);

    expect(projection.activeWorkspace?.name).toBe("ClosedLoop");
    expect(projection.activeWorkspace?.slug).toBe(LOCAL_TRUSTED_ORG_SLUG);
    expect(projection.actor).toEqual({
      name: LOCAL_TRUSTED_USER_FULL_NAME,
      email: LOCAL_TRUSTED_USER_EMAIL,
      imageUrl: null,
    });
  });
});

describe("clerk session", () => {
  beforeEach(() => {
    auth.organization = REAL_CLERK_ORG;
    auth.organizationLoaded = true;
    routeParams.current = { orgSlug: "closedloop-ai" };
  });

  test("the seeded preview names the active workspace from the product's record, in the trigger and its switcher row", () => {
    recordName.current = "Acme Co";
    auth.memberships = [
      { organization: REAL_CLERK_ORG },
      {
        organization: {
          id: "org_2other",
          name: "Other Org",
          slug: "other-org",
          imageUrl: null,
        },
      },
    ];

    const projection = readProjection(null);

    expect(recordName.requestedFor).toContain(REAL_CLERK_ORG.id);
    expect(projection.activeWorkspace?.name).toBe("Acme Co");
    expect(projection.workspaces.map(({ id, name }) => ({ id, name }))).toEqual(
      [
        { id: REAL_CLERK_ORG.id, name: "Acme Co" },
        { id: "org_2other", name: "Other Org" },
      ]
    );
  });

  test("keeps Clerk's name until the product's record is read", () => {
    recordName.current = null;

    const projection = readProjection(null);

    expect(projection.activeWorkspace?.name).toBe(REAL_CLERK_ORG.name);
  });
});
