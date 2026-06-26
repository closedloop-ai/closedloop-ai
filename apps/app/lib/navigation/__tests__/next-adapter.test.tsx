import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { render, renderHook, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppNavigationProvider } from "../next-adapter";

// This suite exercises the REAL port + Next adapter; opt out of the global
// port shims registered in vitest.setup.ts.
vi.unmock("@repo/navigation/use-navigation");
vi.unmock("@repo/navigation/use-path");
vi.unmock("@repo/navigation/use-route-params");
vi.unmock("@repo/navigation/use-search-params-value");
vi.unmock("@repo/navigation/link");

const push = vi.fn();
const replace = vi.fn();
const back = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, back, refresh }),
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
