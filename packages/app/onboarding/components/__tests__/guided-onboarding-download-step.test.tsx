// @vitest-environment jsdom

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Explicit rather than stubbed through a user agent: detection has its own
  // suites, and `null` -- the state a warm mount actually paints first -- is one
  // `render` flushes past before an assertion could see it.
  detectedOs: null as string | null,
}));
vi.mock("../../hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => mocks.detectedOs,
}));

import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import {
  DesktopOs,
  DetectedPlatform,
  describeDesktopInstallerGap,
} from "../../lib/desktop-platform-availability";
import { OnboardingDesktopSkipEligibility } from "../guided-onboarding-data";
import {
  GuidedOnboardingDownloadStep,
  selectDownloadStepProps,
} from "../guided-onboarding-download-step";

const DOWNLOAD_HREFS = {
  [DesktopOs.Linux]: "https://downloads.test/Closedloop-linux-x64.AppImage",
  [DesktopOs.Mac]: "https://downloads.test/Closedloop-universal.dmg",
  [DesktopOs.Windows]: null,
} as const;

const SKIP_NAME = "Skip for now";
const INSTALL_NAME = /Download .* Desktop App/;
const UNAVAILABLE_LINE = "Skipping this step isn't available yet.";
const IN_PROGRESS_WORDING = /checking/i;
const BACK_NAME = /back/i;
const FOLLOW_UP_TEXT = /^follow-up:/;

const ALL_ELIGIBILITIES = Object.values(OnboardingDesktopSkipEligibility);
const DENIED_ELIGIBILITIES = [
  OnboardingDesktopSkipEligibility.Required,
  OnboardingDesktopSkipEligibility.Unknown,
] as const;

function renderStep(
  overrides: Partial<Parameters<typeof GuidedOnboardingDownloadStep>[0]> = {}
) {
  // Set on every render, never left to whatever a previous case wrote: these
  // cases are about the eligibility arms, and macOS is the platform whose
  // installer resolves, so it is the arm that keeps an install action.
  mocks.detectedOs = "mac";
  const props = {
    brand: <span>Closedloop.ai</span>,
    desktopAppRunning: false,
    downloadHrefs: DOWNLOAD_HREFS,
    downloaded: false,
    onContinue: vi.fn(),
    onDownload: vi.fn(),
    onSkip: vi.fn(),
    skipEligibility: OnboardingDesktopSkipEligibility.Unknown,
    ...overrides,
  };
  // The step's layout renders DialogTitle/DialogDescription, which Radix
  // requires a Dialog ancestor for. This is the smallest host that satisfies
  // that without pulling in the whole wizard.
  render(
    <Dialog open>
      <DialogContent>
        <GuidedOnboardingDownloadStep {...props} />
      </DialogContent>
    </Dialog>
  );
  return props;
}

describe("GuidedOnboardingDownloadStep skip guard", () => {
  it("offers the deferral only for a measured, eligible organization", () => {
    renderStep({
      skipEligibility: OnboardingDesktopSkipEligibility.Eligible,
    });

    expect(screen.getByRole("button", { name: SKIP_NAME })).not.toBeNull();
  });

  it.each(DENIED_ELIGIBILITIES)(
    "withholds the deferral when %s",
    (skipEligibility) => {
      renderStep({ skipEligibility });

      expect(screen.queryByRole("button", { name: SKIP_NAME })).toBeNull();
    }
  );

  it("fires onSkip only from the render that offers it", () => {
    const { onSkip } = renderStep({
      skipEligibility: OnboardingDesktopSkipEligibility.Eligible,
    });

    fireEvent.click(screen.getByRole("button", { name: SKIP_NAME }));

    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe("GuidedOnboardingDownloadStep distinguishes unmeasured from measured", () => {
  it("says so when nobody has measured the organization", () => {
    renderStep({ skipEligibility: OnboardingDesktopSkipEligibility.Unknown });

    expect(screen.getByText(UNAVAILABLE_LINE)).not.toBeNull();
  });

  it("stays silent when the organization was measured to have no data", () => {
    // The paired control for the case above, and the whole point of keeping
    // Required and Unknown apart: both hide the button, so the LINE is the only
    // thing that distinguishes "we looked and the answer is no" from "nobody
    // looked". Without this assertion an implementation that collapsed the two
    // would pass every other test in this file.
    renderStep({ skipEligibility: OnboardingDesktopSkipEligibility.Required });

    expect(screen.queryByText(UNAVAILABLE_LINE)).toBeNull();
  });

  it("makes no claim that a check is running", () => {
    renderStep({ skipEligibility: OnboardingDesktopSkipEligibility.Unknown });

    // Unknown is reached only from a `membership` that is absent or spelled by
    // another build, so any in-progress wording or spinner would describe work
    // that is not happening.
    expect(screen.queryByText(IN_PROGRESS_WORDING)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("carries the unavailable line as a single accessible statement", () => {
    renderStep({ skipEligibility: OnboardingDesktopSkipEligibility.Unknown });

    expect(screen.getAllByText(UNAVAILABLE_LINE)).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_LINE);
  });
});

describe("GuidedOnboardingDownloadStep keeps a route out", () => {
  it.each(ALL_ELIGIBILITIES)(
    "keeps the install action reachable when %s",
    (skipEligibility) => {
      // Withholding the deferral must never leave the screen with no forward
      // move — the wizard is a locked modal.
      renderStep({ skipEligibility });

      expect(screen.getByRole("link", { name: INSTALL_NAME })).not.toBeNull();
    }
  );

  it.each(DENIED_ELIGIBILITIES)(
    "renders Back in the %s arm when the host supplies it",
    (skipEligibility) => {
      renderStep({ skipEligibility, onBack: vi.fn() });

      expect(screen.getByRole("button", { name: BACK_NAME })).not.toBeNull();
    }
  );
});

describe("GuidedOnboardingDownloadStep after the app is downloaded", () => {
  it.each(ALL_ELIGIBILITIES)(
    "offers Continue alone when %s",
    (skipEligibility) => {
      // `downloaded` outranks every eligibility arm: the user is past the gate,
      // so neither the deferral nor the reason for withholding it still applies.
      renderStep({ downloaded: true, skipEligibility });

      expect(screen.getByRole("button", { name: "Continue" })).not.toBeNull();
      expect(screen.queryByRole("link", { name: INSTALL_NAME })).toBeNull();
      expect(screen.queryByRole("button", { name: SKIP_NAME })).toBeNull();
      expect(screen.queryByText(UNAVAILABLE_LINE)).toBeNull();
    }
  );
});

/**
 * ISS-9651. The literals here are written out, not imported from the module
 * under test: pulling the copy back out of `describeDesktopInstallerGap` would
 * pass whatever that helper returns, including the download button this arm
 * exists to replace.
 */
const WINDOWS_GAP_HEADLINE = "Not available for Windows yet";
const WINDOWS_INSTALLER_CLAIM = "Windows · x64 installer";
const MAC_INSTALLER_DETAIL = "macOS · Universal installer";
const CONTINUE_WITHOUT_INSTALLING = "Continue without installing";

function renderStepOnPlatform(
  detectedOs: string | null,
  overrides: Partial<Parameters<typeof GuidedOnboardingDownloadStep>[0]> = {}
) {
  mocks.detectedOs = detectedOs;
  const props = {
    brand: <span>Closedloop.ai</span>,
    desktopAppRunning: false,
    downloadHrefs: DOWNLOAD_HREFS,
    downloaded: false,
    onContinue: vi.fn(),
    onDownload: vi.fn(),
    onSkip: vi.fn(),
    skipEligibility: OnboardingDesktopSkipEligibility.Eligible,
    ...overrides,
  };
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <Dialog open>
        <DialogContent>
          <GuidedOnboardingDownloadStep {...props} />
        </DialogContent>
      </Dialog>
    </FeatureFlagAdapterProvider>
  );
  return props;
}

describe("GuidedOnboardingDownloadStep on a platform with no installer", () => {
  it("states the gap and offers no installer link on Windows", () => {
    renderStepOnPlatform("windows");

    expect(screen.getByText(WINDOWS_GAP_HEADLINE)).not.toBeNull();
    expect(screen.queryByRole("link", { name: INSTALL_NAME })).toBeNull();
    // The step must not simultaneously claim an x64 installer exists.
    expect(screen.queryByText(WINDOWS_INSTALLER_CLAIM)).toBeNull();
  });

  it("keeps the deferral reachable so the locked modal still has a move", () => {
    renderStepOnPlatform("windows");

    expect(screen.getByRole("button", { name: SKIP_NAME })).not.toBeNull();
  });

  it("leaves macOS on the download it can actually use", () => {
    // The arm that proves the branch keys off the PLATFORM. Without it, hiding the link for everyone
    // would pass the Windows case above.
    renderStepOnPlatform("mac");

    const link = screen.getByRole("link", { name: INSTALL_NAME });

    expect(link.getAttribute("href")).toBe(DOWNLOAD_HREFS[DesktopOs.Mac]);
    expect(screen.queryByText(WINDOWS_GAP_HEADLINE)).toBeNull();
  });
});

describe("GuidedOnboardingDownloadStep never strands the locked modal", () => {
  it.each(ALL_ELIGIBILITIES)(
    "keeps a forward control in the gap arm when %s and the host gave no Back",
    (skipEligibility) => {
      // The arm this replaces was not only a download: the anchor's onClick is
      // `onDownload`, which `selectDownloadStepProps` resolves to
      // `onDownloadApp ?? onContinue`. Required renders no deferral and Unknown
      // renders only a `<p role="status">`, so without a control here the step
      // has no interactive element at all inside a dialog that prevents escape,
      // outside click and pointer-down.
      renderStepOnPlatform("windows", { skipEligibility });

      expect(
        screen.getByRole("button", { name: CONTINUE_WITHOUT_INSTALLING })
      ).not.toBeNull();
    }
  );

  it("advances the wizard from the gap arm", () => {
    // Asserted from the test body after driving the production control, not
    // from inside a mock: the point is that the control is wired, not that it
    // renders.
    const { onContinue, onDownload } = renderStepOnPlatform("windows");

    fireEvent.click(
      screen.getByRole("button", { name: CONTINUE_WITHOUT_INSTALLING })
    );

    expect(onContinue).toHaveBeenCalledOnce();
    // Nothing was downloaded, so the wizard must not be told that it was.
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("offers no forward control named for a download it cannot deliver", () => {
    renderStepOnPlatform("windows");

    expect(screen.queryByRole("link", { name: INSTALL_NAME })).toBeNull();
    expect(screen.queryByRole("button", { name: INSTALL_NAME })).toBeNull();
  });
});

describe("GuidedOnboardingDownloadStep keeps the platform line on every arm", () => {
  it("still names the platform after the app is downloaded", () => {
    // This line rendered above the downloaded/not-downloaded branch before
    // ISS-9651 and must keep doing so. The macOS agent is stubbed so the
    // assertion is about the downloaded state, not about which platform was
    // detected.
    renderStepOnPlatform("mac", { downloaded: true });

    expect(screen.getByRole("button", { name: "Continue" })).not.toBeNull();
    expect(screen.getByText(MAC_INSTALLER_DETAIL)).not.toBeNull();
  });

  it("names the platform beside the download it is offering", () => {
    renderStepOnPlatform("mac");

    expect(screen.getByText(MAC_INSTALLER_DETAIL)).not.toBeNull();
  });
});

describe("GuidedOnboardingDownloadStep before the platform is known", () => {
  it("offers no installer action at all", () => {
    // `useDetectedDesktopOs` answers null until its effect runs. Every action
    // that names a platform or links to that platform's artifact has to wait,
    // so there is nothing honest to show for an answer nobody has.
    renderStepOnPlatform(null);

    expect(screen.queryByRole("link", { name: INSTALL_NAME })).toBeNull();
    expect(screen.queryByText(MAC_INSTALLER_DETAIL)).toBeNull();
  });

  it("still leaves the locked modal a way forward", () => {
    // Behavior CHANGED here, deliberately: this arm used to render nothing at
    // all, and the assertion above used to pin that. `onBack` is optional and
    // the Required arm contributes no control, so nothing-at-all was a dead end
    // on the first commit.
    // Withholding the installer never required withholding the exit.
    renderStepOnPlatform(null, {
      skipEligibility: OnboardingDesktopSkipEligibility.Required,
    });

    expect(
      screen.getByRole("button", { name: CONTINUE_WITHOUT_INSTALLING })
    ).not.toBeNull();
  });

  it("claims no platform gap it has not measured", () => {
    // The paired control for the case above: withholding the action must not
    // slide into asserting an unavailability, which is the opposite lie.
    renderStepOnPlatform(null);

    expect(screen.queryByText(WINDOWS_GAP_HEADLINE)).toBeNull();
  });
});

describe("GuidedOnboardingDownloadStep on an unpublished platform it thinks is installed", () => {
  it("never prints an installer claim the availability record contradicts", () => {
    // `downloaded` used to short-circuit ahead of the availability check, so
    // this arm fell through to `desktopDownloads` and printed "Windows · x64
    // installer" -- a second answer to the question
    // DESKTOP_INSTALLER_AVAILABILITY owns, and the exact claim FR11 forbids.
    renderStepOnPlatform(DesktopOs.Windows, { downloaded: true });

    expect(screen.queryByText(WINDOWS_INSTALLER_CLAIM)).toBeNull();
    expect(screen.getByText(WINDOWS_GAP_HEADLINE)).not.toBeNull();
  });

  it("still leaves a way forward", () => {
    // Availability leading must not cost the control: this arm is reachable
    // with no `onBack`, and the modal is locked.
    renderStepOnPlatform(DesktopOs.Windows, { downloaded: true });

    expect(
      screen.getByRole("button", { name: CONTINUE_WITHOUT_INSTALLING })
    ).not.toBeNull();
  });
});

const LINUX_GAP_HEADLINE = describeDesktopInstallerGap(
  DesktopOs.Linux
).headline;
const MAC_INSTALL_NAME = "Download Mac Desktop App";
const LINUX_INSTALL_NAME = "Download Linux Desktop App";

describe("GuidedOnboardingDownloadStep on an agent it could not identify", () => {
  it("offers every platform rather than guessing one", () => {
    // Perrin's ISS-9651 ruling: neither guess nor withhold. All three are named,
    // the ones with an artifact as real links and the one without as its own
    // gap line -- absence would read as "not supported", a different wrong
    // claim.
    renderStepOnPlatform(DetectedPlatform.Unrecognized);

    expect(
      screen.getByRole("link", { name: MAC_INSTALL_NAME }).getAttribute("href")
    ).toBe(DOWNLOAD_HREFS[DesktopOs.Mac]);
    expect(
      screen
        .getByRole("link", { name: LINUX_INSTALL_NAME })
        .getAttribute("href")
    ).toBe(DOWNLOAD_HREFS[DesktopOs.Linux]);
    expect(screen.getByText(WINDOWS_GAP_HEADLINE)).not.toBeNull();
    expect(screen.queryByText(LINUX_GAP_HEADLINE)).toBeNull();
  });

  it("never offers an installer that does not exist", () => {
    // Offering every platform must not become offering every ARTIFACT: the
    // unpublished platform is named, not linked.
    renderStepOnPlatform(DetectedPlatform.Unrecognized);

    expect(screen.getAllByRole("link", { name: INSTALL_NAME })).toHaveLength(2);
    expect(screen.queryByText(WINDOWS_INSTALLER_CLAIM)).toBeNull();
  });

  it("does not widen a platform it DID identify", () => {
    // The other direction, and the half that makes the case above mean
    // something: a test that only proved the unrecognized arm would pass just as
    // well against a step that offered everything to everyone.
    renderStepOnPlatform(DesktopOs.Mac);

    expect(screen.getAllByRole("link", { name: INSTALL_NAME })).toHaveLength(1);
    expect(screen.queryByText(WINDOWS_GAP_HEADLINE)).toBeNull();
    expect(screen.queryByText(LINUX_GAP_HEADLINE)).toBeNull();
  });
});

const SWITCH_NAME = "Switch to Desktop";

describe("GuidedOnboardingDownloadStep when a Desktop is reporting online", () => {
  const originalLocation = globalThis.location;

  beforeEach(() => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "" },
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
  });

  it("offers the handoff", () => {
    renderStep({ desktopAppRunning: true });

    expect(screen.getByRole("button", { name: SWITCH_NAME })).not.toBeNull();
  });

  it("withholds the handoff when nothing is reporting online", () => {
    // The counterfactual half: a test that only proved the arm above would pass
    // against a step that offered the handoff to everyone.
    renderStep({ desktopAppRunning: false });

    expect(screen.queryByRole("button", { name: SWITCH_NAME })).toBeNull();
  });

  it("keeps the installer beside it, because online is not proof", () => {
    // The whole contract of this arm. An online heartbeat cannot say this is
    // the same machine, and cannot say the build ever registered
    // `closedloop://` -- navigating an unregistered scheme is a SILENT no-op.
    // Replacing the installer turned either false positive into a locked modal
    // with nothing that works.
    renderStep({ desktopAppRunning: true });

    expect(screen.getByRole("button", { name: SWITCH_NAME })).not.toBeNull();
    expect(screen.getByRole("link", { name: INSTALL_NAME })).not.toBeNull();
  });

  it("keeps a forward control on the arm that has no installer either", () => {
    // The platform with no published artifact is the arm with the least left to
    // press, so it is the one worth pinning: the handoff is added to it, never
    // substituted for its way out.
    renderStepOnPlatform(DesktopOs.Windows, {
      desktopAppRunning: true,
      skipEligibility: OnboardingDesktopSkipEligibility.Required,
    });

    expect(screen.getByRole("button", { name: SWITCH_NAME })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: CONTINUE_WITHOUT_INSTALLING })
    ).not.toBeNull();
  });

  it("fires the shared deep-link URL and advances the run", () => {
    // Both halves in one case: the handoff itself, and the forward move that
    // stops the browser showing this same screen again on return.
    const { onContinue } = renderStep({ desktopAppRunning: true });

    fireEvent.click(screen.getByRole("button", { name: SWITCH_NAME }));

    expect(globalThis.location.href).toBe(DESKTOP_DEEP_LINK_URL);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("GuidedOnboardingDownloadStep platform override and gap follow-up (ISS-12364)", () => {
  it("shows the override's platform over its own read", () => {
    // `renderStep` makes the step's own read answer macOS.
    renderStep({
      installerGapFollowUp: (os) => <p>{`follow-up:${os}`}</p>,
      platformOverride: DesktopOs.Windows,
    });

    expect(
      screen.getByText(describeDesktopInstallerGap(DesktopOs.Windows).headline)
    ).toBeTruthy();
    expect(screen.getByText(`follow-up:${DesktopOs.Windows}`)).toBeTruthy();
    expect(screen.queryByRole("link", { name: INSTALL_NAME })).toBeNull();
  });

  it("keeps its own read when the host supplies none", () => {
    renderStep({
      installerGapFollowUp: (os) => <p>{`follow-up:${os}`}</p>,
    });

    expect(screen.getByRole("link", { name: INSTALL_NAME })).toBeTruthy();
    expect(screen.queryByText(FOLLOW_UP_TEXT)).toBeNull();
  });

  /**
   * marisolashgrove, review of #8983: with `detectedOs?: DetectedPlatform | null`
   * a host passing `null` for "read it yourself" froze the step on its
   * not-read-yet arm. The override is a concrete platform only, so `null` is a
   * type error — and, smuggled past the type, it still reads the step's own.
   */
  it("never lets null stand for a platform: the step reads its own", () => {
    renderStep({
      installerGapFollowUp: (os) => <p>{`follow-up:${os}`}</p>,
      // @ts-expect-error -- `null` is not a platform override.
      platformOverride: null,
    });

    expect(screen.getByRole("link", { name: INSTALL_NAME })).toBeTruthy();
    expect(screen.queryByText(FOLLOW_UP_TEXT)).toBeNull();
  });

  it("threads both through the phase selector", () => {
    const installerGapFollowUp = () => null;
    const props = selectDownloadStepProps({
      annotations: {},
      brand: null,
      desktopAppDownloaded: false,
      desktopSkipEligibility: OnboardingDesktopSkipEligibility.Unknown,
      downloadHrefs: DOWNLOAD_HREFS,
      installerGapFollowUp,
      onComplete: vi.fn(),
      platformOverride: DesktopOs.Windows,
    } as unknown as Parameters<typeof selectDownloadStepProps>[0]);

    expect(props.platformOverride).toBe(DesktopOs.Windows);
    expect(props.installerGapFollowUp).toBe(installerGapFollowUp);
  });
});
