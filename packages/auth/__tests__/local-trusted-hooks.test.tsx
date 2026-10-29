/**
 * ISS-12054: the `@repo/auth/client` hooks and components with no
 * `ClerkProvider` mounted.
 *
 * Every Clerk hook and component is replaced: with a sentinel when the case is
 * the real-deployment one (so "returned Clerk's result untouched" is a `toBe`),
 * and the local cases assert none of them ran. Rendered with
 * `react-dom/server`, which runs hooks in this suite's `node` environment.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_SESSION_ID,
  type LocalTrustedIdentity,
} from "../auth-mode";
import {
  CreateOrganization,
  OrganizationProfile,
  Show,
  UserProfile,
  useAuth,
  useClerk,
  useOrganization,
  useOrganizationList,
  useReverification,
  useSession,
  useUser,
} from "../client";
import { LocalTrustedIdentityProvider } from "../local-trusted-client";

const clerk = vi.hoisted(() => ({
  calls: [] as string[],
  results: new Map<string, unknown>(),
}));

vi.mock("@clerk/nextjs", () => {
  const hook = (name: string) => () => {
    clerk.calls.push(name);
    return clerk.results.get(name);
  };
  const component = (name: string) => () => {
    clerk.calls.push(name);
    return name;
  };
  return {
    CreateOrganization: component("CreateOrganization"),
    OrganizationProfile: component("OrganizationProfile"),
    Show: component("Show"),
    UserProfile: component("UserProfile"),
    useAuth: hook("useAuth"),
    useClerk: hook("useClerk"),
    useOrganization: hook("useOrganization"),
    useOrganizationList: hook("useOrganizationList"),
    useReverification: hook("useReverification"),
    useSession: hook("useSession"),
    useUser: hook("useUser"),
  };
});

const HOOK_NAMES = [
  "useAuth",
  "useReverification",
  "useClerk",
  "useOrganization",
  "useOrganizationList",
  "useSession",
  "useUser",
] as const;

const SEEDED_IDENTITY: LocalTrustedIdentity = {
  orgId: "org_seed_sandbox",
  orgSlug: "seed-sandbox",
  userId: "user_seed_sandbox",
};

beforeEach(() => {
  clerk.calls = [];
  clerk.results = new Map(HOOK_NAMES.map((name) => [name, { name }]));
});

describe("@repo/auth/client hooks", () => {
  it("return Clerk's own result untouched when no identity is mounted", () => {
    const results = renderHooks(() => ({
      auth: useAuth(),
      clerk: useClerk(),
      organization: useOrganization(),
      organizationList: useOrganizationList(),
      session: useSession(),
      user: useUser(),
    }));

    expect(results.auth).toBe(clerk.results.get("useAuth"));
    expect(results.clerk).toBe(clerk.results.get("useClerk"));
    expect(results.organization).toBe(clerk.results.get("useOrganization"));
    expect(results.organizationList).toBe(
      clerk.results.get("useOrganizationList")
    );
    expect(results.session).toBe(clerk.results.get("useSession"));
    expect(results.user).toBe(clerk.results.get("useUser"));
  });

  it("answer from the mounted identity without calling any Clerk hook", async () => {
    const results = renderHooks(
      () => ({
        auth: useAuth(),
        clerk: useClerk(),
        organization: useOrganization(),
        organizationList: useOrganizationList(),
        session: useSession(),
        user: useUser(),
      }),
      SEEDED_IDENTITY
    );

    expect(clerk.calls).toEqual([]);
    expect(results.auth).toMatchObject({
      isLoaded: true,
      isSignedIn: true,
      orgId: SEEDED_IDENTITY.orgId,
      orgRole: LOCAL_TRUSTED_ORG_ROLE,
      orgSlug: SEEDED_IDENTITY.orgSlug,
      sessionId: LOCAL_TRUSTED_SESSION_ID,
      userId: SEEDED_IDENTITY.userId,
    });
    expect(results.user.user?.id).toBe(SEEDED_IDENTITY.userId);
    // Clerk's answers for a browser holding no Clerk session.
    expect(results.organization).toMatchObject({
      isLoaded: true,
      organization: null,
    });
    expect(results.organizationList).toMatchObject({
      isLoaded: false,
      setActive: undefined,
    });
    expect(results.session).toEqual({
      isLoaded: true,
      isSignedIn: false,
      session: null,
    });
    await expect(results.clerk.signOut()).resolves.toBeUndefined();
  });

  it("hand out the server's token and admin role", async () => {
    const { auth } = renderHooks(() => ({ auth: useAuth() }), SEEDED_IDENTITY);

    await expect(auth.getToken()).resolves.toBeTruthy();
    expect(auth.has({ role: LOCAL_TRUSTED_ORG_ROLE })).toBe(true);
    expect(auth.has({ role: "org:member" })).toBe(false);
  });

  it("run a reverified call as given under the identity, without Clerk", async () => {
    const fetcher = (value: number) => Promise.resolve(value * 2);

    const { call } = renderHooks(
      () => ({ call: useReverification(fetcher) }),
      SEEDED_IDENTITY
    );

    await expect(call(21)).resolves.toBe(42);
    expect(clerk.calls).toEqual([]);
  });

  it("hand a reverified call to Clerk when no identity is mounted", () => {
    const { call } = renderHooks(() => ({
      call: useReverification(() => Promise.resolve(0)),
    }));

    expect(call).toBe(clerk.results.get("useReverification"));
  });

  it("keep their references across renders of the same identity", () => {
    const read = () => ({ auth: useAuth() });

    const first = renderHooks(read, SEEDED_IDENTITY);
    const second = renderHooks(read, SEEDED_IDENTITY);

    expect(second.auth).toBe(first.auth);
    expect(second.auth.getToken).toBe(first.auth.getToken);
  });
});

describe("@repo/auth/client components", () => {
  it("render Clerk's own components when no identity is mounted", () => {
    const markup = render(
      <>
        <UserProfile />
        <OrganizationProfile />
        <CreateOrganization />
        <Show when="signed-in">child</Show>
      </>
    );

    expect(markup).toBe("UserProfileOrganizationProfileCreateOrganizationShow");
  });

  it("render no Clerk component under the mounted identity", () => {
    const markup = render(
      <>
        <UserProfile />
        <OrganizationProfile />
        <CreateOrganization />
      </>,
      SEEDED_IDENTITY
    );

    expect(markup).toBe("");
    expect(clerk.calls).toEqual([]);
  });

  it.each([
    ["signed-in", "child"],
    ["signed-out", "fallback"],
    ["the admin role", "child"],
    ["another role", "fallback"],
  ] as const)(
    "decide <Show when> %s against the synthetic session",
    (when, expected) => {
      const conditions = {
        "signed-in": "signed-in",
        "signed-out": "signed-out",
        "the admin role": { role: LOCAL_TRUSTED_ORG_ROLE },
        "another role": (has: (params: { role: string }) => boolean) =>
          has({ role: "org:member" }),
      } as const;

      const markup = render(
        <Show fallback="fallback" when={conditions[when]}>
          child
        </Show>,
        SEEDED_IDENTITY
      );

      expect(markup).toBe(expected);
      expect(clerk.calls).toEqual([]);
    }
  );
});

function renderHooks<T>(read: () => T, identity?: LocalTrustedIdentity): T {
  let result: T | undefined;
  function Probe() {
    result = read();
    return null;
  }
  render(<Probe />, identity);
  if (result === undefined) {
    throw new Error("the probe did not render");
  }
  return result;
}

function render(node: ReactNode, identity?: LocalTrustedIdentity): string {
  return renderToStaticMarkup(
    <WithIdentity identity={identity}>{node}</WithIdentity>
  );
}

function WithIdentity({
  children,
  identity,
}: {
  children: ReactNode;
  identity: LocalTrustedIdentity | undefined;
}) {
  return (
    <LocalTrustedIdentityProvider identity={identity ?? null}>
      {children}
    </LocalTrustedIdentityProvider>
  );
}
