"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { GuidedOnboardingDialog } from "@repo/app/onboarding/components/guided-onboarding-dialog"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { GuidedOnboardingDialogProps } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { GuidedSyncLevel } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { createOrganizationReadyEvent } from "@repo/app/onboarding/lib/guided-onboarding-events"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
// The wizard takes every measured value as a prop and invents none, so this
// prototype supplies them from the shared fixture register (ISS-8678). That
// register — not this file — is the list of what still needs real data.
import {
  FIXTURE_ACCOUNT,
  FIXTURE_GITHUB_DISCONNECTED,
  FIXTURE_JOINABLE_ORGANIZATION,
  FIXTURE_ORGANIZATION_MEMBERS,
  FIXTURE_SESSION_DISCOVERY,
} from "@repo/app/onboarding/lib/guided-onboarding-fixtures"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { type ReactNode, useEffect, useState } from "react";
import { desktopInstallerHrefs } from "../mock";
import { useWebMasterHostImage } from "./web-master-host-image";

export const SyncPolicy = {
  Full: GuidedSyncLevel.Full,
  Insights: GuidedSyncLevel.Metadata,
  Local: GuidedSyncLevel.Off,
} as const;

export type SyncPolicy = (typeof SyncPolicy)[keyof typeof SyncPolicy];

type GuidedFtueModalProps = Omit<
  GuidedOnboardingDialogProps,
  | "downloadHrefs"
  | "annotations"
  | "brand"
  | "existingOrganizationLogo"
  | "newOrganizationLogo"
  | "onSyncLevelChange"
  | "syncLevel"
> & {
  downloadHrefs?: GuidedOnboardingDialogProps["downloadHrefs"];
  onSyncPolicyChange?: (policy: SyncPolicy) => void;
  syncPolicy?: SyncPolicy | null;
};

export function GuidedFtueModal({
  account = FIXTURE_ACCOUNT,
  desktopMode = true,
  discovery = FIXTURE_SESSION_DISCOVERY,
  downloadHrefs = desktopInstallerHrefs,
  githubConnection = FIXTURE_GITHUB_DISCONNECTED,
  joinableOrganization = FIXTURE_JOINABLE_ORGANIZATION,
  members = FIXTURE_ORGANIZATION_MEMBERS,
  onContinueFromOrganization,
  onJoinOrganization,
  onSyncPolicyChange,
  phase,
  syncPolicy = SyncPolicy.Full,
  ...props
}: GuidedFtueModalProps) {
  // A sandbox has no provider to call, and the shipped step offers Join ONLY
  // where a join can actually be performed — so a prototype supplying no handler
  // would render a card the product never shows. This stands in for the
  // provider in the same order the host uses: the join resolves first, and only
  // then does the run advance.
  async function mockJoin() {
    await Promise.resolve();
    onContinueFromOrganization?.(createOrganizationReadyEvent());
  }

  const annotations = {
    [OnboardingPhase.Welcome]: (
      <PrototypeMarginAnnotation>
        {desktopMode
          ? "Desktop says ‘Start Analyzing My Sessions’ because local analysis begins next. Web says ‘Get Started’ because account and organization setup come first."
          : "Web says ‘Get Started’ because account and organization setup come first. Desktop says ‘Start Analyzing My Sessions’ because local analysis begins next."}
      </PrototypeMarginAnnotation>
    ),
    [OnboardingPhase.CreateOrganization]: (
      <PrototypeMarginAnnotation>
        Use the user's email domain only to propose the new organization name
        and slug. Existing organizations come from Clerk membership or
        invitation authority.
      </PrototypeMarginAnnotation>
    ),
    [OnboardingPhase.SyncPolicy]: (
      <PrototypeMarginAnnotation>
        {desktopMode
          ? "Desktop pre-selects the recommended level and records the choice on Continue, as it does today."
          : "Web, first user in the organization: the modal stays open until Desktop is downloaded AND a sync policy is chosen. Nothing is pre-selected, so Continue waits for an explicit choice; Off, Metadata only and Full transcripts each complete the step. If the reader chooses in Desktop instead, the web run picks up the recorded choice and closes the modal without this picker being touched (developer menu: Simulate sync choice in Desktop). Later teammates are never held here; they see the same two rows in the Getting started card, sync directly after download."}
      </PrototypeMarginAnnotation>
    ),
    [OnboardingPhase.DownloadDesktop]: (
      <PrototypeMarginAnnotation>
        ISS-12364, when this variant appears: the reader's platform has no
        published installer (today only Windows; Linux and macOS both publish
        one). Under the existing ‘Not available for Windows yet’ alert they can
        leave an email to hear when the Windows app ships, pre-filled with their
        signed-in address. An invalid address is flagged before anything is
        sent; while the request runs the button is busy; on success the form
        becomes a confirmation; on failure the address is kept and the button
        becomes the retry. ‘Continue without installing’ stays below in every
        state, so leaving an email is never required to go on. An agent that
        names no platform still sees every installer and no email capture.
        Developer menu: Platform.
      </PrototypeMarginAnnotation>
    ),
    [OnboardingPhase.InviteTeam]: (
      <PrototypeMarginAnnotation>
        On Web, Invite intentionally comes before Download for every user.
        Existing teammates provide social proof, while a first user can seed the
        team before installing the required desktop app.
      </PrototypeMarginAnnotation>
    ),
  };

  return (
    <GuidedOnboardingDialog
      {...props}
      account={account}
      annotations={annotations}
      brand={<BrandLogo />}
      desktopMode={desktopMode}
      discovery={discovery}
      downloadHrefs={downloadHrefs}
      existingOrganizationLogo={<ExistingOrganizationLogo />}
      githubConnection={githubConnection}
      joinableOrganization={joinableOrganization}
      members={members}
      newOrganizationLogo={<NewOrganizationLogo />}
      onContinueFromOrganization={onContinueFromOrganization}
      onJoinOrganization={onJoinOrganization ?? mockJoin}
      onSyncLevelChange={onSyncPolicyChange}
      phase={phase}
      syncLevel={syncPolicy}
    />
  );
}

function BrandLogo() {
  const Image = useWebMasterHostImage();
  return (
    <span className="block h-full w-fit">
      <Image
        alt="Closedloop.ai"
        className="h-full w-auto dark:hidden"
        height={200}
        priority
        src="/web-master/closedloop-logo-on-light.svg"
        unoptimized
        width={1324}
      />
      <Image
        alt="Closedloop.ai"
        className="hidden h-full w-auto dark:block"
        height={200}
        priority
        src="/web-master/closedloop-logo-on-dark.svg"
        unoptimized
        width={1324}
      />
    </span>
  );
}

function ExistingOrganizationLogo() {
  const Image = useWebMasterHostImage();
  return (
    <span className="block size-10 overflow-hidden rounded-lg">
      <Image
        alt=""
        className="size-full dark:hidden"
        height={40}
        src="/web-master/closedloop-icon-on-light.svg"
        width={40}
      />
      <Image
        alt=""
        className="hidden size-full dark:block"
        height={40}
        src="/web-master/closedloop-icon-on-dark.svg"
        width={40}
      />
    </span>
  );
}

function NewOrganizationLogo() {
  const Image = useWebMasterHostImage();
  return (
    <Image
      alt="AcmeCo logo"
      className="size-14 object-contain"
      height={56}
      src="/web-master/acmeco-logo-mark.png"
      width={56}
    />
  );
}

function PrototypeMarginAnnotation({ children }: { children: ReactNode }) {
  const visible = usePrototypeAnnotationsVisible();
  if (!visible) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none mt-4 hidden w-full max-w-2xl min-[1240px]:block"
      data-prototype-annotation="margin-callout"
    >
      <span className="block border-violet-500 border-l-2 bg-violet-600 px-4 py-3 text-white shadow-lg shadow-violet-950/20">
        <span className="block font-semibold text-violet-100 text-xs uppercase tracking-wider">
          DESIGN NOTE
        </span>
        <span className="mt-1.5 block text-sm leading-5">{children}</span>
      </span>
    </span>
  );
}

function usePrototypeAnnotationsVisible() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const syncVisibility = () => {
      setVisible(
        globalThis.document.documentElement.dataset.prototypeAnnotations !==
          "hide"
      );
    };
    syncVisibility();
    globalThis.window.addEventListener(
      "prototype-annotations-change",
      syncVisibility
    );
    return () =>
      globalThis.window.removeEventListener(
        "prototype-annotations-change",
        syncVisibility
      );
  }, []);

  return visible;
}
