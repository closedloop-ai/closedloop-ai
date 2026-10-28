import { DATA_SYNC_LEVELS } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
  SessionVolumeBucket,
  UnknownSyncChoice,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDesktopAnalyticsPayload } from "../../../../../api/lib/desktop-analytics-schema";
import { registerSurfaceAnalyticsIpcHandlers } from "../../../main/ipc/surface-analytics-ipc";
import { setBlockingOnboardingModalOpen } from "../../components/onboarding/blocking-onboarding-modal-store";
import { DesktopSurfaceAnalyticsProvider } from "../desktop-surface-analytics-adapter";

const originalApi = globalThis.window.desktopApi;
const originalUrl = globalThis.location.href;

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis.window, "desktopApi", {
    configurable: true,
    value: originalApi,
    writable: true,
  });
  globalThis.history.replaceState(null, "", originalUrl);
  setBlockingOnboardingModalOpen(false);
});

function Dashboard() {
  usePageViewedEvent(Page.Dashboard, {
    properties: {
      [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.Zero,
    },
  });
  return (
    <button
      data-analytics-visible-source={JSON.stringify(["Save"])}
      type="button"
    >
      Save
    </button>
  );
}

describe("button clicks through the desktop analytics pipeline", () => {
  it.each([
    ["#/sessions", Page.Sessions, undefined],
    ["#/sessions/private-id", Page.SessionDetail, undefined],
    ["#/branches/private-id", Page.BranchDetail, undefined],
    ["#/settings?panel=security", Page.Settings, undefined],
    ["#/analytics", Page.Insights, undefined],
    ["#/packs/private-id", Page.PackDetail, undefined],
    ...[...DATA_SYNC_LEVELS, UnknownSyncChoice, null].map(
      (choice) => ["#/settings", Page.Settings, choice] as const
    ),
  ] as const)(
    "admits a real click on %s (%s, sync choice %s) through the renderer, IPC and API schema",
    (hash, expectedPage, syncChoice) => {
      globalThis.history.replaceState(null, "", hash);
      let handler: ((event: unknown, payload?: unknown) => unknown) | undefined;
      const received = vi.fn();
      registerSurfaceAnalyticsIpcHandlers(
        {
          handle: (_channel, listener) => {
            handler = listener;
          },
        },
        {
          isTrustedSender: () => true,
          captureAnalytics: (event, properties) =>
            received(
              parseDesktopAnalyticsPayload({
                event,
                properties,
                occurredAt: "2026-09-29T21:00:00.000Z",
              })
            ),
        }
      );
      Object.defineProperty(globalThis.window, "desktopApi", {
        configurable: true,
        value: {
          captureSurfaceAnalytics: (payload: unknown) =>
            Promise.resolve(handler?.({ sender: {} }, payload)),
        },
      });
      const view = render(
        <DesktopSurfaceAnalyticsProvider>
          <button
            data-analytics-sync-choice={syncChoice === null ? "" : syncChoice}
            data-analytics-visible-source={JSON.stringify(["Save"])}
            type="button"
          >
            Save
          </button>
        </DesktopSurfaceAnalyticsProvider>
      );
      fireEvent.click(view.getByRole("button"));
      expect(received).toHaveBeenCalledExactlyOnceWith({
        ok: true,
        payload: {
          event: Event.ButtonClicked,
          properties: {
            ...(syncChoice === undefined
              ? {}
              : { [Property.SyncChoiceSelected]: syncChoice }),
            [Property.PageName]: expectedPage,
            [Property.ButtonName]: "Save",
            [Property.Surface]: Surface.Desktop,
          },
          occurredAt: "2026-09-29T21:00:00.000Z",
        },
      });
    }
  );

  it("retains page-view properties across query-only navigation", () => {
    globalThis.history.replaceState(null, "", "#/dashboard?period=week");
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(globalThis.window, "desktopApi", {
      configurable: true,
      value: { captureSurfaceAnalytics },
    });
    const view = render(
      <DesktopSurfaceAnalyticsProvider>
        <Dashboard />
      </DesktopSurfaceAnalyticsProvider>
    );
    globalThis.history.replaceState(null, "", "#/dashboard?period=month");
    globalThis.window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.click(view.getByRole("button"));
    expect(captureSurfaceAnalytics).toHaveBeenLastCalledWith({
      event: Event.ButtonClicked,
      properties: {
        [Property.PageName]: Page.Dashboard,
        [Property.ButtonName]: "Save",
        [Property.Surface]: Surface.Desktop,
        [Property.OwnAnalyzedSessionsVolume]: SessionVolumeBucket.Zero,
        [Property.OrgAnalyzedSessionsVolume]: "unknown",
      },
    });
  });

  it("attributes the onboarding takeover instead of the mounted dashboard", () => {
    globalThis.history.replaceState(null, "", "#/dashboard");
    setBlockingOnboardingModalOpen(true);
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(globalThis.window, "desktopApi", {
      configurable: true,
      value: { captureSurfaceAnalytics },
    });
    const view = render(
      <DesktopSurfaceAnalyticsProvider>
        <button
          data-analytics-visible-source={JSON.stringify(["Continue"])}
          type="button"
        >
          Continue
        </button>
      </DesktopSurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(
      captureSurfaceAnalytics.mock.calls[0][0].properties[Property.PageName]
    ).toBe(Page.Onboarding);
  });

  it("still runs an action on a version-skewed preload without analytics", () => {
    Object.defineProperty(globalThis.window, "desktopApi", {
      configurable: true,
      value: {},
    });
    const action = vi.fn();
    const view = render(
      <DesktopSurfaceAnalyticsProvider>
        <button
          data-analytics-visible-source={JSON.stringify(["Save"])}
          onClick={action}
          type="button"
        >
          Save
        </button>
      </DesktopSurfaceAnalyticsProvider>
    );
    fireEvent.click(view.getByRole("button"));
    expect(action).toHaveBeenCalledOnce();
  });
});
