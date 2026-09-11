import { useEffect } from "react";
import { PackagedUpdateInstallBlockedReason } from "../../shared/packaged-update-install-blocked-reason";
import { UpdateBanner } from "./UpdateBanner";
import type { UpdateBannerState } from "./update-banner-state";

// ISS-4841: the auto-update strip, one story per state.
// The banner holds its own state and only ever moves through IPC-bridged window
// events, so at runtime you see whichever state your machine happens to be in.
// The read-only-volume block in particular needs an app running from a mounted
// DMG, which nobody reproduces on purpose. Each story dispatches the
// `desktop:update-status` event the preload bridge re-emits, so the canvas
// drives the real reducer rather than a parallel mock of it.
/**
 * A thin strip reporting app update status, offering a Relaunch button when
 * ready or a Move and Update button if stuck in a read only location.
 */
const meta = {
  title: "Composites/App Shell/Update Banner",
  component: UpdateBanner,
  tags: ["autodocs"],
  // `UpdateBanner` takes no props: it holds its own state and only ever moves
  // through the `desktop:update-status` window event each story dispatches, so
  // there is nothing here a control could drive.
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/** Nothing to install. The strip stays out of the chrome entirely. */
export const Hidden = {
  render: () =>
    renderScenario({
      caption: "Idle - no banner.",
      status: {
        status: "idle",
        updateAvailable: false,
        readyToInstall: false,
      },
    }),
};

/** An update exists and is downloading in the background. Informational only. */
export const Available = {
  render: () =>
    renderScenario({
      caption: "Available - informational strip, no action yet.",
      status: {
        status: "available",
        updateAvailable: true,
        readyToInstall: false,
        version: "1.42.0",
      },
    }),
};

/** Mid-download, with the percentage the user is waiting on. */
export const Downloading = {
  render: () =>
    renderScenario({
      caption: "Downloading - progress is in the message, not a spinner.",
      status: {
        status: "downloading",
        updateAvailable: true,
        readyToInstall: false,
        version: "1.42.0",
        percent: 63,
      },
    }),
};

/**
 * Downloaded and ready. ISS-5367: the strip carries the same tint as its
 * siblings and a real Relaunch button on a centered line, rather than being one
 * full-bleed saturated slab that is itself the click target.
 */
export const ReadyToInstall = {
  render: () =>
    renderScenario({
      caption: "Downloaded - a status line with a Relaunch button.",
      status: {
        status: "downloaded",
        updateAvailable: true,
        readyToInstall: true,
        version: "1.42.0",
      },
    }),
};

/** The update failed. Destructive wash, and it retries on its own. */
export const UpdateFailed = {
  render: () =>
    renderScenario({
      caption: "Error - destructive wash, retries automatically.",
      status: {
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
        error: "net::ERR_CONNECTION_RESET",
      },
    }),
};

/**
 * The hard one to reach: the app is running from a read-only volume, so the
 * installer cannot write itself. Warning wash, and the action moves the bundle
 * instead of relaunching, because a relaunch from the same volume fails again.
 */
export const InstallBlockedReadOnlyVolume = {
  render: () =>
    renderScenario({
      caption: "Read-only volume - the strip offers Move & Update.",
      status: {
        status: "error",
        updateAvailable: true,
        readyToInstall: false,
        installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
      },
    }),
};

type UpdateBannerScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  /** The `desktop:update-status` payload the preload bridge re-emits. */
  status: UpdateBannerState;
};

/**
 * The banner adds its window listener in its own effect, and a child's effects
 * run before its parent's, so dispatching from this parent effect is what
 * guarantees the listener is already attached. A layout effect here would fire
 * too early and the event would land on nothing.
 */
function UpdateBannerScenarioView({ caption, status }: UpdateBannerScenario) {
  useEffect(() => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        applyUpdate: () => Promise.resolve(),
        moveToApplications: () => Promise.resolve(true),
      },
      writable: true,
    });
    window.dispatchEvent(
      new CustomEvent("desktop:update-status", { detail: status })
    );
  }, [status]);

  return (
    <div className="flex flex-col">
      <UpdateBanner />
      <p className="px-4 py-3 text-muted-foreground text-sm">{caption}</p>
    </div>
  );
}

function renderScenario(scenario: UpdateBannerScenario) {
  return <UpdateBannerScenarioView {...scenario} />;
}
