import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_DOWNLOAD_HREFS,
  DESKTOP_INSTALLER_AVAILABILITY,
  DESKTOP_OS_LABEL,
  DESKTOP_OS_VALUES,
  DesktopInstallerAvailability,
  DesktopOs,
  DetectedPlatform,
  describeDesktopInstallerGap,
  desktopInstallerIsPublished,
  detectDesktopOs,
  isDesktopOs,
} from "../desktop-platform-availability";

/**
 * The literals below are written out rather than read back from the module they
 * check. Asserting `DESKTOP_INSTALLER_AVAILABILITY[Windows] === (whatever the
 * module says)` is satisfied by any value, including the `Published` that would
 * put the dead macOS link back in front of a Windows user. The duplication is
 * the test.
 */
const PLATFORMS_WITH_A_PUBLISHED_INSTALLER: readonly DesktopOs[] = [
  "linux",
  "mac",
];
const PLATFORMS_WITHOUT_ONE: readonly DesktopOs[] = ["windows"];

const MAC_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);

function stubNavigator(
  value: { platform?: string; userAgent?: string } | undefined
): void {
  // Defined as an OWN property with `value: undefined` for the absent case
  // rather than deleted: jsdom serves `navigator` from the window prototype, so
  // a delete leaves the jsdom agent in place and the "no navigator" case would
  // pass by reaching the macOS fallback through the wrong branch. `typeof`
  // reads an own `undefined` the same way it reads an undeclared binding.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("which desktop installers exist", () => {
  it.each(PLATFORMS_WITH_A_PUBLISHED_INSTALLER)(
    "reports %s as published",
    (os) => {
      expect(DESKTOP_INSTALLER_AVAILABILITY[os]).toBe(
        DesktopInstallerAvailability.Published
      );
      expect(desktopInstallerIsPublished(os)).toBe(true);
    }
  );

  it.each(PLATFORMS_WITHOUT_ONE)("reports %s as not yet published", (os) => {
    expect(DESKTOP_INSTALLER_AVAILABILITY[os]).toBe(
      DesktopInstallerAvailability.NotYetPublished
    );
    expect(desktopInstallerIsPublished(os)).toBe(false);
  });

  it("covers every platform the surfaces can detect", () => {
    // Neither list above may quietly stop covering a platform: a member added to
    // DesktopOs and to neither list would leave both `it.each` blocks green.
    expect(
      [...PLATFORMS_WITH_A_PUBLISHED_INSTALLER, ...PLATFORMS_WITHOUT_ONE].sort()
    ).toEqual(Object.values(DesktopOs).sort());
  });
});

describe("what the surfaces say about a platform with no installer", () => {
  it("names the platform and the state, not just an absence", () => {
    const gap = describeDesktopInstallerGap(DesktopOs.Windows);

    expect(gap.headline).toBe("Not available for Windows yet");
    expect(gap.detail).toBe(
      "There is no Windows installer to download yet. Closedloop Desktop installs on Linux and macOS today."
    );
  });

  it("names each platform by its own label", () => {
    // Every platform, not just the unpublished one, so the headline cannot be a
    // Windows special case dressed as a helper.
    for (const os of DESKTOP_OS_VALUES) {
      expect(describeDesktopInstallerGap(os).headline).toBe(
        `Not available for ${DESKTOP_OS_LABEL[os]} yet`
      );
    }
  });

  it("reads the alternative back out of the availability map", () => {
    // The sentence must follow the artifacts. macOS is named because its entry
    // says Published, not because the string was typed in.
    const publishedLabels = Object.values(DesktopOs)
      .filter(desktopInstallerIsPublished)
      .map((os) => DESKTOP_OS_LABEL[os]);

    expect(publishedLabels.length).toBeGreaterThan(0);
    for (const label of publishedLabels) {
      expect(describeDesktopInstallerGap(DesktopOs.Windows).detail).toContain(
        label
      );
    }
  });
});

describe("detecting the visitor's platform", () => {
  it("reads Windows from the user agent", () => {
    stubNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });

    expect(detectDesktopOs()).toBe(DesktopOs.Windows);
  });

  it("reads Linux from the user agent", () => {
    stubNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });

    expect(detectDesktopOs()).toBe(DesktopOs.Linux);
  });

  it("does not read the darwin kernel name as Windows", () => {
    // "win" is a substring of "darwin", and jsdom's own agent string carries the
    // kernel name, so this is the misread that would strand a Mac user on a gap
    // notice for a platform they are not on.
    stubNavigator({ userAgent: "Mozilla/5.0 (darwin) jsdom/27.0.0" });

    expect(detectDesktopOs()).toBe(DesktopOs.Mac);
  });

  it("reads macOS from a real Safari agent", () => {
    stubNavigator({ platform: "MacIntel", userAgent: MAC_AGENT });

    expect(detectDesktopOs()).toBe(DesktopOs.Mac);
  });

  it("reports that it could not tell, rather than guessing macOS", () => {
    // Behavior CHANGED here, deliberately: this used to answer macOS, which put
    // the `.dmg` back in play for Chrome OS and anything else naming no desktop
    // OS. Perrin's ISS-9651 ruling (2026-09-07) is that the read reports the
    // truth and the control offers every platform -- so the guess moves out of
    // the detection instead of the download moving out of reach.
    stubNavigator({ userAgent: "some future browser" });

    expect(detectDesktopOs()).toBe(DetectedPlatform.Unrecognized);
  });

  it("reports the same with no navigator at all", () => {
    stubNavigator(undefined);

    expect(detectDesktopOs()).toBe(DetectedPlatform.Unrecognized);
  });

  it("keeps Unrecognized out of the platforms an installer can exist for", () => {
    // The guard the surfaces branch on. Written against the availability record
    // rather than the union so a member added to one and not the other cannot
    // pass: every real platform narrows, the non-platform state does not.
    for (const os of DESKTOP_OS_VALUES) {
      expect(isDesktopOs(os)).toBe(true);
    }

    expect(isDesktopOs(DetectedPlatform.Unrecognized)).toBe(false);
  });

  /**
   * The canonical installer map and the availability record must agree in BOTH
   * directions (ISS-11261 review: whitlockk, chatgpt-codex-connector).
   *
   * Before this, two hosts each carried their own copy of the map, so the day a
   * Windows artifact is published, flipping the availability record and the
   * wizard's copy left the dashboard still telling its reader there is no
   * installer — silently, because a stale `null` renders as the honest gap arm.
   * One map fixes the copy; this fixes the other half, which is the map falling
   * out of step with the record beside it.
   *
   * Both directions, because each catches a different mistake: a platform marked
   * `Published` with no URL ships a card offering nothing, and a URL under a
   * platform still marked unpublished ships a download the release channel does
   * not have.
   */
  it("keeps the default installer map in step with the availability record", () => {
    for (const os of DESKTOP_OS_VALUES) {
      const href = DEFAULT_DESKTOP_DOWNLOAD_HREFS[os];
      expect({ os, offersAnInstaller: href !== null }).toEqual({
        os,
        offersAnInstaller: desktopInstallerIsPublished(os),
      });
    }
  });

  /**
   * Pinned against an independent literal rather than read back from
   * `@repo/api`, for the reason the header of this file gives: a fixture
   * assembled from the constant it polices agrees with whatever that constant
   * becomes, including a URL the public mirror does not answer.
   */
  it("points each published platform at the public mirror's own asset", () => {
    expect(DEFAULT_DESKTOP_DOWNLOAD_HREFS[DesktopOs.Mac]).toBe(
      "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-universal.dmg"
    );
    // ISS-12614: AppImage, not `.deb` (operator choice).
    expect(DEFAULT_DESKTOP_DOWNLOAD_HREFS[DesktopOs.Linux]).toBe(
      "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-linux-x64.AppImage"
    );
  });
});
