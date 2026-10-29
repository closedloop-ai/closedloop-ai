import { DESKTOP_AUTHORIZE_QUERY_PARAMS } from "@repo/api/src/types/desktop-authorize-url";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  freshSearchParams,
  clientState,
  mockCapture,
  mockPostHog,
  navigation,
  searchParamsFor,
} = vi.hoisted(() => {
  // React compares effect dependencies by reference, so the posthog client
  // has to be stable for these tests to mean anything: a fresh one on every
  // render re-fires the effect no matter what the dependency list says. In
  // production `usePostHog()` reads a context value. `searchParams` objects
  // are interned by query text by default; the fresh-object test opts out via
  // `freshSearchParams`, because a hash-only navigation does hand back a new
  // object with the same query.
  const capture = vi.fn();
  const instances = new Map<string, URLSearchParams>();
  return {
    freshSearchParams: {
      current: undefined as (() => URLSearchParams) | undefined,
    },
    clientState: { available: true },
    mockCapture: capture,
    mockPostHog: { capture },
    navigation: {
      pathname: "/login",
      search: "",
    },
    searchParamsFor: (search: string): URLSearchParams => {
      const existing = instances.get(search);
      if (existing) {
        return existing;
      }
      const created = new URLSearchParams(search);
      instances.set(search, created);
      return created;
    },
  };
});

vi.mock("@posthog/next", () => ({
  usePostHog: () => (clientState.available ? mockPostHog : null),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () =>
    freshSearchParams.current?.() ?? searchParamsFor(navigation.search),
}));

const { PostHogPageView } = await import("./page-view");

beforeEach(() => {
  vi.clearAllMocks();
  clientState.available = true;
  navigation.pathname = "/login";
  navigation.search = "";
  freshSearchParams.current = undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mockCapture.mockReset();
});

describe("PostHogPageView", () => {
  it("captures only once when StrictMode repeats mount effects", () => {
    render(
      <StrictMode>
        <PostHogPageView />
      </StrictMode>
    );
    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("hydrates without counting repeated effects as extra pageviews", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(
      <StrictMode>
        <PostHogPageView />
      </StrictMode>
    );
    document.body.append(container);
    const { unmount } = render(
      <StrictMode>
        <PostHogPageView />
      </StrictMode>,
      {
        container,
        hydrate: true,
      }
    );
    expect(mockCapture).toHaveBeenCalledOnce();
    unmount();
    container.remove();
  });

  it("keeps children usable without an SDK and captures when it becomes available", () => {
    clientState.available = false;
    const tree = (
      <>
        <button type="button">Continue</button>
        <PostHogPageView />
      </>
    );
    const { rerender, getByRole } = render(tree);
    expect(getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(mockCapture).not.toHaveBeenCalled();
    clientState.available = true;
    rerender(
      <>
        <button type="button">Continue</button>
        <PostHogPageView />
      </>
    );
    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("keeps rendering when the SDK throws during capture", () => {
    vi.stubGlobal("reportError", vi.fn());
    mockCapture.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });
    const { getByRole } = render(
      <>
        <button type="button">Continue</button>
        <PostHogPageView />
      </>
    );
    expect(mockCapture).toHaveBeenCalledOnce();
    expect(getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("counts a return to the previous page after a failed capture", () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const failure = new Error("SDK unavailable");
    navigation.pathname = "/docs";
    const { rerender } = render(<PostHogPageView />);
    mockCapture.mockImplementationOnce(() => {
      throw failure;
    });
    navigation.pathname = "/pricing";
    rerender(<PostHogPageView />);
    navigation.pathname = "/docs";
    rerender(<PostHogPageView />);
    expect(mockCapture).toHaveBeenCalledTimes(3);
    expect(capturedCurrentUrl(2)).toBe(
      `${globalThis.window.location.origin}/docs`
    );
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("attempts a failing route once when StrictMode repeats the effect", () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    mockCapture.mockImplementation(() => {
      throw new Error("SDK unavailable");
    });
    render(
      <StrictMode>
        <PostHogPageView />
      </StrictMode>
    );
    expect(mockCapture).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("surfaces a capture failure through a later uncaught error without reportError", () => {
    vi.useFakeTimers();
    vi.stubGlobal("reportError", undefined);
    const failure = new Error("SDK unavailable");
    mockCapture.mockImplementation(() => {
      throw failure;
    });
    render(<PostHogPageView />);
    expect(() => vi.runAllTimers()).toThrow(failure);
  });

  it("counts query changes even if redaction produces the same URL", () => {
    navigation.search = "code=first";
    const { rerender } = render(<PostHogPageView />);
    navigation.search = "code=second";
    rerender(<PostHogPageView />);
    expect(mockCapture).toHaveBeenCalledTimes(2);
    expect(capturedCurrentUrl(0)).toBe(capturedCurrentUrl(1));
  });

  it.each(["/", "/acme/sessions"])(
    "counts navigation, history, locale and query changes from %s",
    (initialPath) => {
      navigation.pathname = initialPath;
      const { rerender } = render(<PostHogPageView />);
      const routes = [
        ["/docs", ""],
        ["/docs/quickstart", ""],
        ["/docs", ""],
        ["/docs/quickstart", ""],
        ["/de/docs/quickstart", ""],
        ["/de/docs/quickstart", "page=2"],
      ];
      for (const [index, [pathname, search]] of routes.entries()) {
        navigation.pathname = pathname;
        navigation.search = search;
        rerender(<PostHogPageView />);
        expect(mockCapture).toHaveBeenCalledTimes(index + 2);
        expect(capturedCurrentUrl(index + 1)).toBe(
          `${globalThis.window.location.origin}${pathname}${search ? `?${search}` : ""}`
        );
      }
      rerender(<PostHogPageView />);
      expect(mockCapture).toHaveBeenCalledTimes(routes.length + 1);
    }
  );

  it("preserves safe campaign parameters alongside redacted secrets", () => {
    navigation.pathname = "/docs";
    navigation.search = "utm_source=newsletter&utm_campaign=launch&code=secret";
    render(<PostHogPageView />);
    const params = new URL(capturedCurrentUrl()).searchParams;
    expect(params.get("utm_source")).toBe("newsletter");
    expect(params.get("utm_campaign")).toBe("launch");
    expect(params.get("code")).toBe("[redacted]");
  });

  it("captures $current_url as an absolute url, not the relative pathname", async () => {
    render(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());
    const currentUrl = capturedCurrentUrl();
    // The defect ISS-8173 fixes: PostHog drops heatmap data for any
    // `$current_url` it cannot parse as absolute, so parsing it standalone —
    // with no base — is the property that actually has to hold.
    expect(() => new URL(currentUrl)).not.toThrow();
    expect(currentUrl).toBe(`${globalThis.window.location.origin}/login`);
  });

  it("keeps the query string inside the absolute url", async () => {
    navigation.pathname = "/acme/sessions";
    navigation.search = "status=active&page=2";

    render(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());
    const currentUrl = capturedCurrentUrl();
    expect(() => new URL(currentUrl)).not.toThrow();
    expect(currentUrl).toBe(
      `${globalThis.window.location.origin}/acme/sessions?status=active&page=2`
    );
  });

  it("captures a $pageview event", async () => {
    render(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());
    expect(mockCapture.mock.calls[0]?.[0]).toBe("$pageview");
  });

  it("emits a second pageview for a query-only navigation", async () => {
    navigation.pathname = "/acme/sessions";
    navigation.search = "page=1";
    const { rerender } = render(<PostHogPageView />);
    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());

    // Same pathname, different query — the navigation `pathname` alone cannot
    // observe. Without `searchParams` in the effect's dependency list this
    // second pageview is never emitted and the page looks unvisited.
    navigation.search = "page=2";
    rerender(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledTimes(2));
    expect(capturedCurrentUrl(1)).toBe(
      `${globalThis.window.location.origin}/acme/sessions?page=2`
    );
  });

  it("does not re-emit a pageview when nothing navigated", async () => {
    navigation.pathname = "/acme/sessions";
    navigation.search = "page=1";
    const { rerender } = render(<PostHogPageView />);
    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());

    rerender(<PostHogPageView />);
    rerender(<PostHogPageView />);

    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("does not re-emit a pageview for a fresh searchParams object with the same query", async () => {
    navigation.pathname = "/docs/mechanisms/sessions";
    navigation.search = "tab=cost";
    const fresh = vi.fn(() => new URLSearchParams(navigation.search));
    freshSearchParams.current = fresh;
    const { rerender } = render(<PostHogPageView />);
    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());

    // A hash-only navigation (`#cost-buckets`) yields a new object carrying
    // the unchanged query; that is not a new page.
    rerender(<PostHogPageView />);

    expect(fresh.mock.calls.length).toBeGreaterThan(1);
    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("redacts the sensitive desktop authorize params out of $current_url", async () => {
    navigation.pathname = "/connect/github";
    navigation.search = new URLSearchParams({
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.state]: "9f3c-csrf-token",
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge]: "E9Melhoa2Owvfrep",
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri]: "http://127.0.0.1:51234/cb",
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName]: "Marisol's MacBook Pro",
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayPublicKey]: "MIIBIjANBgkq",
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.emailHint]: "bWlrZUBleGFtcGxlLmNvbQ",
      [DESKTOP_AUTHORIZE_QUERY_PARAMS.platform]: "darwin",
    }).toString();

    render(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());
    const captured = new URL(capturedCurrentUrl()).searchParams;
    for (const key of [
      DESKTOP_AUTHORIZE_QUERY_PARAMS.state,
      DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge,
      DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri,
      DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName,
      DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayPublicKey,
      DESKTOP_AUTHORIZE_QUERY_PARAMS.emailHint,
    ]) {
      expect(captured.get(key)).toBe("[redacted]");
    }
    // The key survives redaction — it is what says an authorize handoff
    // happened — and a param carrying no secret keeps its real value.
    expect(captured.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.platform)).toBe(
      "darwin"
    );
  });

  it("redacts the signed-out detour's nested authorize URL", async () => {
    // The shape `apps/app/proxy.ts` really redirects an unauthenticated
    // desktop-authorize request to: the secrets are not top-level params here,
    // they are characters inside `redirect_url`'s value, so a per-key redaction
    // that does not know this key leaves every one of them readable.
    const authorizeUrl = `/settings/integrations/desktop/authorize?${new URLSearchParams(
      {
        [DESKTOP_AUTHORIZE_QUERY_PARAMS.state]: "9f3c-csrf-token",
        [DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge]: "E9Melhoa2Owvfrep",
      }
    ).toString()}`;
    navigation.pathname = "/connect/github";
    navigation.search = new URLSearchParams({
      redirect_url: authorizeUrl,
    }).toString();

    render(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());
    const currentUrl = capturedCurrentUrl();
    expect(currentUrl).not.toContain("9f3c-csrf-token");
    expect(currentUrl).not.toContain("E9Melhoa2Owvfrep");
    expect(new URL(currentUrl).searchParams.get("redirect_url")).toBe(
      "[redacted]"
    );
  });

  it("redacts the desktop connect authorization code", async () => {
    navigation.pathname = "/acme/settings/integrations/desktop/connect";
    navigation.search = "code=ABCD-1234";

    render(<PostHogPageView />);

    await waitFor(() => expect(mockCapture).toHaveBeenCalledOnce());
    expect(new URL(capturedCurrentUrl()).searchParams.get("code")).toBe(
      "[redacted]"
    );
  });
});

function capturedCurrentUrl(call = 0): string {
  const properties = mockCapture.mock.calls[call]?.[1] as
    | { $current_url?: unknown }
    | undefined;
  const currentUrl = properties?.$current_url;
  if (typeof currentUrl !== "string") {
    throw new Error("no $current_url was captured");
  }
  return currentUrl;
}
