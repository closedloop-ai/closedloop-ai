import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsPageName as Page,
  OnboardingAnalyticsProperty as Property,
  UnknownSyncChoice,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../surface-analytics-context";

afterEach(cleanup);

describe.each([Surface.Web, Surface.Desktop])(
  "sync choice click on %s",
  (surface) => {
    it.each([
      ...DATA_SYNC_LEVELS,
      UnknownSyncChoice,
      "",
      "unrecognized-private-value",
    ])("captures %s before the action changes the selection", (selection) => {
      const capture = vi.fn();
      const view = render(
        <SurfaceAnalyticsProvider
          capture={capture}
          getClickPage={() => ({ pageName: Page.Settings, entry: "/settings" })}
          surface={surface}
        >
          <button
            data-analytics-sync-choice={selection}
            data-analytics-visible-source={JSON.stringify(["Save sync choice"])}
            onClick={(event) => {
              event.currentTarget.setAttribute(
                "data-analytics-sync-choice",
                DataSyncLevel.Off
              );
            }}
            type="button"
          >
            <span>Save sync choice</span>
          </button>
          <button
            data-analytics-visible-source={JSON.stringify(["Cancel"])}
            type="button"
          >
            Cancel
          </button>
        </SurfaceAnalyticsProvider>
      );
      fireEvent.click(view.getByText("Save sync choice"));
      let expected: string | null = selection;
      if (selection === "") {
        expected = null;
      } else if (selection === "unrecognized-private-value") {
        expected = UnknownSyncChoice;
      }
      expect(capture).toHaveBeenCalledExactlyOnceWith(Event.ButtonClicked, {
        [Property.Surface]: surface,
        [Property.PageName]: Page.Settings,
        [Property.ButtonName]: "Save sync choice",
        [Property.SyncChoiceSelected]: expected,
      });
      fireEvent.click(view.getByText("Cancel"));
      expect(capture.mock.calls[1][1]).not.toHaveProperty(
        Property.SyncChoiceSelected
      );
    });
  }
);
