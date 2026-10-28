/**
 * ISS-10502 — desktop `page_viewed` on the activation edge.
 *
 * The desktop shell keeps visited views mounted (keep-alive), so this hook
 * must emit on the resolved-page CHANGE — including a return to a page left
 * for a detail or the Settings modal — and never on a mere re-render.
 */

import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBlockingOnboardingModalOpen } from "../../components/onboarding/blocking-onboarding-modal-store";
import { NavId } from "../../navigation/route-table";
import { useDesktopPageViewedEvent } from "../use-desktop-page-viewed-event";

// The takeover store is module-level state; leave every case at "closed".
afterEach(() => {
  act(() => {
    setBlockingOnboardingModalOpen(false);
  });
});

function Harness({
  detailOpen,
  navId,
  settingsOpen,
}: {
  detailOpen: boolean;
  navId: NavId;
  settingsOpen: boolean;
}) {
  useDesktopPageViewedEvent({ detailOpen, navId, settingsOpen });
  return null;
}

function setup(initial: {
  detailOpen: boolean;
  navId: NavId;
  settingsOpen: boolean;
}) {
  const capture = vi.fn();
  const view = render(
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Desktop}>
      <Harness {...initial} />
    </SurfaceAnalyticsProvider>
  );
  const update = (next: {
    detailOpen: boolean;
    navId: NavId;
    settingsOpen: boolean;
  }) =>
    view.rerender(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Desktop}>
        <Harness {...next} />
      </SurfaceAnalyticsProvider>
    );
  return { capture, update };
}

function pageViewedNames(capture: ReturnType<typeof vi.fn>): string[] {
  return capture.mock.calls
    .filter(([event]) => event === OnboardingAnalyticsEvent.PageViewed)
    .map(([, properties]) => properties[OnboardingAnalyticsProperty.PageName]);
}

const ON_DASHBOARD = {
  detailOpen: false,
  navId: NavId.Dashboard,
  settingsOpen: false,
};
const ON_SESSIONS = {
  detailOpen: false,
  navId: NavId.Sessions,
  settingsOpen: false,
};

describe("useDesktopPageViewedEvent", () => {
  it("leaves the dashboard emit to its data-aware view", () => {
    const { capture, update } = setup(ON_DASHBOARD);
    update(ON_DASHBOARD);
    update(ON_DASHBOARD);
    expect(pageViewedNames(capture)).toEqual([]);
  });

  it("emits on each activation edge, including a return to a page left for a detail", () => {
    const { capture, update } = setup(ON_SESSIONS);
    // Into a session detail: the nav id stays sticky, the page is not active.
    update({ ...ON_SESSIONS, detailOpen: true });
    // Back to the list: the same moment a web remount would emit.
    update(ON_SESSIONS);
    expect(pageViewedNames(capture)).toEqual([
      OnboardingAnalyticsPageName.Sessions,
      OnboardingAnalyticsPageName.Sessions,
    ]);
  });

  it("emits settings for the modal route and the underlying page again on close", () => {
    const { capture, update } = setup(ON_DASHBOARD);
    update({ ...ON_DASHBOARD, settingsOpen: true });
    update(ON_DASHBOARD);
    expect(pageViewedNames(capture)).toEqual([
      OnboardingAnalyticsPageName.Settings,
    ]);
  });

  it("leaves the dashboard takeover edge to its data-aware view", () => {
    // Fresh install: the shell renders behind the takeover's scrim from launch
    // with navId already Dashboard. Emitting at t=0 would count a page nobody
    // can see AND latch the edge so the real dashboard arrival never fires.
    act(() => {
      setBlockingOnboardingModalOpen(true);
    });
    const { capture, update } = setup(ON_DASHBOARD);
    update(ON_DASHBOARD);
    expect(pageViewedNames(capture)).toEqual([]);

    // Onboarding completes; the dashboard the reader can now SEE is the edge.
    act(() => {
      setBlockingOnboardingModalOpen(false);
    });
    expect(pageViewedNames(capture)).toEqual([]);
  });

  it("emits nothing for a nav page outside the closed vocabulary", () => {
    const { capture, update } = setup({
      detailOpen: false,
      navId: NavId.Agents,
      settingsOpen: false,
    });
    update({ detailOpen: false, navId: NavId.Packs, settingsOpen: false });
    expect(pageViewedNames(capture)).toEqual([]);
  });
});
