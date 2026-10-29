import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import {
  DEFAULT_DESKTOP_DOWNLOAD_HREFS,
  DesktopOs,
  DetectedPlatform,
} from "../lib/desktop-platform-availability";
import { DesktopDownloadAction } from "./desktop-download-action";

/**
 * ISS-11261: the promoted platform-aware download action, in every arm it has.
 *
 * WHY A STORY AND NOT JUST THE UNIT MATRIX. The tests beside this file pin the
 * strings, the hrefs and the one-forward-control invariant; none of them can see
 * that the gap `Alert` is a bordered box inside whatever bordered box a host
 * mounts it in, that the `w-full size="lg"` control is wizard-scale, or that the
 * unrecognized arm stacks three platform blocks and crowds at a narrow width.
 * Two hosts now render this — the guided-onboarding wizard step and the web
 * dashboard's zero-session card — and neither reaches every arm, so the matrix
 * is only visible here.
 *
 * Controls: `detectedOs`, `downloaded` and `downloadHrefs` are the three props
 * that change what it shows, and each has one. The two slot props are `ReactNode`
 * and are fixed to labelled stand-ins rather than controlled, so a screenshot
 * says WHICH forward move rendered instead of merely that something did.
 */
const meta: Meta<typeof DesktopDownloadAction> = {
  args: {
    downloadHrefs: DEFAULT_DESKTOP_DOWNLOAD_HREFS,
    noInstallerAction: (
      <Button className="w-full" size="lg" variant="outline">
        Download desktop app
      </Button>
    ),
    onDownload: () => {
      // Storybook keeps no install record; the anchor is here to be looked at.
    },
    postInstallAction: (
      <Button className="w-full" size="lg">
        Continue
      </Button>
    ),
  },
  argTypes: {
    detectedOs: {
      control: "select",
      description: "What the platform read answered. `null` is 'not yet read'.",
      options: [
        null,
        DesktopOs.Mac,
        DesktopOs.Windows,
        DesktopOs.Linux,
        DetectedPlatform.Unrecognized,
      ],
    },
    downloaded: {
      control: "boolean",
      description: "Whether this reader already took an installer.",
    },
    downloadHrefs: {
      control: "object",
      description:
        "Installer URL per platform, host-owned. Every entry may be null.",
    },
  },
  component: DesktopDownloadAction,
  // The dashboard's card clamps the composite to `max-w-sm`, which is the
  // narrower of the two hosts and therefore the one crowding shows up in first.
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm py-8">
        <Story />
      </div>
    ),
  ],
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Desktop Download Action",
};

export default meta;

type Story = StoryObj<typeof DesktopDownloadAction>;

/** Production today: a macOS reader, installer published. */
export const MacInstaller: Story = {
  args: { detectedOs: DesktopOs.Mac, downloaded: false },
};

/** The same reader once they have taken it — the anchor becomes the exit. */
export const MacInstalled: Story = {
  args: { detectedOs: DesktopOs.Mac, downloaded: true },
};

/**
 * The platform gap (PRD-685). The `Alert` states the gap in words rather than in
 * color, and the forward control below it is required — an arm that withholds
 * the installer must never withhold the way out too.
 */
export const WindowsInstallerGap: Story = {
  args: { detectedOs: DesktopOs.Windows, downloaded: false },
};

/** A Linux reader, AppImage published (ISS-12614). */
export const LinuxInstaller: Story = {
  args: { detectedOs: DesktopOs.Linux, downloaded: false },
};

/**
 * Perrin's ISS-9651 ruling: an agent naming no desktop OS is offered every
 * platform rather than a guess or nothing. This is the tallest arm and the one
 * that crowds first at `max-w-sm`.
 */
export const UnrecognizedPlatform: Story = {
  args: { detectedOs: DetectedPlatform.Unrecognized, downloaded: false },
};

/**
 * The arm the ISS-11261 review found empty (whitlockk). `DesktopDownloadHrefs`
 * permits every entry to be `null`, and an unrecognized reader holding that map
 * used to get three gap sentences and nothing to press. The exit now renders
 * once, below them.
 */
export const UnrecognizedWithNoInstallerAnywhere: Story = {
  args: {
    detectedOs: DetectedPlatform.Unrecognized,
    downloaded: false,
    downloadHrefs: {
      [DesktopOs.Linux]: null,
      [DesktopOs.Mac]: null,
      [DesktopOs.Windows]: null,
    },
  },
};

/**
 * Before the platform read answers. It withholds the INSTALLER, not the way out:
 * every control this can render either names a platform or links to that
 * platform's artifact, and neither is honest yet.
 */
export const BeforeDetectionAnswers: Story = {
  args: { detectedOs: null, downloaded: false },
};
