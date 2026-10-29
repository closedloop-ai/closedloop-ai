/**
 * ISS-11164 regression guard: a parallel slot's catch-all must never become
 * the RUM view name.
 *
 * Nothing here is mocked except the RUM transport. The tracker renders the
 * real vendor `DatadogAppRouter`, which reads the real `next/navigation`
 * hooks, and `useParams()` is fed exactly what Next's app router feeds it:
 * `getSelectedParams(tree)` over the whole router tree. The trees model the
 * real `(authenticated)/[orgSlug]` layout, whose `@settings` slot resolves to
 * `@settings/[...unmatched]` on every org URL below the root.
 */

import { datadogRum } from "@datadog/browser-rum";
import { nextjsPlugin } from "@datadog/browser-rum-nextjs";
import { render } from "@testing-library/react";
import { getSelectedParams } from "next/dist/client/components/router-reducer/compute-changed-path";
import { GlobalLayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { FlightRouterState } from "next/dist/shared/lib/app-router-types";
import {
  createDevToolsInstrumentedPromise,
  NavigationPromisesContext,
  PathnameContext,
  PathParamsContext,
  ReadonlyURLSearchParams,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

const PAGE: FlightRouterState = ["__PAGE__", {}];

const ISSUE_PAGE = orgTree(
  ["issues", { children: [["slug", "ISS-1", "d", null], { children: PAGE }] }],
  settingsCatchAll("issues/ISS-1")
);

const ROUTES = [
  {
    route: "an org page with its own dynamic param",
    pathname: "/acme/issues/ISS-1",
    tree: ISSUE_PAGE,
    viewName: "/[orgSlug]/issues/[slug]",
  },
  {
    route: "a static org page",
    pathname: "/acme/branches",
    tree: orgTree(
      ["branches", { children: PAGE }],
      settingsCatchAll("branches")
    ),
    viewName: "/[orgSlug]/branches",
  },
  {
    // The control: the intercepted modal keeps the previous page in
    // `children` and puts a static segment in the slot, so no catch-all.
    route: "the intercepted settings modal (control)",
    pathname: "/acme/settings",
    tree: orgTree(
      ["branches", { children: PAGE }],
      ["(.)settings", { children: PAGE }]
    ),
    viewName: "/[orgSlug]/settings",
  },
  {
    route: "the org 404, a genuine catch-all page",
    pathname: "/acme/no/such-page",
    tree: orgTree(
      [["unmatched", "no/such-page", "c", null], { children: PAGE }],
      settingsCatchAll("no/such-page")
    ),
    viewName: "/[orgSlug]/[...unmatched]",
  },
  {
    route: "sign-up, a genuine catch-all outside the org layout",
    pathname: "/sign-up/verify",
    tree: [
      "",
      {
        children: [
          "(unauthenticated)",
          {
            children: [
              "sign-up",
              {
                children: [
                  ["sign-up", "verify", "oc", null],
                  { children: PAGE },
                ],
              },
            ],
          },
        ],
      },
    ] satisfies FlightRouterState,
    viewName: "/sign-up/[...sign-up]",
  },
];

let startView: MockInstance<typeof datadogRum.startView>;

beforeEach(() => {
  startView = vi.spyOn(datadogRum, "startView").mockReturnValue(undefined);
  nextjsPlugin().onInit({
    publicApi: datadogRum,
    initConfiguration: { applicationId: "app", clientToken: "token" },
    registerAssembleEventHook: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("RUM view name for a page under a parallel slot", () => {
  it("merges the @settings slot's catch-all into useParams() (the ISS-11164 mechanism)", () => {
    expect(getSelectedParams(ISSUE_PAGE)).toEqual({
      orgSlug: "acme",
      slug: "ISS-1",
      unmatched: ["issues", "ISS-1"],
    });
  });

  it.each(ROUTES)(
    "names $route by its route pattern",
    async ({ pathname, tree, viewName }) => {
      await renderTracker(pathname, tree);

      expect(startView).toHaveBeenCalledTimes(1);
      expect(startView).toHaveBeenCalledWith({
        name: viewName,
        url: undefined,
      });
    }
  );

  it("names the page by its route when dev-mode useParams() reads navigation promises", async () => {
    await renderTracker("/acme/issues/ISS-1", ISSUE_PAGE, {
      devNavigationPromises: true,
    });

    expect(startView).toHaveBeenCalledWith({
      name: "/[orgSlug]/issues/[slug]",
      url: undefined,
    });
  });
});

async function renderTracker(
  pathname: string,
  tree: FlightRouterState,
  { devNavigationPromises = false } = {}
) {
  // Fresh module per case: the tracker's view latch is module-scoped.
  const { DatadogRouteViewTracker } = await import(
    "@/lib/datadog-rum/route-view-tracker"
  );
  const params = getSelectedParams(tree);
  const navigationPromises = devNavigationPromises
    ? {
        pathname: createDevToolsInstrumentedPromise("pathname", pathname),
        searchParams: createDevToolsInstrumentedPromise(
          "searchParams",
          new ReadonlyURLSearchParams()
        ),
        params: createDevToolsInstrumentedPromise("params", params),
      }
    : null;

  return render(
    <NavigationPromisesContext.Provider value={navigationPromises}>
      <PathParamsContext.Provider value={params}>
        <PathnameContext.Provider value={pathname}>
          <GlobalLayoutRouterContext.Provider
            value={{
              tree,
              scrollRef: {
                scrollRef: null,
                forceScroll: false,
                hashFragment: null,
                onlyHashChange: false,
              },
              nextUrl: null,
              previousNextUrl: null,
            }}
          >
            <DatadogRouteViewTracker />
          </GlobalLayoutRouterContext.Provider>
        </PathnameContext.Provider>
      </PathParamsContext.Provider>
    </NavigationPromisesContext.Provider>
  );
}

function orgTree(
  children: FlightRouterState,
  settings: FlightRouterState
): FlightRouterState {
  return [
    "",
    {
      children: [
        "(authenticated)",
        { children: [["orgSlug", "acme", "d", null], { children, settings }] },
      ],
    },
  ];
}

function settingsCatchAll(path: string): FlightRouterState {
  return [["unmatched", path, "c", null], { children: PAGE }];
}
