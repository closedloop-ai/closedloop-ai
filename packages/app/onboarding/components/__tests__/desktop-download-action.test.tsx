// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopDownloadHrefs,
  DesktopOs,
  DetectedPlatform,
} from "../../lib/desktop-platform-availability";
import { DesktopDownloadAction } from "../desktop-download-action";

/**
 * ISS-11261: the extracted composite's ONE invariant, driven directly.
 *
 * "Whichever arm renders, exactly one always carries a forward control" is what
 * made this movable and what keeps a reader whose platform has no published
 * artifact out of a dead end. Before this file that invariant was enforced only
 * by the two required prop types and observed only incidentally, through two
 * hosts that between them never reached every arm — the wizard's suite never
 * pairs an unrecognized agent with `downloaded`, and the dashboard host pins
 * `downloaded={false}` so it can reach no post-install arm at all.
 *
 * The two slots are distinguishable markers rather than the hosts' real controls,
 * so a case says WHICH forward move rendered and not merely that something did.
 */

const DOWNLOAD_HREFS = {
  // Mirrors production: macOS and Linux resolve, Windows does not (ISS-12614).
  [DesktopOs.Linux]: "https://downloads.test/Closedloop-linux-x64.AppImage",
  [DesktopOs.Mac]: "https://downloads.test/Closedloop-universal.dmg",
  [DesktopOs.Windows]: null,
} as const;

const NO_INSTALLER_NAME = "no-installer-exit";
const POST_INSTALL_NAME = "post-install-exit";
const MAC_INSTALL_NAME = "Download Mac Desktop App";
const LINUX_INSTALL_NAME = "Download Linux Desktop App";

/** Every state the composite has: four platform arms x both `downloaded`. */
const PLATFORMS = [
  null,
  DetectedPlatform.Unrecognized,
  DesktopOs.Mac,
  DesktopOs.Windows,
] as const;

/**
 * The other map the TYPE permits: every platform unpublished (ISS-11261 review,
 * whitlockk). `DesktopDownloadHrefs` allows it, so a host may pass it — and the arm
 * that rendered for it used to be the one arm with nothing to press.
 */
const NO_INSTALLER_HREFS = {
  [DesktopOs.Linux]: null,
  [DesktopOs.Mac]: null,
  [DesktopOs.Windows]: null,
} as const;

function renderAction({
  detectedOs,
  downloaded,
  downloadHrefs = DOWNLOAD_HREFS,
}: {
  detectedOs: (typeof PLATFORMS)[number];
  downloaded: boolean;
  downloadHrefs?: DesktopDownloadHrefs;
}) {
  return render(
    <DesktopDownloadAction
      detectedOs={detectedOs}
      downloaded={downloaded}
      downloadHrefs={downloadHrefs}
      noInstallerAction={<button type="button">{NO_INSTALLER_NAME}</button>}
      onDownload={vi.fn()}
      postInstallAction={<button type="button">{POST_INSTALL_NAME}</button>}
    />
  );
}

/** Every element a reader could press, by accessible name. */
function forwardControlNames(): string[] {
  return [
    ...screen.queryAllByRole("button"),
    ...screen.queryAllByRole("link"),
  ].map((control) => control.textContent ?? "");
}

/**
 * Both maps a host may legitimately pass. The matrix runs over BOTH because the
 * invariant is a property of the component, not of today's release channel: with
 * only the production-shaped map it stayed green while the all-null map — the
 * one the type permits and the one an unpublished macOS incident produces — hit
 * the single arm that rendered nothing pressable.
 */
const HREF_MAPS = [
  { hrefs: DOWNLOAD_HREFS, label: "macOS published" },
  { hrefs: NO_INSTALLER_HREFS, label: "no installer published" },
] as const;

describe("DesktopDownloadAction forward-control invariant (ISS-11261)", () => {
  for (const { hrefs, label } of HREF_MAPS) {
    for (const detectedOs of PLATFORMS) {
      for (const downloaded of [false, true]) {
        it(`carries at least one pressable control for ${String(detectedOs)} / downloaded=${downloaded} / ${label}`, () => {
          renderAction({ detectedOs, downloaded, downloadHrefs: hrefs });

          // The invariant itself: an arm with nothing to press is the dead end
          // the required slots exist to prevent, on every host.
          expect(forwardControlNames().length).toBeGreaterThan(0);
        });
      }
    }
  }

  it("withholds the installer but not the way out before detection answers", () => {
    renderAction({ detectedOs: null, downloaded: false });

    expect(
      screen.getByRole("button", { name: NO_INSTALLER_NAME })
    ).toBeDefined();
    // Paired on the same render: no platform has been measured, so nothing may
    // name one or link to its artifact.
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.queryByRole("button", { name: POST_INSTALL_NAME })
    ).toBeNull();
  });

  it("states the gap and offers the no-installer exit for an unpublished platform", () => {
    renderAction({ detectedOs: DesktopOs.Windows, downloaded: false });

    expect(screen.getByText("Not available for Windows yet")).toBeDefined();
    expect(
      screen.getByRole("button", { name: NO_INSTALLER_NAME })
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: MAC_INSTALL_NAME })).toBeNull();
  });

  /**
   * The gap arm ignores `downloaded`, deliberately: href presence leads, so a
   * Windows visitor carrying `downloaded` cannot fall through to the per-platform
   * detail line and be told "Windows · x64 installer" over a null href.
   */
  it("keeps the gap arm for an unpublished platform that claims an install", () => {
    renderAction({ detectedOs: DesktopOs.Windows, downloaded: true });

    expect(screen.getByText("Not available for Windows yet")).toBeDefined();
    expect(screen.queryByText("Windows · x64 installer")).toBeNull();
  });

  it("offers the named installer for a published platform", () => {
    renderAction({ detectedOs: DesktopOs.Mac, downloaded: false });

    expect(
      screen.getByRole("link", { name: MAC_INSTALL_NAME })
    ).toHaveAttribute("href", DOWNLOAD_HREFS[DesktopOs.Mac]);
    expect(screen.getByText("macOS · Universal installer")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: POST_INSTALL_NAME })
    ).toBeNull();
  });

  it("replaces the installer with the post-install exit once it is taken", () => {
    renderAction({ detectedOs: DesktopOs.Mac, downloaded: true });

    expect(
      screen.getByRole("button", { name: POST_INSTALL_NAME })
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: MAC_INSTALL_NAME })).toBeNull();
  });

  /**
   * Perrin's ISS-9651 call: do not guess the platform, and do not withhold the
   * download either. Every platform names itself, so a Mac behind an unreadable
   * agent keeps the installer it can run and nobody is misrouted.
   */
  it("names every platform for an agent it could not read", () => {
    renderAction({
      detectedOs: DetectedPlatform.Unrecognized,
      downloaded: false,
    });

    expect(
      screen.getByRole("link", { name: MAC_INSTALL_NAME })
    ).toHaveAttribute("href", DOWNLOAD_HREFS[DesktopOs.Mac]);
    expect(
      screen.getByRole("link", { name: LINUX_INSTALL_NAME })
    ).toHaveAttribute("href", DOWNLOAD_HREFS[DesktopOs.Linux]);
    expect(screen.getByText("Not available for Windows yet")).toBeDefined();
  });

  /**
   * The one arm neither host could reach, and the reason this file exists: an
   * unreadable agent that HAS installed gets the post-install exit ONCE, not
   * three re-offered installers and not one exit per platform.
   */
  it("offers a single post-install exit to an unreadable agent that installed", () => {
    renderAction({
      detectedOs: DetectedPlatform.Unrecognized,
      downloaded: true,
    });

    expect(
      screen.getAllByRole("button", { name: POST_INSTALL_NAME })
    ).toHaveLength(1);
    expect(screen.queryByRole("link", { name: MAC_INSTALL_NAME })).toBeNull();
    expect(screen.queryByText("Not available for Windows yet")).toBeNull();
  });

  /**
   * The arm whitlockk found, stated positively (ISS-11261 review). An unrecognized
   * visitor carrying a map where NO platform resolves got three gap paragraphs
   * and nothing to press: the gap sentences state a fact, they are not a way
   * out. The exit renders ONCE — one per gap row would put three identical
   * controls on one card.
   */
  it("gives an unreadable agent one exit when no platform has an installer", () => {
    renderAction({
      detectedOs: DetectedPlatform.Unrecognized,
      downloaded: false,
      downloadHrefs: NO_INSTALLER_HREFS,
    });

    expect(
      screen.getAllByRole("button", { name: NO_INSTALLER_NAME })
    ).toHaveLength(1);
    // Paired on the same render: every platform still SAYS what it is, so the
    // exit is not standing in for a deleted statement.
    expect(screen.getByText("Not available for Windows yet")).toBeDefined();
    expect(screen.getByText("Not available for Linux yet")).toBeDefined();
    expect(screen.getByText("Not available for macOS yet")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  /**
   * The control for the case above: with an installer published, the exit must
   * NOT appear beside it. Two forward moves on one card is the other way to
   * satisfy "at least one" wrongly.
   */
  it("withholds the no-installer exit when a platform does resolve", () => {
    renderAction({
      detectedOs: DetectedPlatform.Unrecognized,
      downloaded: false,
    });

    expect(screen.getByRole("link", { name: MAC_INSTALL_NAME })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: NO_INSTALLER_NAME })
    ).toBeNull();
  });
});

describe("DesktopDownloadAction installer-gap follow-up (ISS-12364)", () => {
  function renderWithFollowUp(detectedOs: (typeof PLATFORMS)[number]) {
    const followUp = vi.fn((os: DesktopOs) => (
      <p data-testid="gap-follow-up">{`follow-up:${os}`}</p>
    ));
    render(
      <DesktopDownloadAction
        detectedOs={detectedOs}
        downloaded={false}
        downloadHrefs={DOWNLOAD_HREFS}
        installerGapFollowUp={followUp}
        noInstallerAction={<button type="button">{NO_INSTALLER_NAME}</button>}
        onDownload={vi.fn()}
        postInstallAction={<button type="button">{POST_INSTALL_NAME}</button>}
      />
    );
    return followUp;
  }

  it("renders it for the unpublished platform, above the no-installer exit", () => {
    const followUp = renderWithFollowUp(DesktopOs.Windows);

    expect(followUp).toHaveBeenCalledWith(DesktopOs.Windows);
    const rendered = screen.getByTestId("gap-follow-up");
    expect(rendered.textContent).toBe(`follow-up:${DesktopOs.Windows}`);
    const exit = screen.getByRole("button", { name: NO_INSTALLER_NAME });
    // The way on stays below it: the capture is never the only control.
    expect(rendered.compareDocumentPosition(exit)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  for (const detectedOs of [
    null,
    DetectedPlatform.Unrecognized,
    DesktopOs.Mac,
  ] as const) {
    it(`does not render it for ${String(detectedOs)}`, () => {
      const followUp = renderWithFollowUp(detectedOs);

      expect(followUp).not.toHaveBeenCalled();
      expect(screen.queryByTestId("gap-follow-up")).toBeNull();
    });
  }
});
