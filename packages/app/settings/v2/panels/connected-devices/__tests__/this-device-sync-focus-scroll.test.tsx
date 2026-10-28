// @vitest-environment jsdom

/**
 * Where a reader sent to this section LANDS.
 *
 * The section is taller than the dialog's scroller — four option cards at four
 * comparison rows each — so which box is aligned, and to which edge, decides
 * whether the reader arrives at the question or in the middle of it with the
 * Save control below the fold.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceReason,
  type SettingsLocalSyncPolicyProjection,
  settingsLocalDeviceUnavailable,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsHostAdapterProvider } from "../../../../../shared/settings-host/provider";
import type { SettingsHostAdapter } from "../../../../../shared/settings-host/settings-host-adapter";
import { ThisDeviceSyncSection } from "../this-device-sync-section";

const SECTION_HEADING = "This device's sync level";

describe("ThisDeviceSyncSection landing position", () => {
  let scrolled: { element: Element; options: ScrollIntoViewOptions }[];

  beforeEach(() => {
    scrolled = [];
    // jsdom implements no layout, so `scrollIntoView` is absent rather than
    // inert: the spy is what makes the call observable at all.
    Element.prototype.scrollIntoView = vi.fn(function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions
    ) {
      scrolled.push({
        element: this,
        options: typeof options === "object" ? options : {},
      });
    });
  });

  it("aligns the top of the labelled group, heading included", async () => {
    renderSection({ focusSyncPolicy: true });

    await waitFor(() => expect(scrolled).toHaveLength(1));
    const [call] = scrolled;
    // `start`, never `center`: centring a box taller than the viewport lands the
    // reader mid-section with the Save control below the fold.
    expect(call.options.block).toBe("start");
    // The labelled REGION, so the heading the reader was sent to read is on
    // screen — not the options div nested below it.
    expect(call.element.tagName).toBe("SECTION");
    expect(call.element).toContainElement(
      screen.getByRole("heading", { name: SECTION_HEADING })
    );
  });

  it("leaves the reader where they were when it was not sent here", async () => {
    renderSection({ focusSyncPolicy: false });

    await screen.findByRole("heading", { name: SECTION_HEADING });
    expect(scrolled).toHaveLength(0);
  });
});

function renderSection({ focusSyncPolicy }: { focusSyncPolicy: boolean }) {
  return render(<ThisDeviceSyncSection focusSyncPolicy={focusSyncPolicy} />, {
    wrapper: wrapperFor(settingsLocalSyncPolicyReady(DataSyncLevel.Full, true)),
  });
}

function wrapperFor(projection: SettingsLocalSyncPolicyProjection) {
  const adapter: SettingsHostAdapter = {
    host: SettingsPanelHost.Desktop,
    localSyncPolicy: {
      read: () => Promise.resolve(projection),
      write: () => Promise.resolve(projection),
    },
    readLocalDevice: () =>
      Promise.resolve(
        settingsLocalDeviceUnavailable(
          SettingsLocalDeviceReason.BridgeUnavailable
        )
      ),
  };
  return ({ children }: { children: ReactNode }) => (
    <SettingsHostAdapterProvider adapter={adapter}>
      {children}
    </SettingsHostAdapterProvider>
  );
}
