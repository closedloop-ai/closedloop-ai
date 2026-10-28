// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OnboardingDesktopSkipEligibility,
  UNKNOWN_ACCOUNT,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_GITHUB_CONNECTION,
  UNKNOWN_JOINABLE_ORGANIZATION,
  UNKNOWN_ORGANIZATION_MEMBERS,
  UNKNOWN_SESSION_DISCOVERY,
} from "../guided-onboarding-data";
import { GUIDED_ONBOARDING_PHASES } from "../guided-onboarding-phase-registry";
import type {
  GuidedOnboardingPhaseSource,
  WizardPhase,
} from "../guided-onboarding-types";

/**
 * The heading each phase puts in the accessibility tree, against the honest
 * defaults below. Distinct per phase on purpose: a mis-paired registry entry
 * renders SOME screen, so asserting "something mounted" would pass for the
 * wrong one.
 *
 * Exhaustive `Record<WizardPhase, string>`, which is also where this file pins
 * the ISS-8345 decision that `dashboard_available` has no wizard screen. Adding
 * it back to `WIZARD_RENDERS_PHASE` makes this record non-exhaustive and fails
 * `tsc` here — a compile-time stop, not a runtime one.
 */
const PHASE_HEADING = {
  [OnboardingPhase.Welcome]: "Discover how you (and your team) build with AI.",
  [OnboardingPhase.SessionDiscovery]: "No sessions reported yet.",
  [OnboardingPhase.Account]:
    "Learn what's working and share what you learn with your team.",
  [OnboardingPhase.CreateOrganization]: "You're the first one here!",
  [OnboardingPhase.ChooseOrganization]: "Choose an organization",
  [OnboardingPhase.SyncPolicy]: "Choose what to sync",
  [OnboardingPhase.DownloadDesktop]: "Bring Closedloop to your desktop",
  [OnboardingPhase.InviteTeam]: "Invite people you build with",
  [OnboardingPhase.ConnectGitHub]: "Checking your GitHub connection",
} as const satisfies Record<WizardPhase, string>;

const EVERY_WIZARD_PHASE = Object.keys(PHASE_HEADING) as readonly WizardPhase[];

describe("guided onboarding phase registry", () => {
  it.each(EVERY_WIZARD_PHASE)(
    "mounts %s from its registry entry alone, with no shell dispatch",
    (phase) => {
      render(
        <Dialog open>
          <DialogContent showCloseButton={false}>
            {GUIDED_ONBOARDING_PHASES[phase].render(PHASE_SOURCE)}
          </DialogContent>
        </Dialog>
      );

      const heading = screen.getByRole("heading", {
        name: PHASE_HEADING[phase],
      });
      expect(heading).not.toBeNull();
      // ISS-11315 INVERTED THIS, for a stated reason and not because a case was
      // inconvenient. It used to require `tabindex="-1"` on every phase heading,
      // because the shell landed focus here on a body change and a bare
      // `DialogTitle` would have made that a silent no-op (ISS-8345). The
      // operator reported the ring that focus painted for a mouse user and ruled
      // the heading must not take focus or show a border on any arrival, so the
      // shell no longer focuses it and `GuidedOnboardingPhaseHeading` no longer
      // makes it focusable.
      //
      // The assertion is kept, negated, over the same compile-time-exhaustive
      // source: a tenth phase — or a revert of the layout component — must not
      // quietly make a heading focusable again and bring the ring back. What
      // replaced the focus move is pinned in
      // `guided-onboarding-phase-focus.test.tsx`: the card takes focus, and a
      // polite live region carries the step announcement.
      expect(heading).not.toHaveAttribute("tabindex");
    }
  );
});

/**
 * What the shell hands a selector, with every measured value at its explicit
 * `unknown` variant — the state a host is in before its data resolves, and the
 * one a phase must render without inventing a number (ISS-8678).
 */
const PHASE_SOURCE: GuidedOnboardingPhaseSource = {
  account: UNKNOWN_ACCOUNT,
  accountCreated: false,
  accountMethod: null,
  accountPendingMethod: null,
  accountSignInError: null,
  allowSkipAccount: true,
  allowStagedOrganizationLogo: false,
  analysisStarted: false,
  annotations: {},
  brand: <span>Closedloop.ai</span>,
  desktopAppDownloaded: false,
  desktopMode: true,
  desktopSkipEligibility: OnboardingDesktopSkipEligibility.Unknown,
  discovery: UNKNOWN_SESSION_DISCOVERY,
  downloadHrefs: {
    linux: "https://downloads.test/Closedloop.AppImage",
    mac: "https://downloads.test/Closedloop-universal.dmg",
    windows: "https://downloads.test/Closedloop-Setup.exe",
  },
  githubConnectError: null,
  githubConnecting: false,
  githubConnection: UNKNOWN_GITHUB_CONNECTION,
  invitedEmails: [],
  joinableOrganization: UNKNOWN_JOINABLE_ORGANIZATION,
  members: UNKNOWN_ORGANIZATION_MEMBERS,
  onComplete: vi.fn(),
  onSyncLevelChange: vi.fn(),
  organizationChosen: false,
  organizationCreationError: null,
  organizationCreating: false,
  organizationJoinError: null,
  organizationJoining: false,
  organizationName: "",
  organizationRenameError: null,
  organizationRenaming: false,
  organizationSlug: "",
  privacyHref: "/legal/privacy",
  progress: UNKNOWN_ANALYSIS_PROGRESS,
  syncError: null,
  syncLevel: DataSyncLevel.Full,
  syncSaving: false,
  termsHref: "/legal/terms",
};
