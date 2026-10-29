import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
  SessionVolumeBucket,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonName, installButtonClickTracker } from "../button-click-tracker";
import { SurfaceAnalyticsProvider } from "../surface-analytics-context";
import { usePageViewedEvent } from "../use-page-viewed-event";

afterEach(cleanup);

function PageView() {
  usePageViewedEvent(Page.Dashboard, {
    properties: {
      [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.OneToNine,
      [Property.OrgAnalyzedSessionsVolume]: SessionVolumeBucket.HundredPlus,
    },
  });
  return (
    <button
      data-analytics-visible-source={JSON.stringify(["Save"])}
      type="button"
    >
      <span>Save</span>
    </button>
  );
}

describe("button click tracking", () => {
  it.each([Surface.Web, Surface.Desktop])(
    "reuses page-view context once per activation under StrictMode on %s",
    async (surface) => {
      const capture = vi.fn();
      const getPage = () => ({ pageName: Page.Dashboard, entry: "/dashboard" });
      const view = render(
        <StrictMode>
          <SurfaceAnalyticsProvider
            capture={capture}
            getClickPage={getPage}
            surface={surface}
          >
            <PageView />
          </SurfaceAnalyticsProvider>
        </StrictMode>
      );
      await userEvent.click(view.getByText("Save"));
      const events = capture.mock.calls.filter(
        ([event]) => event === Event.ButtonClicked
      );
      expect(events).toEqual([
        [
          Event.ButtonClicked,
          {
            [Property.PageName]: Page.Dashboard,
            [Property.ButtonName]: "Save",
            [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.OneToNine,
            [Property.OrgAnalyzedSessionsVolume]:
              SessionVolumeBucket.HundredPlus,
            [Property.Surface]: surface,
          },
        ],
      ]);
      view.unmount();
      fireEvent.click(globalThis.document.body);
      expect(
        capture.mock.calls.filter(([event]) => event === Event.ButtonClicked)
      ).toHaveLength(1);
    }
  );

  it("captures the source page and pre-action label when the handler navigates", () => {
    let pageName = Page.Sessions as Page;
    const capture = vi.fn();
    const tracker = installButtonClickTracker({
      document: globalThis.document,
      surface: Surface.Web,
      capture,
      getPage: () => ({ pageName, entry: pageName }),
    });
    try {
      const view = render(
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          onClick={(event) => {
            pageName = Page.Branches;
            event.currentTarget.textContent = "Cancel";
          }}
          type="button"
        >
          Save
        </button>
      );
      fireEvent.click(view.getByRole("button"));
      expect(capture).toHaveBeenCalledExactlyOnceWith(Event.ButtonClicked, {
        [Property.PageName]: Page.Sessions,
        [Property.ButtonName]: "Save",
        [Property.Surface]: Surface.Web,
      });
    } finally {
      tracker.dispose();
    }
  });

  it("tracks keyboard activation and excludes disabled buttons", async () => {
    const capture = vi.fn();
    const view = render(
      <SurfaceAnalyticsProvider
        capture={capture}
        getClickPage={() => ({ pageName: Page.Settings, entry: "/settings" })}
        surface={Surface.Web}
      >
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          Save
        </button>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          disabled
          type="button"
        >
          Cancel
        </button>
      </SurfaceAnalyticsProvider>
    );
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");
    await user.click(view.getByText("Cancel"));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it.each(["link", "menuitem", "tab", "button"])(
    "tracks %s actions with nested content once",
    (role) => {
      const capture = vi.fn();
      const view = render(
        <SurfaceAnalyticsProvider
          capture={capture}
          getClickPage={() => ({ pageName: Page.Sessions, entry: "/sessions" })}
          surface={Surface.Web}
        >
          <div data-analytics-action="true">
            <button
              data-analytics-visible-source={JSON.stringify(["Save"])}
              role={role}
              type="button"
            >
              <span>Save</span>
            </button>
          </div>
        </SurfaceAnalyticsProvider>
      );
      fireEvent.mouseDown(view.getByText("Save"));
      fireEvent.click(view.getByText("Save"));
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0][1][Property.ButtonName]).toBe("Save");
    }
  );

  it("keeps a failing transport from interrupting the action", () => {
    const action = vi.fn();
    const view = render(
      <SurfaceAnalyticsProvider
        capture={() => {
          throw new Error("unavailable");
        }}
        getClickPage={() => ({ pageName: Page.Settings, entry: "/settings" })}
        surface={Surface.Web}
      >
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          onClick={action}
          type="button"
        >
          Save
        </button>
      </SurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not carry dashboard properties onto another page", () => {
    let pageName: Page = Page.Dashboard;
    const capture = vi.fn();
    const tracker = installButtonClickTracker({
      document: globalThis.document,
      surface: Surface.Desktop,
      capture,
      getPage: () => ({ pageName, entry: pageName }),
    });
    try {
      tracker.recordPageView({
        [Property.PageName]: Page.Dashboard,
        [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.Zero,
      });
      pageName = Page.Settings;
      const view = render(
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          Save
        </button>
      );
      fireEvent.click(view.getByRole("button"));
      expect(capture.mock.calls[0][1]).not.toHaveProperty(
        Property.OwnAnalyzedSessionsVolume
      );
    } finally {
      tracker.dispose();
    }
  });
});

describe("button names", () => {
  it("requires control-local source provenance even when customer text matches product copy", () => {
    const view = render(
      <>
        <button type="button">Save</button>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          Save
        </button>
        <a href="/acme/sessions/123">Save</a>
        <div data-analytics-visible-source={JSON.stringify(["Save"])}>
          <button type="button">Save</button>
        </div>
      </>
    );
    expect(view.getAllByRole("button").map(buttonName)).toEqual([
      "Activate action",
      "Save",
      "Activate action",
    ]);
    expect(buttonName(view.getByRole("link"))).toBe("Open session");
  });
  it("prefers visible text, then accessible label, then tooltip", () => {
    const view = render(
      <>
        <button
          aria-label="Cancel"
          data-analytics-accessible-source={JSON.stringify(["Cancel"])}
          data-analytics-tooltip-source={JSON.stringify(["Close"])}
          data-analytics-visible-source={JSON.stringify(["Save"])}
          title="Close"
          type="button"
        >
          Save
        </button>
        <button
          aria-label="Cancel"
          data-analytics-accessible-source={JSON.stringify(["Cancel"])}
          data-analytics-tooltip-source={JSON.stringify(["Close"])}
          data-analytics-visible-source={JSON.stringify(["Save"])}
          title="Close"
          type="button"
        />
        <button
          data-analytics-tooltip-source={JSON.stringify(["Close"])}
          data-analytics-visible-source={JSON.stringify(["Save"])}
          title="Close"
          type="button"
        />
      </>
    );
    expect(view.getAllByRole("button").map(buttonName)).toEqual([
      "Save",
      "Cancel",
      "Close",
    ]);
  });

  it("replaces customer content in visible, accessible, and tooltip labels", () => {
    const privateLabel = "private-customer-repository-817";
    const view = render(
      <>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        >
          {privateLabel}
        </button>
        <button
          aria-label={privateLabel}
          data-analytics-visible-source={JSON.stringify(["Save"])}
          type="button"
        />
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          title={privateLabel}
          type="button"
        />
        <a href="/acme/branches/123">{privateLabel}</a>
      </>
    );
    const names = [...view.getAllByRole("button"), view.getByRole("link")].map(
      buttonName
    );
    expect(names).toEqual([
      "Activate action",
      "Activate action",
      "Activate action",
      "Open branch",
    ]);
    expect(names.join(" ")).not.toContain(privateLabel);
  });
});

describe("explicit download click properties", () => {
  it.each([
    ["false", { [Property.DownloadClicked]: false }],
    ["true", { [Property.DownloadClicked]: true }],
    ["unknown", {}],
  ])("parses %s without inventing a boolean", (attribute, properties) => {
    const capture = vi.fn();
    const view = render(
      <SurfaceAnalyticsProvider
        capture={capture}
        getClickPage={() => ({
          pageName: Page.Onboarding,
          entry: "onboarding",
        })}
        surface={Surface.Web}
      >
        <button data-analytics-download-clicked={attribute} type="button">
          Continue
        </button>
      </SurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(capture).toHaveBeenCalledExactlyOnceWith(Event.ButtonClicked, {
      [Property.ButtonName]: "Activate action",
      [Property.PageName]: Page.Onboarding,
      [Property.Surface]: Surface.Web,
      ...properties,
    });
  });
});
