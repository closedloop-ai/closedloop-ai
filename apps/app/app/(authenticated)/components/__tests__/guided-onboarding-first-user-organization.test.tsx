// @vitest-environment jsdom

/**
 * ISS-11090 (PRD-754 UAT). A signup started from Closedloop Desktop finishes in
 * the browser, where Clerk's own choose-organization session task creates the
 * organization before the guided takeover runs over the authorize route. The
 * takeover's organization step then offered CreateOrganization to that first
 * user, and the web host's create handler made a SECOND organization and
 * switched the session to it, so the run restarted at Welcome on the new one.
 *
 * Drives the REAL web host, shared host and transition hook over one
 * QueryClient. Stubbed: the transport (it echoes each accepted command the way
 * the transition service persists it), Clerk, navigation, and the leaf reads
 * the organization step does not route on.
 */

import type {
  GuidedOnboardingSnapshot,
  GuidedOnboardingTransitionRequest,
} from "@repo/api/src/types/onboarding-guided";
import { guidedOnboardingTransitionRequestSchema } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  /** `PUT /organizations/[id]` — the canonical rename route (ISS-11253). */
  apiPut: vi.fn(),
  /** Re-anchors the URL onto a changed slug; the shell's port, spied here. */
  resyncOrganizationIdentity: vi.fn(),
  createOrganization: vi.fn(),
  navigate: vi.fn(),
  organization: null as {
    id: string;
    name: string;
    update?: (params: { name: string; slug?: string }) => Promise<unknown>;
  } | null,
  /**
   * Every organization this session has. The create path appends; the rename
   * path must not, which is the ISS-11090 invariant ISS-11253 has to keep.
   */
  organizationIds: [] as string[],
  setActive: vi.fn(),
  updateOrganization: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: mocks.apiGet,
    post: mocks.apiPost,
    put: mocks.apiPut,
  }),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn(() => Promise.resolve()) }),
  useOrganization: () => ({ organization: mocks.organization }),
  useOrganizationList: () => ({
    createOrganization: mocks.createOrganization,
    setActive: mocks.setActive,
  }),
  useUser: () => ({
    user: {
      emailAddresses: [],
      primaryEmailAddress: { emailAddress: "ada@example.test" },
    },
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, replace: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => TAKEOVER_PATH,
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({ data: null }),
}));

vi.mock("@/hooks/use-github-authorize-href", () => ({
  useGitHubAuthorizeHref: () => "/github/connect",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useNavOrgSlug: () => "acme",
}));

vi.mock("@repo/app/onboarding/hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

vi.mock(
  "@repo/app/onboarding/hooks/use-onboarding-organization-members",
  () => ({
    useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
  })
);

vi.mock("@repo/app/shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    isWriting: false,
    state: { status: "loading" },
    supported: false,
    write: vi.fn(),
    writeOutcome: null,
  }),
}));

vi.mock("@repo/app/onboarding/hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => null,
}));

/**
 * An ordinary authenticated route. The ISS-11090 scenario starts from a Desktop
 * signup, but the step under test is reached wherever the takeover opens, and
 * since ISS-11912 that is never the desktop authorize route — the takeover is
 * suppressed there so the consent page can hand back to Desktop at once.
 */
const TAKEOVER_PATH = "/acme/sessions";
const SNAPSHOT_PATH_PREFIX = "/onboarding/guided/snapshot";
const TRANSITION_PATH = "/onboarding/guided/transition";
const ORGANIZATION_NAME_LABEL = "Name";
const CLERK_TASK_ORGANIZATION = {
  id: "org_from_clerk_task",
  name: "Acme",
} as const;
const CREATED_ORGANIZATION_ID = "org_created";
/** Closedloop's own organization row id, which `PUT /organizations/[id]` takes. */
const DATABASE_ORGANIZATION_ID = "org_db_acme";
const ME_PATH = "/me";
const ORGANIZATION_UPDATE_PATH = `/organizations/${DATABASE_ORGANIZATION_ID}`;
const GET_STARTED = /get started/i;
const CONTINUE = /^continue$/i;
const BACK = /^back$/i;
const CREATE_ORGANIZATION = /create organization/i;
const CHOOSE_HEADING = /choose an organization/i;
const CREATE_HEADING = /you're the first one here/i;
/** The URL the step states for the host's own slug, scheme included. */
const ORGANIZATION_URL = "https://app.closedloop.ai/acme";
/** The shared host's own wording for a failed organization save (ISS-11253). */
const ORGANIZATION_SAVE_FAILED =
  "We couldn't save your organization. Please try again.";

/**
 * The fake server's current snapshot, module-scoped so a case can restate the
 * membership it reports before the host reads it.
 */
let server: GuidedOnboardingSnapshot;

/** Report a different cohort than the first user every other case drives. */
function seedMembership(membership: OrganizationMembership) {
  server = {
    ...server,
    context: { ...server.context, membership },
  };
}

/** The server's first-run answer for a new account that has no run yet. */
function firstRunSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: null,
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: true,
      // The only member: a first user.
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: null,
    restoreOutcome: OnboardingRestoreOutcome.Absent,
    revision: 0,
    state: serializeOnboardingState(createInitialOnboardingState()),
  };
}

/** A run that reached CreateOrganization before the resolver stopped routing there. */
function parkOnCreateOrganization() {
  const parked: GuidedOnboardingSnapshot = {
    ...firstRunSnapshot(),
    attemptId: "attempt-1",
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 1,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      history: [OnboardingPhase.Welcome],
      phase: OnboardingPhase.CreateOrganization,
    }),
  };
  mocks.apiGet.mockImplementation((path: string) => {
    if (path.startsWith(SNAPSHOT_PATH_PREFIX)) {
      return Promise.resolve(parked);
    }
    if (path === ME_PATH) {
      return Promise.resolve({ organizationId: DATABASE_ORGANIZATION_ID });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

/**
 * Renders the real web host. The returned `rerender` re-renders it without
 * touching its state, which is how a case observes a Clerk read that lands after
 * the step is already on screen.
 */
function renderWebTakeover(orgId: string | null) {
  let bump: () => void = () => undefined;
  function Harness() {
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    return <WebGuidedOnboardingDialogHost />;
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <AuthAdapterProvider
          adapter={{
            ...createStaticAuthAdapter({
              isLoaded: true,
              orgId,
              userId: "user-a",
            }),
            // The shell port the rename re-anchors the URL through, spied so a
            // case can hold that it was actually reached with the new slug.
            useOrganizationIdentityResync: () =>
              mocks.resyncOrganizationIdentity,
          }}
        >
          <Harness />
        </AuthAdapterProvider>
      </FeatureFlagAdapterProvider>
    </QueryClientProvider>
  );
  return { rerender: () => act(() => bump()) };
}

/** The organization Clerk's signup task made, with a working rename. */
function clerkTaskOrganization() {
  return {
    ...CLERK_TASK_ORGANIZATION,
    update: mocks.updateOrganization,
  };
}

function postedCommands(): GuidedOnboardingTransitionRequest[] {
  return mocks.apiPost.mock.calls
    .filter(([path]) => path === TRANSITION_PATH)
    .map(([, body]) => guidedOnboardingTransitionRequestSchema.parse(body));
}

function postedPhases(): OnboardingPhase[] {
  return postedCommands().map(
    (command) =>
      restoreOnboardingState(command.state, OnboardingHost.Web).state.phase
  );
}

describe("guided organization step for a first user (ISS-11090)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organization = null;
    server = firstRunSnapshot();
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.startsWith(SNAPSHOT_PATH_PREFIX)) {
        return Promise.resolve(server);
      }
      if (path === ME_PATH) {
        return Promise.resolve({ organizationId: DATABASE_ORGANIZATION_ID });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    // The transition service persists the client's state verbatim and moves
    // the revision, which is all the organization step reads back.
    mocks.apiPost.mockImplementation((path: string, body: unknown) => {
      if (path !== TRANSITION_PATH) {
        return Promise.reject(new Error(`unexpected POST ${path}`));
      }
      const command = guidedOnboardingTransitionRequestSchema.parse(body);
      server = {
        ...server,
        attemptId: "attempt-1",
        experienceVariant: command.experienceVariant,
        restoreOutcome: OnboardingRestoreOutcome.Restored,
        revision: server.revision + 1,
        state: command.state,
      };
      return Promise.resolve(server);
    });
    mocks.organizationIds = [];
    mocks.createOrganization.mockImplementation(() => {
      mocks.organizationIds.push(CREATED_ORGANIZATION_ID);
      return Promise.resolve({ id: CREATED_ORGANIZATION_ID, setLogo: vi.fn() });
    });
    mocks.apiPut.mockImplementation(
      (_path: string, body: { name: string; slug: string }) => {
        if (mocks.organization) {
          mocks.organization = { ...mocks.organization, name: body.name };
        }
        return Promise.resolve({
          id: DATABASE_ORGANIZATION_ID,
          name: body.name,
          slug: body.slug,
        });
      }
    );
    mocks.resyncOrganizationIdentity.mockResolvedValue(undefined);
    mocks.updateOrganization.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);
  });

  it("chooses the organization Clerk's signup task made instead of creating a second", async () => {
    mocks.organization = { ...CLERK_TASK_ORGANIZATION };
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    await waitFor(() =>
      expect(postedPhases()).toEqual([OnboardingPhase.ChooseOrganization])
    );
    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    // ISS-11253 turned this row into the editable pair, so the organization is
    // still stated here — as the field's value rather than as static text. The
    // ISS-11090 contract this case owns is unchanged and asserted below: the run
    // chooses the organization Clerk's task made and creates no second one.
    await waitFor(() =>
      expect(
        within(chooseStep).getByLabelText(ORGANIZATION_NAME_LABEL)
      ).toHaveValue(CLERK_TASK_ORGANIZATION.name)
    );
    expect(screen.queryByText(CREATE_HEADING)).not.toBeInTheDocument();

    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    await waitFor(() =>
      expect(postedPhases()).toEqual([
        OnboardingPhase.ChooseOrganization,
        OnboardingPhase.InviteTeam,
      ])
    );
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.setActive).not.toHaveBeenCalled();
  });

  it("shows a run already parked on CreateOrganization the choose step", async () => {
    mocks.organization = { ...CLERK_TASK_ORGANIZATION };
    parkOnCreateOrganization();
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    await waitFor(() =>
      expect(postedPhases()).toEqual([OnboardingPhase.InviteTeam])
    );
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.setActive).not.toHaveBeenCalled();
  });

  it("still creates exactly one organization for a first user with none", async () => {
    renderWebTakeover(null);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    await waitFor(() =>
      expect(postedPhases()).toEqual([OnboardingPhase.CreateOrganization])
    );
    const createStep = await screen.findByRole("dialog", {
      name: CREATE_HEADING,
    });
    fireEvent.change(
      within(createStep).getByLabelText(ORGANIZATION_NAME_LABEL),
      {
        target: { value: "Acme" },
      }
    );
    fireEvent.click(
      within(createStep).getByRole("button", { name: CREATE_ORGANIZATION })
    );

    await waitFor(() =>
      expect(postedPhases()).toEqual([
        OnboardingPhase.CreateOrganization,
        OnboardingPhase.InviteTeam,
      ])
    );
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganization).toHaveBeenCalledWith({
      name: "Acme",
      slug: "acme",
    });
    expect(mocks.setActive).toHaveBeenCalledWith({
      organization: CREATED_ORGANIZATION_ID,
    });
  });

  /**
   * ISS-11253 AC1 + AC2, on the REAL first-user path: Welcome is pressed, the
   * machine routes the first user to the choose step because Clerk's task
   * already made the organization, and the naming affordance is there.
   *
   * The two halves are asserted together on purpose. The positive — the rename
   * REACHED Clerk with the typed name and slug — is what stops a no-op
   * implementation passing; the negatives — `createOrganization` untouched and
   * the session's organization count unmoved — are what stop the ISS-11090
   * defect coming back through a create dressed up as a rename.
   */
  it("names the organization Clerk's task made without creating a second", async () => {
    mocks.organization = clerkTaskOrganization();
    mocks.organizationIds = [CLERK_TASK_ORGANIZATION.id];
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    const nameField = within(chooseStep).getByLabelText(
      ORGANIZATION_NAME_LABEL
    );
    expect(nameField).toHaveValue(CLERK_TASK_ORGANIZATION.name);

    fireEvent.change(nameField, { target: { value: "Ada Labs" } });
    // The organization HAS a slug, and it is a URL. Typing a name must not
    // silently rewrite it the way the create step's proposal does.
    const slugField = within(chooseStep).getByLabelText("Slug");
    expect(slugField).toHaveValue("acme");
    fireEvent.change(slugField, { target: { value: "Ada Labs" } });
    expect(slugField).toHaveValue("ada-labs");

    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    // Through `PUT /organizations/[id]`, which writes Clerk and the database
    // together — NOT Clerk's client SDK, which leaves Closedloop's own row on
    // the old name until a webhook that may never land (codex review).
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith(ORGANIZATION_UPDATE_PATH, {
        name: "Ada Labs",
        slug: "ada-labs",
      })
    );
    expect(mocks.updateOrganization).not.toHaveBeenCalled();
    // And the reader MOVES. The dialog is mounted from the sidebar, so a first
    // user presses Continue sitting on `/acme/...`; once the token carries
    // `ada-labs`, the old segment matches neither the JWT nor the membership
    // list and the page underneath would `notFound()` (tamsinb review).
    await waitFor(() =>
      expect(mocks.resyncOrganizationIdentity).toHaveBeenCalledWith("ada-labs")
    );
    // The rename gates the transition, exactly as the create does.
    await waitFor(() =>
      expect(postedPhases()).toEqual([
        OnboardingPhase.ChooseOrganization,
        OnboardingPhase.InviteTeam,
      ])
    );
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.setActive).not.toHaveBeenCalled();
    expect(mocks.organizationIds).toEqual([CLERK_TASK_ORGANIZATION.id]);
  });

  /**
   * The Clerk resource the name comes from is FETCHED, and the phase is derived
   * from the auth snapshot's `orgId` instead, so the choose step can be on
   * screen before `useOrganization()` answers. Latching the field at mount
   * handed that user a blank name as their organization's current name — and
   * saving it would have written the blank.
   */
  it("shows the organization's name when the Clerk read lands after the step", async () => {
    mocks.organization = null;
    const takeoverHandle = renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );
    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });

    // The organization arrives only now, which is what a real fetch does.
    mocks.organization = clerkTaskOrganization();
    takeoverHandle.rerender();

    await waitFor(() =>
      expect(
        within(chooseStep).getByLabelText(ORGANIZATION_NAME_LABEL)
      ).toHaveValue(CLERK_TASK_ORGANIZATION.name)
    );
  });

  /**
   * ISS-11253 is about the FIRST user, and `organizationChosen` is true for any
   * session with an active organization: `chooseActiveOrganization` routes a
   * member invited into someone else's organization to this same step, and such
   * a member is usually not allowed to rename it. Offering the field there would
   * be an affordance the session cannot back.
   */
  it("withholds the naming affordance from a member of an existing organization", async () => {
    mocks.organization = clerkTaskOrganization();
    seedMembership(OrganizationMembership.ExistingMember);
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    expect(
      within(chooseStep).getByText(CLERK_TASK_ORGANIZATION.name)
    ).toBeInTheDocument();
    expect(
      within(chooseStep).queryByLabelText(ORGANIZATION_NAME_LABEL)
    ).toBeNull();
  });

  /**
   * A failed rename must not advance the run: the organization would keep the
   * name Clerk invented while the reader was told the step was done.
   */
  it("keeps the first user on the step when the rename fails", async () => {
    mocks.organization = clerkTaskOrganization();
    mocks.apiPut.mockRejectedValue(new Error("slug taken"));
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    fireEvent.change(
      within(chooseStep).getByLabelText(ORGANIZATION_NAME_LABEL),
      {
        target: { value: "Ada Labs" },
      }
    );
    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    expect(
      await within(chooseStep).findByText(ORGANIZATION_SAVE_FAILED)
    ).toBeInTheDocument();
    expect(postedPhases()).toEqual([OnboardingPhase.ChooseOrganization]);
  });

  /**
   * whitlockk, ISS-11253 review. A save failure is state about an attempt, and
   * nothing cleared it when the phase left this step: the reader pressed Back,
   * came in again, and the step opened on a failure for something they had not
   * yet attempted — the UI reporting a state that is not true.
   *
   * Driven as the real round trip Back/Get Started makes, and the re-entry's
   * positive (the field is on screen again) is asserted on the same render, so a
   * step that never came back cannot satisfy the absence.
   */
  it("clears a rename failure across a Back and Start round trip", async () => {
    mocks.organization = clerkTaskOrganization();
    mocks.apiPut.mockRejectedValue(new Error("slug taken"));
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    fireEvent.change(
      within(chooseStep).getByLabelText(ORGANIZATION_NAME_LABEL),
      {
        target: { value: "Ada Labs" },
      }
    );
    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));
    expect(
      await within(chooseStep).findByText(ORGANIZATION_SAVE_FAILED)
    ).toBeInTheDocument();

    fireEvent.click(within(chooseStep).getByRole("button", { name: BACK }));
    await screen.findByRole("button", { name: GET_STARTED });
    fireEvent.click(screen.getByRole("button", { name: GET_STARTED }));

    const revisited = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    await waitFor(() =>
      expect(
        within(revisited).getByLabelText(ORGANIZATION_NAME_LABEL)
      ).toBeInTheDocument()
    );
    expect(within(revisited).queryByText(ORGANIZATION_SAVE_FAILED)).toBeNull();
  });

  /**
   * tamsinb, ISS-11253 review. Accepting the name Clerk invented is not an
   * edit, and it used to take an organization-update round trip that could fail
   * and strand the reader on a step whose Continue only ever posted a
   * transition. The transition assertion is the positive half on the same flow,
   * so a Continue that did nothing at all cannot satisfy the negative.
   */
  it("advances a first user who edits nothing without any write", async () => {
    mocks.organization = clerkTaskOrganization();
    renderWebTakeover(CLERK_TASK_ORGANIZATION.id);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    await waitFor(() =>
      expect(
        within(chooseStep).getByLabelText(ORGANIZATION_NAME_LABEL)
      ).toHaveValue(CLERK_TASK_ORGANIZATION.name)
    );
    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    await waitFor(() =>
      expect(postedPhases()).toEqual([
        OnboardingPhase.ChooseOrganization,
        OnboardingPhase.InviteTeam,
      ])
    );
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(mocks.resyncOrganizationIdentity).not.toHaveBeenCalled();
  });

  /**
   * ISS-11154, on the web shell rather than the prototype adapter. The scheme
   * is the subject, so the expected URL is written out here instead of read
   * from the component's own template: a literal the step produced would agree
   * with a revert to `http` and stay green. The desktop shell's counterpart is
   * `desktop-guided-onboarding-first-user-organization.test.tsx`.
   */
  it("states the organization URL as https", async () => {
    renderWebTakeover(null);

    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", { name: GET_STARTED })
    );

    const createStep = await screen.findByRole("dialog", {
      name: CREATE_HEADING,
    });

    // The href and the text the reader copies are the same string, so both are
    // held: `getByRole` matches the accessible name, `toHaveAttribute` the link.
    expect(
      within(createStep).getByRole("link", { name: ORGANIZATION_URL })
    ).toHaveAttribute("href", ORGANIZATION_URL);
  });
});
