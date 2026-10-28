import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingStep } from "@repo/api/src/types/onboarding";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { GuidedOnboardingDialog } from "@repo/app/onboarding/components/guided-onboarding-dialog";
import type {
  GuidedOnboardingDialogProps,
  WizardPhase,
} from "@repo/app/onboarding/components/guided-onboarding-types";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_ANALYSIS_PROGRESS,
  FIXTURE_DOWNLOAD_HREFS,
  FIXTURE_GITHUB_DISCONNECTED,
  FIXTURE_JOINABLE_ORGANIZATION,
  FIXTURE_ORGANIZATION_MEMBERS,
  FIXTURE_ORGANIZATION_NAME,
  FIXTURE_ORGANIZATION_SLUG,
  FIXTURE_SESSION_DISCOVERY,
} from "@repo/app/onboarding/lib/guided-onboarding-fixtures";
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import Image from "next/image";
import { type ReactNode, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { CreateProjectStep } from "@/app/(onboarding)/onboarding/components/create-project-step";
import { OnboardingWizard } from "@/app/(onboarding)/onboarding/components/onboarding-wizard";
import { WizardShell } from "@/app/(onboarding)/onboarding/components/wizard-shell";
import { clearWizardState } from "@/app/(onboarding)/onboarding/lib/onboarding-constants";

/**
 * The first-run wizard every signed-in user with no team yet lands on
 * (ISS-5490): `apps/app/app/(onboarding)/onboarding/page.tsx`, which renders
 * `OnboardingWizard` once `useOnboardingStatus` positively says setup is
 * unfinished. Create Team then Create Project — the only two steps left in
 * the sequence, because a team and a project are the only things structural
 * enough to gate entry on; everything the older nine-step wizard also asked
 * for now lives as a row in the "Complete Your Setup" checklist instead.
 *
 * THE PAGE CHROME is `apps/app/app/(onboarding)/layout.tsx`: an `async`
 * server component that calls `auth()` from `@repo/auth/server` and redirects
 * a signed-out visitor before rendering anything. That import chain cannot
 * resolve in Storybook — the exact reason the unauthenticated `/sign-in`
 * layout is hand-reproduced in `login.stories.tsx` rather than mounted — so
 * `OnboardingPageChrome` below reproduces its JSX byte-for-byte instead:
 * the same logo pair pinned top-left, the same `ModeToggle` pinned top-right,
 * the same centered, scrollable column. `page.tsx`'s own redirect/loading/
 * recoverable-card branches around the wizard are the auth guard's job, not
 * this surface's; every story here renders the one branch that matters to a
 * design review, the wizard itself.
 *
 * THE WIZARD IS REAL AND UNMODIFIED. `OnboardingWizard`
 * (`components/onboarding-wizard.tsx`), `WizardShell`, `CreateTeamStep` and
 * `CreateProjectStep` were each read before writing this file: none of them
 * import Clerk or call `useOrgSlug()`, unlike the authenticated Documents and
 * Projects surfaces this repo already hand-composes. `CreateTeamStep` calls
 * the real `useCreateTeam` mutation, `CreateProjectStep` calls the real
 * `useCreateProject` mutation, and both resolve through the same
 * `appCore.apiRoutes` fixture-fetch transport every other mutation-driving
 * story in this repo uses — no network dependency, real code paths.
 *
 * WHY TWO WAYS OF MOUNTING WORK ARE COMPOSED IN ONE `mode` PROP, not two
 * component types: `OnboardingWizard` tracks its current step in
 * `sessionStorage` (`lib/onboarding-constants.ts`'s `loadWizardState` /
 * `saveWizardState`) plus its own `useState`, with no `initialStep` prop or
 * any other supported way to mount it already on Create Project — confirmed
 * by reading the whole file, not assumed. Seeding sessionStorage out-of-band
 * before mount is the alternative and it was rejected: it is real browser
 * state that outlives one story's render, so a later story (or the sweep's
 * shared jsdom window, `story-sweep.test.tsx`) would inherit whatever a
 * previous one left behind. So `mode: "wizard"` mounts `OnboardingWizard`
 * completely untouched, always starting clean (the decorator below clears
 * `sessionStorage` before every render), and its Create Project step is
 * reached the same way a person reaches it: by finishing Create Team through
 * real interaction (see `TeamCreated`, which submits for real and lands there
 * — `handleTeamCreated` advances `currentStep` in the same update that
 * records the team, so there is no separate "team created" screen on the way
 * forward; that screen only exists as the Back-navigation revisit of an
 * already-completed Create Team, which the same story also drives to).
 * `mode: "project-step"` / `"project-created"` instead compose `WizardShell` +
 * `CreateProjectStep` directly — both real, unmodified components, fed the
 * exact prop shape `OnboardingWizard` itself passes them — to show that step
 * at rest without a play function's timing between the surface and any
 * snapshot tool.
 *
 * NO VALIDATION-ERROR STATE: neither step renders one. Both forms disable
 * their submit button on an empty name (`disabled={!name.trim() || …}`)
 * rather than showing inline error text, and neither reads its mutation's
 * `isError` — confirmed reading both files, not assumed. A submission that
 * fails at the network layer would rely on the shared query client's default
 * mutation `onError` (`toastMutationError`, `packages/app/shared/query/query-client.ts`),
 * but that default lives on `makeQueryClient`, the production client; this
 * repo's Storybook harness (`AppCoreStoryProviders`) constructs a plain
 * `QueryClient` with no such handler. So there is no on-screen difference a
 * failed submission would produce here beyond the spinner simply stopping —
 * not a state worth a story.
 *
 * The identity threaded through every fixture below (`org_test` / `user_test`)
 * is the Storybook harness's own static auth snapshot
 * (`createStaticAuthAdapter`'s default), so `organizationId` / `createdById`
 * agree with what the real `useCreateTeam` / `useCreateProject` calls actually
 * authenticate as here.
 *
 * THE `guided-*` MODES (below) are a second, separate onboarding surface
 * promoted into this same file rather than a new title: the blocking
 * `GuidedOnboardingDialog` (`packages/app/onboarding/components/
 * guided-onboarding-dialog.tsx`) a signed-in user with an existing team can
 * still be dropped into — GitHub connection, session analysis, sync consent,
 * team invites — mounted the same way production's `WebGuidedOnboardingDialogHost`
 * does, minus that wrapper itself: `WebGuidedOnboardingDialogHost`
 * (`apps/app/app/(authenticated)/components/guided-onboarding-dialog-host.tsx`)
 * calls `useClerk` / `useOrganization` / `useOrganizationList` / `useUser`
 * directly, a real, confirmed-by-reading Clerk wall this Storybook cannot
 * cross — but `GuidedOnboardingDialog` itself, and every phase component the
 * five stories below reach, import none of that (grepped, not assumed), so
 * they mount for real. This is the SAME pattern `guided-onboarding-dialog
 * .stories.tsx`'s own 31-story Composite already uses (a stateful host
 * driving the dialog's real `onContinue*` callbacks, fed the same
 * `FIXTURE_*` data that module exports) — duplicated below rather than
 * imported only because that Composite's host is a private, unexported
 * function of that file. These five are a representative slice, not a
 * recatalog: see that Composite title for the other 26 states this same
 * dialog can be in.
 */

const TEAM_NAME = "Design Systems";
const TEAM_SLUG = "design-systems";
const PROJECT_NAME = "Storybook Migration";
const PROJECT_DESCRIPTION =
  "Move every legacy screen onto the real component catalog.";
const PROJECT_SLUG = "storybook-migration";

function fixtureTeam(overrides: Partial<TeamWithCounts> = {}): TeamWithCounts {
  return {
    id: "team_design_systems",
    organizationId: "org_test",
    name: TEAM_NAME,
    slug: TEAM_SLUG,
    memberCount: 1,
    projectCount: 0,
    createdAt: new Date("2026-09-15T16:00:00.000Z"),
    updatedAt: new Date("2026-09-15T16:00:00.000Z"),
    ...overrides,
  };
}

function fixtureProject(
  overrides: Partial<ProjectWithDetails> = {}
): ProjectWithDetails {
  const team = fixtureTeam();
  return {
    id: "proj_storybook_migration",
    organizationId: "org_test",
    name: PROJECT_NAME,
    description: PROJECT_DESCRIPTION,
    priority: null,
    status: ProjectStatus.NotStarted,
    assigneeId: null,
    createdById: "user_test",
    slug: PROJECT_SLUG,
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: null,
    createdAt: new Date("2026-09-15T16:05:00.000Z"),
    updatedAt: new Date("2026-09-15T16:05:00.000Z"),
    completionPercentage: 0,
    completionPopulationEmpty: true,
    teams: [{ id: team.id, name: team.name }],
    ...overrides,
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** A mutation that never resolves, for the in-flight submitting story. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** `POST /teams` that hangs forever, so the submitting state stays put. */
const CREATE_TEAM_PENDING_ROUTE: FixtureRoute = {
  method: "POST",
  path: "/teams",
  respond: neverSettles,
};

/** `POST /teams` that echoes the submitted name back as a real team. */
const CREATE_TEAM_ROUTE: FixtureRoute = {
  method: "POST",
  path: "/teams",
  respond: ({ body }: FixtureRequestContext) => {
    const input = (body ?? {}) as { name?: string };
    const name = input.name?.trim() || TEAM_NAME;
    return fixtureTeam({ name, slug: slugify(name) });
  },
};

/** `POST /projects` that echoes the submitted name/description back as a real project. */
const CREATE_PROJECT_ROUTE: FixtureRoute = {
  method: "POST",
  path: "/projects",
  respond: ({ body }: FixtureRequestContext) => {
    const input = (body ?? {}) as {
      name?: string;
      description?: string;
      teamIds?: string[];
    };
    const name = input.name?.trim() || PROJECT_NAME;
    return fixtureProject({
      name,
      slug: slugify(name),
      description: input.description ?? PROJECT_DESCRIPTION,
      teams: (input.teamIds ?? [fixtureTeam().id]).map((id) => ({
        id,
        name: TEAM_NAME,
      })),
    });
  },
};

/**
 * `apps/app/app/(onboarding)/layout.tsx` reproduced by hand — see the module
 * doc comment above for why it cannot be mounted directly. Logo asset paths
 * and dimensions copied from that file; `/app-public` is this Storybook's
 * mount of `apps/app/public` (see `staticDirs` in `.storybook/main.ts`, and
 * `login.stories.tsx`'s own comment on the same mount).
 */
function OnboardingPageChrome({ children }: { children: ReactNode }) {
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

type OnboardingSurfaceMode =
  | "wizard"
  | "project-step"
  | "project-created"
  | "guided-welcome"
  | "guided-connect-github"
  | "guided-session-discovery"
  | "guided-sync-policy"
  | "guided-invite-team";

type OnboardingSurfaceProps = {
  /**
   * Which real tree this surface mounts. `"wizard"` is `OnboardingWizard`
   * completely untouched, always starting on Create Team — drive it forward
   * through real interaction (see the `Submitting` / `TeamCreated` stories'
   * `play` functions) rather than trying to start it elsewhere; it has no such
   * prop. `"project-step"` and `"project-created"` instead compose the real
   * `WizardShell` + `CreateProjectStep` directly, fed the same props
   * `OnboardingWizard` passes them, to show Create Project at rest. The five
   * `"guided-*"` modes instead mount the real, separate `GuidedOnboardingDialog`
   * — see the module doc comment above for why it is a second surface living
   * in this same file rather than the Create Team/Create Project wizard.
   */
  mode?: OnboardingSurfaceMode;
};

const GUIDED_ONBOARDING_BRAND = (
  <span className="font-semibold">Closedloop.ai</span>
);

type GuidedOnboardingMode = Extract<OnboardingSurfaceMode, `guided-${string}`>;

/**
 * The one thing that varies per guided-dialog story: which phase it opens on,
 * plus the one or two args that phase's screen needs beyond the shared
 * fixture defaults every `GuidedOnboardingDialogHost` render already carries
 * (see that component below — the same base args
 * `guided-onboarding-dialog.stories.tsx`'s own `meta.args` uses).
 */
const GUIDED_ONBOARDING_MODE_CONFIG: Record<
  GuidedOnboardingMode,
  {
    initialPhase: WizardPhase;
    progress?: GuidedOnboardingDialogProps["progress"];
    syncLevel?: GuidedOnboardingDialogProps["syncLevel"];
  }
> = {
  "guided-connect-github": { initialPhase: OnboardingPhase.ConnectGitHub },
  "guided-invite-team": { initialPhase: OnboardingPhase.InviteTeam },
  "guided-session-discovery": {
    initialPhase: OnboardingPhase.SessionDiscovery,
    progress: FIXTURE_ANALYSIS_PROGRESS,
  },
  "guided-sync-policy": {
    initialPhase: OnboardingPhase.SyncPolicy,
    syncLevel: DataSyncLevel.Full,
  },
  "guided-welcome": { initialPhase: OnboardingPhase.Welcome },
};

function isGuidedOnboardingMode(
  mode: OnboardingSurfaceMode
): mode is GuidedOnboardingMode {
  return mode in GUIDED_ONBOARDING_MODE_CONFIG;
}

/**
 * Drives the real `GuidedOnboardingDialog` through real phase transitions —
 * the same `onContinue*` callbacks production wires, not a static prop
 * snapshot — starting on `initialPhase`. This is a duplicate, not an import,
 * of the equivalent (unexported) host `guided-onboarding-dialog.stories.tsx`
 * already built and proved across 31 stories; see the module doc comment
 * above for why it can't be shared directly. The fixture VALUES are the same
 * import, not recreated.
 */
function GuidedOnboardingDialogHost({
  initialPhase,
  progress,
  syncLevel,
}: {
  initialPhase: WizardPhase;
  progress?: GuidedOnboardingDialogProps["progress"];
  syncLevel?: GuidedOnboardingDialogProps["syncLevel"];
}) {
  const [phase, setPhase] = useState<WizardPhase>(initialPhase);
  const [history, setHistory] = useState<readonly WizardPhase[]>([]);
  const [finished, setFinished] = useState(false);

  const goTo = (next: WizardPhase) => {
    setHistory((current) => [...current, phase]);
    setPhase(next);
  };

  // Mirrors the Composite host: the flow ends at `dashboard_available`, which
  // the wizard renders no screen for, so finishing CLOSES the dialog rather
  // than parking it on some other phase's screen (ISS-8345).
  const finish = () => setFinished(true);

  return (
    <GuidedOnboardingDialog
      account={FIXTURE_ACCOUNT}
      brand={GUIDED_ONBOARDING_BRAND}
      discovery={FIXTURE_SESSION_DISCOVERY}
      downloadHrefs={FIXTURE_DOWNLOAD_HREFS}
      githubConnection={FIXTURE_GITHUB_DISCONNECTED}
      joinableOrganization={FIXTURE_JOINABLE_ORGANIZATION}
      members={FIXTURE_ORGANIZATION_MEMBERS}
      onBack={() => {
        const previous = history.at(-1);
        if (!previous) {
          return;
        }
        setHistory((current) => current.slice(0, -1));
        setPhase(previous);
      }}
      onComplete={finish}
      onContinue={() => goTo(OnboardingPhase.Account)}
      onContinueFromDownload={() => goTo(OnboardingPhase.InviteTeam)}
      onContinueFromGitHub={finish}
      onContinueFromInvites={() => goTo(OnboardingPhase.ConnectGitHub)}
      onContinueFromOrganization={() => goTo(OnboardingPhase.SyncPolicy)}
      onContinueFromSync={() => goTo(OnboardingPhase.DownloadDesktop)}
      onCreateOrganization={() => goTo(OnboardingPhase.SyncPolicy)}
      onStart={() => goTo(OnboardingPhase.Account)}
      onStartCreateOrganization={() => goTo(OnboardingPhase.CreateOrganization)}
      open={!finished}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      organizationSlug={FIXTURE_ORGANIZATION_SLUG}
      phase={phase}
      progress={progress}
      syncLevel={syncLevel}
    />
  );
}

function OnboardingSurface({ mode = "wizard" }: OnboardingSurfaceProps) {
  if (isGuidedOnboardingMode(mode)) {
    const config = GUIDED_ONBOARDING_MODE_CONFIG[mode];
    return (
      <GuidedOnboardingDialogHost
        initialPhase={config.initialPhase}
        key={remountKey(mode)}
        progress={config.progress}
        syncLevel={config.syncLevel}
      />
    );
  }

  if (mode === "wizard") {
    return (
      <OnboardingPageChrome>
        <OnboardingWizard />
      </OnboardingPageChrome>
    );
  }

  const team = fixtureTeam();
  const project = fixtureProject();
  const projectCreated = mode === "project-created";

  return (
    <OnboardingPageChrome>
      <WizardShell currentStep={OnboardingStep.CreateProject} onBack={fn()}>
        <CreateProjectStep
          completing={false}
          createdProjectId={projectCreated ? project.id : null}
          createdProjectName={projectCreated ? project.name : null}
          onNext={fn()}
          teamId={team.id}
        />
      </WizardShell>
    </OnboardingPageChrome>
  );
}

/**
 * The wizard a signed-in user with no team yet is dropped into first — Create
 * Team, then Create Project, and nothing else gates entry to the product
 * (ISS-5490).
 */
const meta = {
  title: "Surfaces v1.0/Onboarding",
  component: OnboardingSurface,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    mode: {
      options: [
        "wizard",
        "project-step",
        "project-created",
        "guided-welcome",
        "guided-connect-github",
        "guided-session-discovery",
        "guided-sync-policy",
        "guided-invite-team",
      ],
      control: { type: "radio" },
      description:
        "wizard: the real OnboardingWizard, always starting on Create Team. project-step / project-created: the real Create Project step composed directly, since the wizard has no way to start there on its own. guided-*: the real, separate GuidedOnboardingDialog, opened directly on the named phase.",
      table: { category: "Composition" },
    },
  },
  args: {
    mode: "wizard",
  },
  decorators: [
    (Story) => {
      // Every story here mounts fresh. OnboardingWizard's own initial state
      // comes from `loadWizardState()` (sessionStorage), which a prior story's
      // `play` run (Submitting / TeamCreated below) — or, under the sweep test,
      // a prior TEST FILE's run sharing one jsdom window — can leave populated.
      // Clearing it before every render is what keeps `Default` reliably on
      // Create Team regardless of run order.
      clearWizardState();
      return <Story />;
    },
  ],
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components into far less width than they ever get
    // in the product. `inline: false` renders the Docs preview in its own
    // full-width iframe instead, the documented Storybook fix for exactly
    // this mismatch.
    docs: { story: { inline: false, iframeHeight: 900 } },
  },
} satisfies Meta<typeof OnboardingSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Create Team, as a new user first lands on it: empty, nothing submitted yet. */
export const Default: Story = {};

/** Team creation in flight: the real `useCreateTeam` mutation pending against a route that never resolves, `CreateTeamStep`'s own spinner-and-disable state. */
export const Submitting: Story = {
  name: "Creating team",
  parameters: {
    appCore: {
      apiRoutes: [CREATE_TEAM_PENDING_ROUTE] satisfies FixtureRoute[],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Team name"), TEAM_NAME);

    const submitButton = canvas.getByRole("button", { name: "Create Team" });
    await userEvent.click(submitButton);

    await waitFor(() => expect(submitButton).toBeDisabled());
    await expect(
      canvasElement.querySelector(".animate-spin")
    ).toBeInTheDocument();
  },
};

/**
 * Submitting Create Team for real advances the wizard straight to Create
 * Project — `handleTeamCreated` records the new team id/name AND moves
 * `currentStep` on in the same state update, so there is no intermediate
 * "team created" screen on the way forward (confirmed by reading
 * `onboarding-wizard.tsx`, not assumed). Going Back from there re-visits
 * Create Team with the team already recorded, which is the ONE way
 * `CreateTeamStep`'s own "already completed" success panel is reachable — so
 * this story proves the real forward transition into Create Project, then the
 * real Back navigation that reveals that panel, rather than a prop faking
 * either outcome.
 */
export const TeamCreated: Story = {
  name: "Team created",
  parameters: {
    appCore: {
      apiRoutes: [CREATE_TEAM_ROUTE] satisfies FixtureRoute[],
    },
    // The Docs page mounts every story in this file as its own same-origin
    // iframe on ONE parent document, and sessionStorage (what
    // loadWizardState/saveWizardState/clearWizardState persist to) is shared
    // across same-origin iframes in one top-level browsing context — so
    // another story's meta-level "clearWizardState() on render" decorator can
    // wipe the team this play function just created out from under it,
    // mid-interaction. That race is a Docs-page-only artifact: the portable-
    // stories suite (one canvas per test, no siblings) and an isolated Story
    // view both pass clean — confirmed via `npx vitest run
    // __tests__/story-sweep.test.tsx -t "onboarding"` and via the standalone
    // Story URL. `docs.story.autoplay: false` (tried first) did not actually
    // suppress the play run here, so this story is excluded from the Docs
    // page's own embedded canvas list instead — it stays a fully real,
    // fully tested story, just not one Docs auto-mounts alongside its
    // storage-sharing siblings.
    docs: { disable: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Team name"), TEAM_NAME);
    await userEvent.click(canvas.getByRole("button", { name: "Create Team" }));

    // Real transition: the wizard lands on Create Project directly.
    await expect(
      await canvas.findByRole("heading", { name: "Create your first project" })
    ).toBeVisible();

    // Back re-visits Create Team, which now shows its completed state.
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(await canvas.findByText("Team created")).toBeVisible();
    await expect(canvas.getByText(TEAM_NAME)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Continue" })
    ).toBeVisible();
  },
};

/**
 * Create Project, reached after Create Team: empty, nothing submitted yet.
 * Composed directly (see the module doc comment) rather than driven through
 * the wizard, with a real `POST /projects` route wired in case a reviewer
 * actually submits the form from the canvas.
 */
export const ProjectStep: Story = {
  name: "Create project",
  args: { mode: "project-step" },
  parameters: {
    appCore: {
      apiRoutes: [CREATE_PROJECT_ROUTE] satisfies FixtureRoute[],
    },
  },
};

/** A project just created: `CreateProjectStep`'s own success panel, the last screen before the wizard hands off. */
export const ProjectCreated: Story = {
  name: "Project created",
  args: { mode: "project-created" },
};

/**
 * The guided onboarding dialog's entry screen — the blocking modal a
 * signed-in user without a finished setup is dropped into (see the module
 * doc comment above for why this is a second, separate surface from the
 * wizard above it). One of five representative states; the other 26 this
 * same dialog can reach live on `Composites/Onboarding/Guided Onboarding
 * Dialog`.
 */
export const GuidedOnboardingWelcome: Story = {
  name: "Guided onboarding: welcome",
  args: { mode: "guided-welcome" },
};

/**
 * The canonical GitHub connect step: no Skip control, the production
 * default — a host has to opt in to offer one (ISS-8352).
 */
export const GuidedOnboardingConnectGitHub: Story = {
  name: "Guided onboarding: connect GitHub",
  args: { mode: "guided-connect-github" },
};

/**
 * A completed session scan: real counts, a real size, and a real time
 * estimate from the fixture, not a placeholder.
 */
export const GuidedOnboardingSessionScan: Story = {
  name: "Guided onboarding: session scan",
  args: { mode: "guided-session-discovery" },
};

/** The sync-level choice, at the dialog's own default (Full). */
export const GuidedOnboardingSyncChoice: Story = {
  name: "Guided onboarding: sync choice",
  args: { mode: "guided-sync-policy" },
};

/** Inviting teammates, seeded with the fixture organization's existing roster. */
export const GuidedOnboardingInviteTeam: Story = {
  name: "Guided onboarding: invite team",
  args: { mode: "guided-invite-team" },
};
