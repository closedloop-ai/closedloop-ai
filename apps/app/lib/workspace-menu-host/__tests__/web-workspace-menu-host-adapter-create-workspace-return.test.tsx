import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DESKTOP_ORG_RETURN_PARAM,
  DESKTOP_ORG_RETURN_PATHNAME,
} from "../../desktop-org-return";

/**
 * ISS-11272: where `<CreateOrganization>` sends the person afterwards.
 *
 * Both arms are pinned here because only the PAIR says anything: a
 * desktop-originated run has to reach the authorize page so the loopback
 * completes, and a browser-originated run has to keep landing exactly where it
 * always did.
 */

/** Props the mocked Clerk embed actually received, in render order. */
const createOrganizationProps = vi.hoisted(
  () => [] as { afterCreateOrganizationUrl?: string }[]
);
const location = vi.hoisted(() => ({
  pathname: "/acme/dashboard",
  search: "",
}));

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: (props: { afterCreateOrganizationUrl?: string }) => {
    createOrganizationProps.push(props);
    return null;
  },
  useClerk: () => ({ signOut: () => Promise.resolve() }),
  useOrganization: () => ({ organization: null, isLoaded: true }),
  useUser: () => ({ user: null, isLoaded: true }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: vi.fn(),
    userMemberships: undefined,
  }),
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => ({
    isPending: false,
    isError: false,
    data: null,
  }),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => undefined,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => ({ orgSlug: "acme" }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => location.pathname,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(location.search),
}));

// ISS-12135: the product's org-name read needs a query client this suite
// does not mount; `null` keeps every case on Clerk's own name.
vi.mock("../use-active-organization-record-name", () => ({
  useActiveOrganizationRecordName: () => null,
}));

const { useWebWorkspaceMenuHostAdapter } = await import(
  "../web-workspace-menu-host-adapter"
);

/** The authorize query a real desktop run parks on. */
const AUTHORIZE_SEARCH =
  "code_challenge=abc123&code_challenge_method=S256&state=xyz789" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A51789%2Fcallback" +
  "&gateway_id=gw-1&gateway_public_key=LS0tLS1CRUdJTg";

/**
 * Renders the slot rather than reading the element's props, so the assertion
 * covers what Clerk is actually handed — a slot that stopped passing the prop
 * through would still satisfy a props-tree read of the outer element.
 */
function renderCreateWorkspaceSlot(): { afterCreateOrganizationUrl?: string } {
  const { result } = renderHook(() => useWebWorkspaceMenuHostAdapter());
  render(result.current.createWorkspaceSlot);
  const props = createOrganizationProps.at(-1);
  if (!props) {
    throw new Error("the create-workspace slot never rendered the Clerk embed");
  }
  return props;
}

beforeEach(() => {
  createOrganizationProps.length = 0;
  location.pathname = "/acme/dashboard";
  location.search = "";
});

describe("create-workspace return destination", () => {
  test("sends a desktop-originated run back to the desktop authorize page", () => {
    location.pathname = `/acme${DESKTOP_AUTHORIZE_PATHNAME}`;
    location.search = AUTHORIZE_SEARCH;

    const href = renderCreateWorkspaceSlot().afterCreateOrganizationUrl ?? "";
    const url = new URL(href, "https://app.closedloop.ai");

    expect(url.pathname).toBe(DESKTOP_ORG_RETURN_PATHNAME);
    // The BARE authorize path: the slug in the current URL names the org being
    // left, and the proxy re-prefixes whichever org ends up active.
    expect(url.searchParams.get(DESKTOP_ORG_RETURN_PARAM)).toBe(
      `${DESKTOP_AUTHORIZE_PATHNAME}?${AUTHORIZE_SEARCH}`
    );
  });

  test("carries the whole authorize query, not just the path", () => {
    location.pathname = DESKTOP_AUTHORIZE_PATHNAME;
    location.search = AUTHORIZE_SEARCH;

    const href = renderCreateWorkspaceSlot().afterCreateOrganizationUrl ?? "";
    const carried = new URL(href, "https://app.closedloop.ai").searchParams.get(
      DESKTOP_ORG_RETURN_PARAM
    );
    const carriedParams = new URL(carried ?? "", "https://app.closedloop.ai")
      .searchParams;

    expect(carriedParams.get("state")).toBe("xyz789");
    expect(carriedParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:51789/callback"
    );
    expect(carriedParams.get("gateway_public_key")).toBe("LS0tLS1CRUdJTg");
  });

  test("leaves a web-originated run on the web canonical landing", () => {
    const props = renderCreateWorkspaceSlot();

    expect(props.afterCreateOrganizationUrl).toBe(
      `/:slug${WEB_CANONICAL_LANDING_HREF}`
    );
  });

  test("does not treat a page that merely carries authorize params as the run", () => {
    location.pathname = "/acme/settings";
    location.search = AUTHORIZE_SEARCH;

    const props = renderCreateWorkspaceSlot();

    expect(props.afterCreateOrganizationUrl).toBe(
      `/:slug${WEB_CANONICAL_LANDING_HREF}`
    );
  });
});
