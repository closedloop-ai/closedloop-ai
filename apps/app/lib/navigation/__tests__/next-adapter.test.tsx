import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_ID,
} from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { usePath } from "@repo/navigation/use-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { render, renderHook, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppNavigationProvider } from "../next-adapter";

/** The synthetic identity a `local_trusted` harness resolves, with no override. */
const LOCAL_TRUSTED_IDENTITY = {
  orgId: LOCAL_TRUSTED_ORG_ID,
  orgSlug: LOCAL_TRUSTED_ORG_SLUG,
  userId: LOCAL_TRUSTED_USER_ID,
};

// This suite exercises the REAL port + Next adapter; opt out of the global
// port shims registered in vitest.setup.ts.
vi.unmock("@repo/navigation/use-navigation");
vi.unmock("@repo/navigation/use-path");
vi.unmock("@repo/navigation/use-route-params");
vi.unmock("@repo/navigation/use-org-path");
vi.unmock("@repo/navigation/use-search-params-value");
vi.unmock("@repo/navigation/link");

const mockUseOrganization = vi.fn(() => ({
  organization: null as { slug: string } | null,
  isLoaded: true,
}));

// The org-path builder resolves the ACTIVE org (ISS-6567); the global clerk
// shim always reports none, which cannot express the gated cross-org state.
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
  useAuth: () => ({ isSignedIn: true }),
}));

const push = vi.fn();
const replace = vi.fn();
const back = vi.fn();
const forward = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, back, forward, refresh }),
  usePathname: () => "/current/path",
  useParams: () => ({ orgSlug: "acme" }),
  useSearchParams: () => new URLSearchParams("tab=active"),
}));

type MockNextLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  children?: ReactNode;
};

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    children,
    ...rest
  }: MockNextLinkProps) => (
    <a data-testid="next-link" href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("nextNavigationAdapter", () => {
  it("delegates navigation actions to the Next router", () => {
    const { result } = renderHook(() => useNavigation(), { wrapper });

    result.current.navigate("/dest", { scroll: false });
    expect(push).toHaveBeenCalledWith("/dest", { scroll: false });

    // No-options calls still pass two arguments — this pins the production
    // contract where the vitest.setup.ts shim intentionally diverges.
    result.current.navigate("/no-opts");
    expect(push).toHaveBeenCalledWith("/no-opts", undefined);

    result.current.replace("/other");
    expect(replace).toHaveBeenCalledWith("/other", undefined);

    result.current.back();
    expect(back).toHaveBeenCalledTimes(1);

    result.current.forward();
    expect(forward).toHaveBeenCalledTimes(1);

    result.current.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("exposes pathname, params, and search params from next/navigation", () => {
    const { result } = renderHook(
      () => ({
        path: usePath(),
        params: useRouteParams(),
        search: useSearchParamsValue(),
      }),
      { wrapper }
    );

    expect(result.current.path).toBe("/current/path");
    expect(result.current.params.orgSlug).toBe("acme");
    expect(result.current.search.get("tab")).toBe("active");
  });

  it("renders the port Link through next/link with anchor passthrough", () => {
    render(
      <AppNavigationProvider>
        <Link className="styled" href="/dest" target="_blank">
          go
        </Link>
      </AppNavigationProvider>
    );

    const anchor = screen.getByTestId("next-link");
    expect(anchor.getAttribute("href")).toBe("/dest");
    expect(anchor.getAttribute("class")).toBe("styled");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.textContent).toBe("go");
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return <AppNavigationProvider>{children}</AppNavigationProvider>;
}

describe("useOrgPath", () => {
  it("builds org paths from the active org, not a foreign URL slug", () => {
    // The in-shell 404 that OrgIdentityProvider renders for a non-member org
    // builds its only escape link through this hook. Resolving it from the URL
    // slug pointed "Back to dashboard" at the org that just refused the user.
    mockUseOrganization.mockReturnValue({
      organization: { slug: "closedloop-ai" },
      isLoaded: true,
    });

    const { result } = renderHook(() => useOrgPath(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AppNavigationProvider>{children}</AppNavigationProvider>
      ),
    });

    expect(result.current("/dashboard")).toBe("/closedloop-ai/dashboard");
  });

  it("builds org paths from the synthetic session's org when Clerk has none", () => {
    // ISS-10335. This replaces two cases that pinned a ROUTE-PARAM fallback for
    // the same lane. That fallback is gone, and its removal is the fix rather
    // than a simplification: it could only read a slug the URL already carried,
    // so on the UNSCOPED landing route — where the Clerk-free lane enters — it
    // had nothing to read, this hook returned the path unprefixed, and the shell
    // came to rest on `/my-tasks/dashboard`, an org route named after a landing
    // segment (65 chromium specs, PR #7370).
    //
    // Both halves, because either alone passes on a hook that ignores the
    // identity: the slug used is the IDENTITY's, and the foreign URL slug this
    // fixture also sets is NOT.
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });

    const { result } = renderHook(() => useOrgPath(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <LocalTrustedIdentityProvider identity={LOCAL_TRUSTED_IDENTITY}>
          <AuthAdapterProvider
            adapter={createStaticAuthAdapter({ orgId: LOCAL_TRUSTED_ORG_ID })}
          >
            <AppNavigationProvider>{children}</AppNavigationProvider>
          </AuthAdapterProvider>
        </LocalTrustedIdentityProvider>
      ),
    });

    expect(result.current("/dashboard")).toBe(
      `/${LOCAL_TRUSTED_IDENTITY.orgSlug}/dashboard`
    );
    expect(result.current("/dashboard")).not.toBe("/acme/dashboard");
  });

  it("emits an org-less path rather than the URL slug while the active org is unresolved", () => {
    // ISS-7344 replaced the URL fallback this asserted. `useParams` is mocked to
    // orgSlug "acme" for this suite, and returning `/acme/dashboard` here is the
    // hybrid href the fix exists to stop: mid-switch the URL already names the
    // org being switched TO while the data still belongs to the one being
    // switched FROM. The builder's empty-slug guard now yields the unprefixed
    // path, which asserts no org at all — and is never protocol-relative.
    mockUseOrganization.mockReturnValue({ organization: null, isLoaded: true });

    const { result } = renderHook(() => useOrgPath(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AppNavigationProvider>{children}</AppNavigationProvider>
      ),
    });

    expect(result.current("/dashboard")).toBe("/dashboard");
  });
});
