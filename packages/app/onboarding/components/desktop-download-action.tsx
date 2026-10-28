"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  AppleIcon,
  MonitorDownIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  DESKTOP_OS_VALUES,
  type DesktopDownloadHrefs,
  DesktopOs,
  type DetectedPlatform,
  describeDesktopInstallerGap,
  isDesktopOs,
} from "../lib/desktop-platform-availability";

/**
 * @file The platform-aware desktop-download action, shared by every surface that
 * offers the install (ISS-11261).
 *
 * EXTRACTED from `guided-onboarding-download-step.tsx`, which owned it and was
 * its only caller until the web dashboard's zero-session empty state needed the
 * same offer. It is a MOVE, not a re-authoring: every arm, every string and the
 * order they are resolved in are the wizard's, because the copy is
 * human-approved for exactly this job and the arms encode a ruling (Perrin,
 * ISS-9651 review 2026-09-07) that a hand-written second version would lose.
 *
 * WHAT MADE IT MOVABLE. The wizard's two forward moves — `Continue without
 * installing` and the post-install `Continue` — are the only parts of it that
 * were ever wizard-shaped, so they are now the caller's
 * {@link DesktopDownloadActionProps.noInstallerAction} and
 * {@link DesktopDownloadActionProps.postInstallAction}. Both are REQUIRED rather
 * than optional, and that is the whole load-bearing part of this contract:
 * whichever arm renders, exactly one always carries a forward control, so an arm
 * that withholds the installer is never a dead end. An optional slot would let a
 * host silently ship the dead end this component exists to prevent — a Windows
 * or Linux reader with no published artifact and nothing to press.
 *
 * REQUIRING THE SLOT WAS NOT THE SAME AS THREADING IT (ISS-11261 review, whitlockk).
 * The first shape of this extraction required `noInstallerAction` and then did
 * not pass it to {@link UnrecognizedPlatformDownload}, so a host handing a
 * perfectly valid all-`null` {@link DesktopDownloadHrefs} got exactly the dead
 * end the requirement exists to forbid. Every arm that withholds an installer
 * now renders it, and `desktop-download-action.test.tsx` asserts one forward
 * control on all eight of them.
 */

export type DesktopDownloadActionProps = {
  /**
   * What `useDetectedDesktopOs` answered. `null` is "nobody has looked yet",
   * which is NOT {@link DetectedPlatform.Unrecognized} — read by the host so a
   * surface mounting this twice cannot run two detections that disagree.
   */
  readonly detectedOs: DetectedPlatform | null;
  /**
   * Installer URL per platform, owned by the host. This component must not carry
   * a release URL of its own: the canonical macOS asset lives on the PUBLIC
   * mirror (`DESKTOP_LATEST_DMG_URL` / `getPublicDesktopReleaseDownloadUrl` in
   * `packages/api/src/types/`), and the same path on the private
   * `closedloop-ai` repo 404s for a new user.
   */
  readonly downloadHrefs: DesktopDownloadHrefs;
  /** Whether this reader has already taken an installer for their platform. */
  readonly downloaded: boolean;
  /**
   * Optional content for the installer-gap arm only, rendered between the gap
   * alert and {@link noInstallerAction}: the ISS-12364 "notify me when it is
   * available" email capture. It is handed the platform the gap is for so the
   * host can word it for that platform.
   *
   * Deliberately NOT rendered for an unrecognized agent: that reader is offered
   * every published installer, and a per-platform waitlist would assert a
   * platform nobody measured. Omitted, every arm renders exactly as before.
   */
  readonly installerGapFollowUp?: (os: DesktopOs) => ReactNode;
  /**
   * The forward control the arms that offer NO installer render — the platform
   * nobody has read yet, and the platform known to have no published artifact.
   * Required: see the file docstring.
   */
  readonly noInstallerAction: ReactNode;
  readonly onDownload: () => void;
  /**
   * What replaces the install anchor once {@link downloaded} is set. Required for
   * the same reason as {@link noInstallerAction}.
   */
  readonly postInstallAction: ReactNode;
};

/**
 * The download action, once the platform is known.
 *
 * Every arm waits for the detection to answer, because there is no honest action
 * for a platform nobody has measured yet: every option this can render either
 * names a platform or links to that platform's artifact.
 *
 * Gating the WHOLE surface on detection was the first shape of this in the wizard
 * and it was wrong: that modal is locked and its Back button is optional, so a
 * Required or Unknown skip arm rendered nothing at all — a momentary dead end,
 * which is why the pre-detection arm below withholds the installer rather than
 * the whole action.
 */
export function DesktopDownloadAction({
  detectedOs,
  downloadHrefs,
  downloaded,
  installerGapFollowUp,
  noInstallerAction,
  onDownload,
  postInstallAction,
}: DesktopDownloadActionProps) {
  if (detectedOs === null) {
    // Withhold the INSTALLER, not the way out. Every action naming a platform or
    // linking to its artifact has to wait for the read.
    return <>{noInstallerAction}</>;
  }

  if (!isDesktopOs(detectedOs)) {
    return (
      <UnrecognizedPlatformDownload
        downloaded={downloaded}
        downloadHrefs={downloadHrefs}
        noInstallerAction={noInstallerAction}
        onDownload={onDownload}
        postInstallAction={postInstallAction}
      />
    );
  }

  // Href presence leads, `downloaded` does not. The earlier order let a Windows
  // visitor carrying `downloaded` fall through to `DESKTOP_DOWNLOADS`, which
  // prints "Windows · x64 installer" -- a second, contradicting answer to the
  // production host's null href, and exactly the claim PRD-685 FR11 is about. The
  // shape it was protecting cannot arise either: `downloaded` means this user
  // took an installer for THIS platform, and without a href there was never an
  // artifact to take.
  const downloadHref = downloadHrefs[detectedOs];
  if (downloadHref === null) {
    return (
      <DesktopInstallerGap
        followUp={installerGapFollowUp?.(detectedOs)}
        noInstallerAction={noInstallerAction}
        os={detectedOs}
      />
    );
  }

  return (
    <DesktopDownloadControls
      detectedOs={detectedOs}
      downloaded={downloaded}
      downloadHref={downloadHref}
      onDownload={onDownload}
      postInstallAction={postInstallAction}
    />
  );
}

const DESKTOP_DOWNLOADS = {
  [DesktopOs.Mac]: {
    buttonLabel: "Download Mac Desktop App",
    detail: "macOS · Universal installer",
    icon: AppleIcon,
  },
  [DesktopOs.Windows]: {
    buttonLabel: "Download Windows Desktop App",
    detail: "Windows · x64 installer",
    icon: MonitorDownIcon,
  },
  [DesktopOs.Linux]: {
    buttonLabel: "Download Linux Desktop App",
    detail: "Linux · AppImage",
    icon: TerminalIcon,
  },
} satisfies Record<
  DesktopOs,
  {
    buttonLabel: string;
    detail: string;
    icon: typeof AppleIcon;
  }
>;

/**
 * Every platform at once, for an agent that named no desktop OS.
 *
 * Perrin's call on the ISS-9651 review (2026-09-07), taken over both of the
 * options on the thread: do not guess the platform, and do not withhold the
 * download either. Each entry names its own platform exactly as the
 * single-platform arm does, so an unreadable agent misroutes nobody and a Mac
 * behind one keeps the installer it can actually run.
 *
 * The set is read out of {@link DESKTOP_OS_VALUES} rather than listed here, so a
 * platform joins this arm on the same flip that publishes its artifact. An
 * unpublished platform states its gap rather than being silently absent --
 * absence reads as "not a thing we support", which is a different and wrong
 * claim.
 *
 * IT TAKES `noInstallerAction` FOR THE SAME REASON {@link DesktopInstallerGap}
 * does, and this arm is where the file docstring's promise was actually broken
 * (ISS-11261 review, whitlockk). {@link DesktopDownloadHrefs} permits every entry to
 * be `null`, so an all-null map -- the shape this repo is one unpublished-macOS
 * incident away from, and the shape a second host may legitimately pass -- left
 * an unrecognized visitor holding three gap sentences and nothing to press. The
 * gap paragraphs are a statement, not a way out.
 *
 * Rendered ONCE and only when no platform resolves, rather than per gap row: a
 * reader whose agent names no desktop OS is offered every artifact that exists,
 * and the fallback exists for the case where none does. Emitting it beside a
 * published installer would put two forward moves on one card.
 */
function UnrecognizedPlatformDownload({
  downloadHrefs,
  downloaded,
  noInstallerAction,
  onDownload,
  postInstallAction,
}: {
  readonly downloadHrefs: DesktopDownloadHrefs;
  readonly downloaded: boolean;
  readonly noInstallerAction: ReactNode;
  readonly onDownload: () => void;
  readonly postInstallAction: ReactNode;
}) {
  // Post-install carries no platform claim beyond the detail line, and there is
  // no platform to name. Re-offering three installers to someone already running
  // Desktop would be noise, not honesty.
  if (downloaded) {
    return <>{postInstallAction}</>;
  }

  const anyInstallerPublished = DESKTOP_OS_VALUES.some(
    (os) => downloadHrefs[os] !== null
  );

  return (
    <>
      {DESKTOP_OS_VALUES.map((os) => {
        const downloadHref = downloadHrefs[os];
        return (
          <div className="mb-3" key={os}>
            {downloadHref === null ? (
              <p className="text-muted-foreground text-xs">
                {describeDesktopInstallerGap(os).headline}
              </p>
            ) : (
              <DesktopDownloadControls
                detectedOs={os}
                downloaded={false}
                downloadHref={downloadHref}
                onDownload={onDownload}
                postInstallAction={postInstallAction}
              />
            )}
          </div>
        );
      })}
      {anyInstallerPublished ? null : noInstallerAction}
    </>
  );
}

/** The install anchor and its post-install replacement, for a named platform. */
function DesktopDownloadControls({
  detectedOs,
  downloadHref,
  downloaded,
  onDownload,
  postInstallAction,
}: {
  readonly detectedOs: DesktopOs;
  readonly downloadHref: string;
  readonly downloaded: boolean;
  readonly onDownload: () => void;
  readonly postInstallAction: ReactNode;
}) {
  const download = DESKTOP_DOWNLOADS[detectedOs];
  const DownloadIcon = download.icon;

  return (
    <>
      <p className="mb-3 text-muted-foreground text-xs">{download.detail}</p>
      {downloaded ? (
        postInstallAction
      ) : (
        <Button asChild className="w-full" size="lg">
          {/* External asset, so a raw anchor is correct here — the in-app Link
              rule governs internal routes. */}
          <a
            href={downloadHref}
            onClick={onDownload}
            rel="noreferrer"
            target="_blank"
          >
            <DownloadIcon />
            {download.buttonLabel}
          </a>
        </Button>
      )}
    </>
  );
}

/**
 * What shows instead of a download control when the detected platform has no
 * published installer.
 *
 * Two sentences, not one: the headline names the state and the platform, the
 * detail says what does exist. Neither is a failure nor an empty result, so the
 * copy carries the state in words rather than in color, shaped on the sibling
 * `DesktopUndetectedNotice`: catalog `Alert` with a leading icon.
 *
 * IT MUST CARRY A FORWARD CONTROL, which is why `noInstallerAction` is required
 * rather than optional. The anchor this arm replaces was not only a download: in
 * the wizard its `onClick` advanced the run, so dropping it with nothing in its
 * place left a locked modal with no interactive element at all. The same hole
 * exists on any host — a reader whose platform has no artifact must still have
 * somewhere to go. The missing installer artifacts are escalated on ISS-8350.
 */
function DesktopInstallerGap({
  followUp,
  noInstallerAction,
  os,
}: {
  readonly followUp?: ReactNode;
  readonly noInstallerAction: ReactNode;
  readonly os: DesktopOs;
}) {
  const gap = describeDesktopInstallerGap(os);

  return (
    <>
      <Alert className="mb-3 text-left">
        <MonitorIcon />
        <AlertTitle>{gap.headline}</AlertTitle>
        <AlertDescription>{gap.detail}</AlertDescription>
      </Alert>
      {followUp}
      {noInstallerAction}
    </>
  );
}
