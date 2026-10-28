"use client";

import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { Button } from "@repo/design-system/components/ui/button";
import { CheckIcon, MonitorIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useDetectedDesktopOs } from "../hooks/use-detected-desktop-os";
import {
  DESKTOP_DOWNLOAD_DESCRIPTION,
  DESKTOP_DOWNLOAD_EYEBROW,
  DESKTOP_DOWNLOAD_TITLE,
} from "../lib/desktop-download-copy";
import type {
  DesktopDownloadHrefs,
  DesktopOs,
} from "../lib/desktop-platform-availability";
import { DesktopDownloadAction } from "./desktop-download-action";
import { OnboardingDesktopSkipEligibility } from "./guided-onboarding-data";
import {
  GuidedOnboardingBackButton,
  GuidedOnboardingStepLayout,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";

/**
 * HOST CONTRACT — the exits on this screen.
 *
 * The wizard is a locked modal: escape, outside click and pointer-down are all
 * prevented and there is no close button, so the controls this step renders are
 * the only way out of it. The install action is present in every eligibility
 * arm, and it is the only control the denied arms have — `Skip for now` is
 * withheld unless the snapshot reports the reader as an `ExistingMember`
 * (ISS-12482).
 *
 * That matters because the install link is not guaranteed to resolve: Windows
 * has no published installer today. The platform decision, and the
 * installer-gap arm it selects for a platform with no published artifact, moved
 * to {@link DesktopDownloadAction} in ISS-11261 so the dashboard's empty state
 * could make the same offer. **Whichever arm renders, exactly one always carries
 * a forward control**, and this step's two — `Continue without installing` and
 * the post-install `Continue` — are what it hands that component as its REQUIRED
 * `noInstallerAction` and `postInstallAction` slots. Requiring them is what keeps
 * the denied deferral arms out of a dead end, and it is load-bearing rather than
 * incidental: `onBack` is optional, so a host that omits it leaves the step's own
 * controls as the only way on.
 *
 * What is NOT enforced, deliberately, is that `onBack` itself be present.
 * Encoding that as a discriminated requirement was tried and rejected: the only
 * caller is {@link GuidedOnboardingDialog}, whose own `onBack` is optional, so
 * the requirement is flattened at that boundary and the type could only be
 * satisfied by passing a no-op — a Back button that renders and does nothing,
 * which is a worse failure than the one it papers over. The missing installer
 * artifacts are escalated on ISS-8350; ISS-8353 owns the mount that first makes
 * this reachable by a real user.
 */
type GuidedOnboardingDownloadStepProps = {
  annotation?: ReactNode;
  brand: ReactNode;
  /**
   * Installer URL per platform, owned by the host. This component must not
   * carry a release URL of its own: the canonical macOS asset lives on the PUBLIC
   * mirror (`getPublicDesktopReleaseDownloadUrl` /
   * `packages/api/src/types/desktop-release.ts`), and the same path on the
   * private `closedloop-ai` repo 404s for a new user. Unlike this step, the
   * setup checklist's row carries no per-platform asset at all — ISS-9708 gave it
   * the channel's release page, because that row is built where the reader's
   * platform is not knowable and this one is not.
   */
  downloadHrefs: DesktopDownloadHrefs;
  downloaded: boolean;
  /**
   * Whether an owned compute target is reporting online, which is the ONLY
   * desktop-presence signal a browser has. It is deliberately NOT treated as
   * proof: it cannot tell this machine from another of the reader's machines,
   * and a build predating ISS-6109 heartbeats without ever having registered
   * `closedloop://` (see `packages/api/src/types/desktop-deep-link.ts`). So the
   * handoff it unlocks is ADDITIVE — every install and forward control this
   * step already rendered stays rendered beneath it.
   */
  desktopAppRunning: boolean;
  /** See `GuidedOnboardingDialogProps.platformOverride` (ISS-12364). */
  platformOverride?: DesktopOs;
  /** See `DesktopDownloadActionProps.installerGapFollowUp` (ISS-12364). */
  installerGapFollowUp?: (os: DesktopOs) => ReactNode;
  onBack?: () => void;
  onContinue: () => void;
  onContinueWithoutInstalling?: () => void;
  onDownload: () => void;
  onSkip: () => void;
  skipEligibility: OnboardingDesktopSkipEligibility;
};

export function GuidedOnboardingDownloadStep({
  annotation,
  brand,
  desktopAppRunning,
  downloadHrefs,
  downloaded,
  installerGapFollowUp,
  onBack,
  onContinue,
  onContinueWithoutInstalling = onContinue,
  onDownload,
  onSkip,
  platformOverride,
  skipEligibility,
}: GuidedOnboardingDownloadStepProps) {
  const ownDetectedOs = useDetectedDesktopOs();
  // `??`, not `=== undefined`: an override is only ever a concrete platform,
  // so anything else (a `null` smuggled past the type) reads the step's own.
  const detectedOs = platformOverride ?? ownDetectedOs;

  return (
    <GuidedOnboardingStepLayout
      annotation={annotation}
      body={
        <div className="mx-auto mt-10 w-full max-w-sm text-center">
          {desktopAppRunning ? (
            <GuidedOnboardingSwitchToDesktopButton onContinue={onContinue} />
          ) : null}
          <DesktopDownloadAction
            detectedOs={detectedOs}
            downloaded={downloaded}
            downloadHrefs={downloadHrefs}
            installerGapFollowUp={installerGapFollowUp}
            noInstallerAction={
              <GuidedOnboardingContinueWithoutInstalling
                onContinue={onContinueWithoutInstalling}
              />
            }
            onDownload={onDownload}
            postInstallAction={
              <GuidedOnboardingContinueButton onContinue={onContinue} />
            }
          />
          {downloaded ? null : (
            <GuidedOnboardingDownloadSkipSlot
              onSkip={onSkip}
              skipEligibility={skipEligibility}
            />
          )}
        </div>
      }
      brand={brand}
      description={DESKTOP_DOWNLOAD_DESCRIPTION}
      eyebrow={DESKTOP_DOWNLOAD_EYEBROW}
      footer={<GuidedOnboardingBackButton onBack={onBack} />}
      title={DESKTOP_DOWNLOAD_TITLE}
    />
  );
}

/** The post-install move, shared so the two arms that offer it cannot drift. */
function GuidedOnboardingContinueButton({
  onContinue,
}: {
  readonly onContinue: () => void;
}) {
  return (
    <Button className="w-full" onClick={onContinue} size="lg" type="button">
      <CheckIcon />
      Continue
    </Button>
  );
}

/**
 * The one control slot below the install action, resolved exhaustively so a
 * fourth {@link OnboardingDesktopSkipEligibility} member fails `tsc` here rather
 * than falling silently into the deny branch.
 *
 * Rendered only while the app is not yet downloaded — once it is, the step's
 * action is Continue and neither the deferral nor the reason for withholding it
 * is still true.
 */
function GuidedOnboardingDownloadSkipSlot({
  onSkip,
  skipEligibility,
}: {
  onSkip: () => void;
  skipEligibility: OnboardingDesktopSkipEligibility;
}) {
  switch (skipEligibility) {
    case OnboardingDesktopSkipEligibility.Eligible:
      return (
        <div className="mt-3 flex justify-center">
          <Button
            className="h-auto px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
            onClick={onSkip}
            size="sm"
            type="button"
            variant="ghost"
          >
            Skip for now
          </Button>
        </div>
      );
    case OnboardingDesktopSkipEligibility.Unknown:
      // No spinner and no icon. This arm is reached only from a `membership`
      // that is absent or spelled by another build, so anything that reads as
      // work-in-progress would assert a check that is not running, and an alert
      // glyph would report an error the user neither caused nor can fix. The
      // sentence states what the screen offers, which is true in every case
      // that lands here.
      return (
        <p className="mt-3 text-muted-foreground text-xs" role="status">
          {DOWNLOAD_SKIP_UNAVAILABLE_LINE}
        </p>
      );
    case OnboardingDesktopSkipEligibility.Required:
      // The snapshot named this reader the organization's first user.
      // Deliberately silent — the canonical design withholds the control
      // without explaining it, and saying "unavailable" here would blur a
      // stated refusal into the unstated one above.
      return null;
    default: {
      // The assignment is the guarantee: a fourth member fails `tsc` here. The
      // return is deliberately NOT `_exhaustive` — this slot renders into the
      // modal, so a member that reached it at runtime past a skipped typecheck
      // would paint its raw enum string on screen. Withholding is the safe arm.
      const _exhaustive: never = skipEligibility;
      return null;
    }
  }
}

/**
 * This phase carries the deepest callback fallback chains in the wizard — three
 * of its four actions stand in for one another before reaching `onComplete`.
 * Holding them here rather than in the shell is what kept the old dispatch at a
 * measured cognitive complexity of 21 against a ceiling of 20 (ISS-8345).
 */
export function selectDownloadStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingDownloadStep> {
  const onContinue = source.onContinueFromDownload ?? source.onComplete;
  return {
    annotation: source.annotations[OnboardingPhase.DownloadDesktop],
    brand: source.brand,
    desktopAppRunning: source.desktopAppRunning ?? false,
    downloadHrefs: source.downloadHrefs,
    downloaded: source.desktopAppDownloaded,
    installerGapFollowUp: source.installerGapFollowUp,
    onBack: source.onBack,
    onContinue,
    onContinueWithoutInstalling:
      source.onContinueWithoutInstalling ?? onContinue,
    onDownload: source.onDownloadApp ?? onContinue,
    onSkip: source.onSkipDownload ?? onContinue,
    platformOverride: source.platformOverride,
    skipEligibility: source.desktopSkipEligibility,
  };
}

/**
 * The way out when no installer is being offered, shared by the arm that knows
 * the platform has none and the arm that does not know the platform yet.
 */
function GuidedOnboardingContinueWithoutInstalling({
  onContinue,
}: {
  readonly onContinue: () => void;
}) {
  return (
    <Button
      className="w-full"
      data-analytics-download-clicked="false"
      data-analytics-label="continue_without_installing"
      data-analytics-label-source={JSON.stringify([
        "continue_without_installing",
      ])}
      onClick={onContinue}
      size="lg"
      type="button"
      variant="outline"
    >
      Continue without installing
    </Button>
  );
}

/**
 * The handoff to a Desktop that is already installed and reporting online.
 *
 * ADDITIVE, never a replacement, and that is the whole contract (ISS-11330
 * review, whitlockk and the Codex reviewer). Navigating to an unregistered custom
 * scheme is a SILENT no-op in every browser — no error, no event — and the
 * online heartbeat that puts this button on screen cannot rule that out: the
 * target may be a pre-ISS-6109 build that never registered the scheme, or a
 * different machine of the same reader's entirely. Rendering it in place of the
 * installer therefore turned a false positive into a locked modal with nothing
 * that works, so it renders ABOVE the install action and leaves every arm of it,
 * and the skip slot, exactly where they were.
 *
 * It advances the run as well as firing the handoff, because it is the same
 * forward move the install anchor's `onClick` is: the reader demonstrably has
 * Desktop, so leaving the web run parked on this phase only meant the browser
 * showed this screen again on return.
 */
function GuidedOnboardingSwitchToDesktopButton({
  onContinue,
}: {
  readonly onContinue: () => void;
}) {
  return (
    <Button
      className="mb-3 w-full"
      onClick={() => {
        globalThis.location.href = DESKTOP_DEEP_LINK_URL;
        onContinue();
      }}
      size="lg"
      type="button"
    >
      <MonitorIcon />
      Switch to Desktop
    </Button>
  );
}

/**
 * The Unknown skip arm's sentence. Exported because `e2e/helpers/
 * guided-onboarding-step-copy.ts` locates this arm by its words, and a mirrored
 * literal there is only ever NEGATED by the browser specs — so a rewording here
 * would leave every one of those assertions passing (tamsinb, PR #8814).
 */
export const DOWNLOAD_SKIP_UNAVAILABLE_LINE =
  "Skipping this step isn't available yet.";
