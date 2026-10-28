import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import Image from "next/image";
import { type ReactNode, useEffect, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import DashboardPage from "@/app/(authenticated)/[orgSlug]/dashboard/page";
import { WebGuidedOnboardingDialogHost } from "@/app/(authenticated)/components/guided-onboarding-dialog-host";
import {
  clearWizardState,
  saveWizardState,
} from "@/app/(onboarding)/onboarding/lib/onboarding-constants";
import OnboardingPage from "@/app/(onboarding)/onboarding/page";
import { dashboardApiRoutes } from "./fixtures/dashboard-fixtures";
import { guidedTourSnapshotFixture } from "./fixtures/live-app-fixtures";
import {
  createProjectWizardSeed,
  type OnboardingWizardSeed,
  onboardingApiRoutes,
  onboardingTeamFixture,
  projectCreatedWizardSeed,
  teamCreatedWizardSeed,
} from "./fixtures/onboarding-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar, entry 57 of 62: Onboarding (Sign-in & connect flow).
// Two live surfaces share this page.
//
// The wizard: the live `/onboarding` route's own page
// (`apps/app/app/(onboarding)/onboarding/page.tsx`), which reads the user's
// onboarding status and runs `OnboardingWizard` (Create Team, then Create
// Project). Its layout, `(onboarding)/layout.tsx`, is an async server
// component that calls `auth()` from the server-only `@repo/auth/server`, so
// it cannot mount here; `OnboardingLayout` below is its signed-in markup,
// copied verbatim with the brand images on this Storybook's `/app-public`
// mount. The wizard persists its step to sessionStorage, which is how a story
// opens it part-way through (a reload does the same).
//
// The guided onboarding dialog: production hosts it in the AUTHENTICATED
// shell (`WebGuidedOnboardingDialogHost`, mounted by the Global Sidebar), over
// whatever page the user is on, driven by the guided onboarding snapshot. The
// Guided stories render it over the live Dashboard in the app frame, with the
// snapshot at each phase. Session discovery and the sync choice are
// desktop-only phases (`isPhaseReachableOnHost`): the web host restores them
// to Welcome, so they have no story here.

const WIZARD_ROUTES: FixtureRoute[] = [
  ...onboardingApiRoutes,
  ...dashboardApiRoutes,
];

/** `(onboarding)/layout.tsx`'s signed-in markup (see the header comment). */
function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-dvh flex-col items-center overflow-y-auto bg-background px-4 pt-24 pb-8">
      <div className="absolute top-4 left-6">
        <Image
          alt="Closedloop logo"
          className="dark:hidden"
          height={30}
          src="/app-public/logo.svg"
          width={200}
        />
        <Image
          alt="Closedloop logo"
          className="hidden dark:block"
          height={30}
          src="/app-public/logo-dark.svg"
          width={200}
        />
      </div>
      <div className="absolute top-4 right-6">
        <ModeToggle />
      </div>
      {children}
    </div>
  );
}

/**
 * Opens the wizard at `seed` (or fresh), and clears the persisted wizard
 * state on unmount so no story inherits another's progress.
 */
function WizardStateScope({
  seed,
  children,
}: {
  seed?: OnboardingWizardSeed;
  children: ReactNode;
}) {
  useState(() => {
    clearWizardState();
    if (seed) {
      saveWizardState(seed);
    }
    return null;
  });
  useEffect(() => clearWizardState, []);
  return <>{children}</>;
}

function withWizardState(seed?: OnboardingWizardSeed): Decorator {
  return (Story) => (
    <WizardStateScope seed={seed}>
      <Story />
    </WizardStateScope>
  );
}

const meta = {
  title: "Surfaces/Onboarding",
  tags: ["stable"],
  decorators: [withWizardState()],
  render: () => (
    <OnboardingLayout>
      <OnboardingPage />
    </OnboardingLayout>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: WIZARD_ROUTES },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** Create Team, as a new user first lands on it. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 2 })
    ).toBeVisible();
    await expect(canvas.getByRole("textbox")).toBeInTheDocument();
  },
};

/** The team is being created: `POST /teams` has not answered. */
export const CreatingTeam: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "POST",
          path: "/teams",
          respond: () =>
            new Promise<never>(() => {
              // Never settles: the request is in flight.
            }),
        },
        ...WIZARD_ROUTES,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByRole("textbox"),
      onboardingTeamFixture.name
    );
    const form = canvasElement.querySelector("form");
    const submit = form?.querySelector('button[type="submit"]');
    if (submit instanceof HTMLButtonElement) {
      await userEvent.click(submit);
      await waitFor(() => expect(submit).toBeDisabled());
    }
  },
};

/** Back on Create Team after the team was created. */
export const TeamCreated: Story = {
  decorators: [withWizardState(teamCreatedWizardSeed)],
};

/** Create Project, with the team created. */
export const CreateProject: Story = {
  decorators: [withWizardState(createProjectWizardSeed)],
};

/** The project was created: the last screen before the wizard finishes. */
export const ProjectCreated: Story = {
  decorators: [withWizardState(projectCreatedWizardSeed)],
};

/** The onboarding status read failed. */
export const StatusUnavailable: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: "/onboarding",
          respond: () => null,
          status: 500,
        },
        ...WIZARD_ROUTES,
      ],
    },
  },
};

type GuidedContext = Partial<GuidedOnboardingSnapshot["context"]>;

/**
 * The guided onboarding dialog at `phase`, over the live Dashboard, with the
 * run's context adjusted by `context` and any extra reads in `routes`.
 */
function guidedOnboarding(
  phase: OnboardingPhase,
  context: GuidedContext = {},
  routes: FixtureRoute[] = []
): Story {
  const snapshot = guidedTourSnapshotFixture(phase);
  return {
    render: () => (
      <LivePage activePath="/dashboard">
        <WebGuidedOnboardingDialogHost />
        <DashboardPage />
      </LivePage>
    ),
    parameters: {
      appCore: {
        apiRoutes: [
          ...routes,
          {
            method: "GET",
            path: "/onboarding/guided/snapshot",
            respond: () => ({
              ...snapshot,
              context: { ...snapshot.context, ...context },
            }),
          },
          ...dashboardApiRoutes,
        ],
      },
    },
  };
}

/** The dialog's first screen. */
export const GuidedWelcome: Story = guidedOnboarding(OnboardingPhase.Welcome);

/** Connect GitHub, before the organization has connected it. */
export const GuidedConnectGitHub: Story = {
  ...guidedOnboarding(
    OnboardingPhase.ConnectGitHub,
    { githubConnected: false },
    [
      {
        method: "GET",
        path: "/integrations/github",
        respond: () => ({ connected: false }),
      },
    ]
  ),
  name: "Guided Connect GitHub",
};

/** Invite the team, before anyone has been invited. */
export const GuidedInviteTeam: Story = guidedOnboarding(
  OnboardingPhase.InviteTeam,
  { teamInvited: false }
);
