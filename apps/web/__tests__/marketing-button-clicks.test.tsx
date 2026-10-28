// @vitest-environment jsdom

import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNav } from "@/app/[locale]/components/site-header-mobile";
import { MarketingSurfaceAnalyticsProvider } from "@/components/marketing-surface-analytics-adapter";
import { locales } from "@/lib/site";

const state = vi.hoisted(() => ({
  analytics: { capture: vi.fn() },
}));

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => state.analytics,
  useFeatureFlag: () => undefined,
}));

const SIGN_UP = "Start Building";
const GITHUB_URL = "https://github.test/closedloop-ai";

beforeEach(() => {
  globalThis.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.analytics.capture.mockReset();
});

describe("marketing button clicks", () => {
  it("emits exactly one button_clicked with surface=marketing and the source page", () => {
    const onClick = vi.fn();
    mount(<ProductButton label={SIGN_UP} onClick={onClick} />);

    press(screen.getByRole("button", { name: SIGN_UP }));

    expect(clicks()).toEqual([
      {
        [Property.PageName]: Page.Landing,
        [Property.ButtonName]: SIGN_UP,
        [Property.Surface]: Surface.Marketing,
      },
    ]);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("resolves the page from a locale-prefixed path and the docs section", () => {
    globalThis.history.replaceState({}, "", "/de/pricing");
    mount(<ProductButton label={SIGN_UP} />);
    fireEvent.click(screen.getByRole("button"));

    globalThis.history.pushState({}, "", "/docs/mechanisms/sessions");
    fireEvent.click(screen.getByRole("button"));

    expect(clicks().map((properties) => properties[Property.PageName])).toEqual(
      [Page.Pricing, Page.Docs]
    );
  });

  it("supplies only the current page after a client-side navigation, with no pageview", () => {
    mount(<ProductButton label={SIGN_UP} />);
    fireEvent.click(screen.getByRole("button"));
    globalThis.history.pushState({}, "", "/pricing");
    fireEvent.click(screen.getByRole("button"));

    expect(state.analytics.capture.mock.calls.map(([event]) => event)).toEqual([
      Event.ButtonClicked,
      Event.ButtonClicked,
    ]);
    expect(clicks()).toEqual([
      {
        [Property.PageName]: Page.Landing,
        [Property.ButtonName]: SIGN_UP,
        [Property.Surface]: Surface.Marketing,
      },
      {
        [Property.PageName]: Page.Pricing,
        [Property.ButtonName]: SIGN_UP,
        [Property.Surface]: Surface.Marketing,
      },
    ]);
  });

  it("strips every locale the site serves", () => {
    mount(<ProductButton label={SIGN_UP} />);
    for (const locale of locales) {
      globalThis.history.pushState({}, "", `/${locale}/pricing`);
      fireEvent.click(screen.getByRole("button"));
    }

    expect(clicks().map((properties) => properties[Property.PageName])).toEqual(
      locales.map(() => Page.Pricing)
    );
  });

  it("deduplicates keyboard and pointer activations against their clicks", () => {
    mount(
      <>
        <MobileNav
          docsHref="/docs"
          githubUrl={GITHUB_URL}
          resourcesHref="/resources"
        />
        <div role="tablist">
          <button
            aria-selected="true"
            data-analytics-visible-source={JSON.stringify(["Pricing"])}
            role="tab"
            type="button"
          >
            Pricing
          </button>
        </div>
      </>
    );
    const tab = screen.getByRole("tab");

    fireEvent.keyDown(tab, { key: "Enter" });
    fireEvent.click(tab);
    press(tab);
    const menu = screen.getByRole("button", { name: "Open menu" });
    fireEvent.keyDown(menu, { key: "Enter" });
    fireEvent.click(menu);

    expect(
      clicks().map((properties) => properties[Property.ButtonName])
    ).toEqual(
      // Untransformed here, so the sheet trigger takes its generic name.
      ["Pricing", "Pricing", "Toggle details"]
    );
  });

  it("ignores disabled controls and text editing", () => {
    mount(
      <>
        <button
          data-analytics-visible-source={JSON.stringify(["Subscribe"])}
          disabled
          type="submit"
        >
          Subscribe
        </button>
        <button
          aria-disabled="true"
          data-analytics-visible-source={JSON.stringify(["Pricing"])}
          type="button"
        >
          Pricing
        </button>
        <input aria-label="Email" type="email" />
      </>
    );
    const email = screen.getByRole("textbox", { name: "Email" });

    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    fireEvent.click(screen.getByRole("button", { name: "Pricing" }));
    fireEvent.click(email);
    fireEvent.keyDown(email, { key: "Enter" });
    fireEvent.change(email, { target: { value: "visitor@example.com" } });

    expect(clicks()).toEqual([]);
  });

  it("names visitor or unattributed content generically, never by its text", () => {
    mount(
      <a
        href="https://example.com/visitor-supplied-link"
        onClick={(event) => event.preventDefault()}
      >
        visitor@example.com
      </a>
    );

    fireEvent.click(screen.getByRole("link"));

    expect(clicks()).toEqual([
      expect.objectContaining({ [Property.ButtonName]: "Open link" }),
    ]);
  });

  it("keeps the control's own action running when the PostHog sink throws", () => {
    state.analytics.capture.mockImplementation(() => {
      throw new Error("analytics unavailable");
    });
    const onClick = vi.fn();
    mount(<ProductButton label={SIGN_UP} onClick={onClick} />);

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledOnce();
    expect(state.analytics.capture).toHaveBeenCalledOnce();
  });

  it("does not accumulate listeners across remounts and route changes", () => {
    const first = mount(<ProductButton label={SIGN_UP} />);
    first.unmount();
    const second = mount(<ProductButton label={SIGN_UP} />);
    globalThis.history.pushState({}, "", "/blog");
    globalThis.dispatchEvent(new PopStateEvent("popstate"));
    second.rerender(
      <MarketingSurfaceAnalyticsProvider>
        <ProductButton label={SIGN_UP} />
      </MarketingSurfaceAnalyticsProvider>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(clicks()).toEqual([
      expect.objectContaining({ [Property.PageName]: Page.Blog }),
    ]);
  });
});

function mount(children: ReactNode) {
  return render(
    <MarketingSurfaceAnalyticsProvider>
      {children}
    </MarketingSurfaceAnalyticsProvider>
  );
}

function ProductButton({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      data-analytics-visible-source={JSON.stringify([label])}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function press(control: HTMLElement) {
  fireEvent.pointerDown(control, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(control, { button: 0 });
  fireEvent.pointerUp(control, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(control, { button: 0 });
  fireEvent.click(control);
}

function clicks() {
  return state.analytics.capture.mock.calls
    .filter(([event]) => event === Event.ButtonClicked)
    .map(([, properties]) => properties);
}
