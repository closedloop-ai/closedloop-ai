import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  OrganizationProfile: vi.fn(),
  useOrganization: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
  // Renders an `h1` because the real embed does — that is the whole reason the
  // panel wraps it in ThirdPartyHeadingScope, and a mock without one would let
  // the heading test pass with the scope deleted.
  OrganizationProfile: (props: Record<string, unknown>) => {
    mocks.OrganizationProfile(props);
    return (
      <div data-testid="clerk-organization-profile">
        <h1>Members</h1>
      </div>
    );
  },
  useAuth: () => ({ userId: SIGNED_IN_CLERK_USER_ID }),
  useOrganization: mocks.useOrganization,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet }),
}));

import { OrganizationMembersSource } from "@repo/api/src/types/organization-members";
import { OrganizationRole } from "@repo/api/src/types/organization-role";
import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { organizationKeys } from "@repo/app/organizations/hooks/use-organizations";
import { SettingsPanelErrorBoundary } from "@repo/app/settings/v2/components/settings-panel-boundary";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { embeddedOrganizationProfileAppearance } from "@repo/auth/components/appearance";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEMOTED_HEADING_ATTRIBUTE } from "@/components/third-party-heading-scope";
import { CLERK_ORGANIZATION_MEMBERS_PATH } from "../members-embed-start-view";
import { MembersSettingsPanelBody } from "../members-settings-panel-body";

const SHELL_DEEP_LINK = "/acme/settings?panel=members&intent=invite";
const NO_WORKSPACE = /No workspace selected/i;
const SIGNED_IN_CLERK_USER_ID = "user_real_signed_in";

function loadedWithOrganization() {
  mocks.useOrganization.mockReturnValue({
    isLoaded: true,
    organization: { id: "org_1", name: "Acme" },
  });
}

/**
 * The source read is primed with the answer every deployment but a seeded vibe
 * preview gives (`clerk`), so the embed renders on the first frame. `null`
 * leaves the read to the stubbed HTTP client.
 */
function renderBody(
  intent: SettingsPanelIntent = SettingsPanelIntent.View,
  source: OrganizationMembersSource | null = OrganizationMembersSource.Clerk
) {
  const queryClient = createTestQueryClient();
  if (source !== null) {
    queryClient.setQueryData(organizationKeys.membersSource(), source);
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <SettingsPanelErrorBoundary>{children}</SettingsPanelErrorBoundary>
    </QueryClientProvider>
  );
  return render(<MembersSettingsPanelBody intent={intent} />, { wrapper });
}

beforeEach(() => {
  window.history.replaceState(null, "", SHELL_DEEP_LINK);
  mocks.apiGet.mockReset();
});

describe("MembersSettingsPanelBody", () => {
  it("renders the loading skeleton, never an empty roster, while Clerk loads", () => {
    // A read that has not finished has not earned the claim "nobody is in this
    // workspace". Loading and a genuinely empty organization are different
    // facts and must not render the same.
    mocks.useOrganization.mockReturnValue({
      isLoaded: false,
      organization: undefined,
    });

    renderBody();

    expect(
      document.querySelector('[data-settings-panel-state="loading"]')
    ).toBeTruthy();
    expect(screen.queryByTestId("clerk-organization-profile")).toBeNull();
    expect(screen.queryByText(NO_WORKSPACE)).toBeNull();
  });

  it("renders the no-organization state, distinct from loading, when there is none", () => {
    mocks.useOrganization.mockReturnValue({
      isLoaded: true,
      organization: null,
    });

    renderBody();

    expect(
      document.querySelector('[data-members-panel-state="no-organization"]')
    ).toBeTruthy();
    expect(
      document.querySelector('[data-settings-panel-state="loading"]')
    ).toBeNull();
    expect(screen.queryByTestId("clerk-organization-profile")).toBeNull();
  });

  it("mounts Clerk's embed with the shared appearance and hash routing", () => {
    loadedWithOrganization();

    renderBody();

    expect(screen.getByTestId("clerk-organization-profile")).toBeTruthy();
    expect(mocks.OrganizationProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        appearance: embeddedOrganizationProfileAppearance,
        routing: "hash",
      })
    );
  });

  it("writes the members-route fragment on mount", () => {
    loadedWithOrganization();

    renderBody();

    expect(window.location.hash).toBe(`#${CLERK_ORGANIZATION_MEMBERS_PATH}`);
  });

  it("seeds that fragment without pushing a history entry, and still signals Clerk", () => {
    // `window.location.hash = …` pushes a session-history entry, so one Back
    // with the panel still mounted empties the fragment, Clerk's `HashRouter`
    // re-reads it, finds no route and falls to its index (Organization
    // General). Nothing in `apps/app` listens for `popstate` to recover that,
    // so the seed must not create the entry — while still delivering the
    // `hashchange` the assignment was really being used for, which is what the
    // embed re-reads on.
    //
    // The route is spelled out rather than imported: an assertion against the
    // module's own constant holds whatever that constant says and survives its
    // mutation.
    loadedWithOrganization();
    const heard: HashChangeEvent[] = [];
    const onHashChange = (event: Event) => {
      heard.push(event as HashChangeEvent);
    };
    window.addEventListener("hashchange", onHashChange);
    const hrefBeforeSeed = window.location.href;
    const historyLengthBeforeSeed = window.history.length;

    try {
      renderBody();
    } finally {
      window.removeEventListener("hashchange", onHashChange);
    }

    expect(window.history.length).toBe(historyLengthBeforeSeed);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.oldURL).toBe(hrefBeforeSeed);
    expect(heard[0]?.newURL).toBe(window.location.href);
    expect(window.location.hash).toBe("#/organization-members");
  });

  it("still mounts the embed and writes that fragment for the invite intent", () => {
    // The required fallback. Clerk 1.6.5 routes no invitations page — it is a
    // tab inside the members page — so `intent=invite` cannot open it, and the
    // panel must not render nothing or throw. WHICH view Clerk then opens is
    // not observable here: the mock ignores every prop and the fragment. What
    // is pinned is that the embed mounts and the fragment is the members route.
    loadedWithOrganization();

    renderBody(SettingsPanelIntent.Invite);

    expect(screen.getByTestId("clerk-organization-profile")).toBeTruthy();
    expect(window.location.hash).toBe(`#${CLERK_ORGANIZATION_MEMBERS_PATH}`);
  });

  it("leaves the shell's ?panel= and intent= deep link intact", () => {
    // MANDATORY because the resolved routing mode is `hash`. The Settings v2
    // shell is a Dialog that owns `?panel=` and `intent=`; seeding the embed
    // through anything that rewrites the URL rather than the fragment — a
    // router navigation, a location.href assignment — would drop them and the
    // shell would lose the panel it was opened on.
    loadedWithOrganization();

    renderBody(SettingsPanelIntent.Invite);

    const params = new URLSearchParams(window.location.search);
    expect(params.get("panel")).toBe("members");
    expect(params.get("intent")).toBe("invite");
    expect(window.location.pathname).toBe("/acme/settings");
  });

  it("does not drag a user back to the roster after an inner Clerk navigation", () => {
    // The embed writes its own fragment as the user moves through it. Re-seeding
    // on a later render would undo that navigation under them.
    //
    // The rerender CHANGES `intent` deliberately. The seeding effect is keyed on
    // `[intent, isLoaded, embedOrganization]`, and the organization mock returns one
    // stable object, so a rerender with the same intent leaves the effect unrun
    // — and this test would then stay green with the `#/` guard deleted, which
    // is the exact mutation it exists to catch.
    loadedWithOrganization();
    const { rerender } = renderBody();

    window.location.hash = "#/organization-billing";
    rerender(<MembersSettingsPanelBody intent={SettingsPanelIntent.Invite} />);

    expect(window.location.hash).toBe("#/organization-billing");
  });

  it("re-seeds the roster on a later open, not the last view left inside the embed", () => {
    // The shell's overlay dismiss performs no navigation, so whatever fragment
    // the embed last wrote is still on the URL when the panel is opened again —
    // and the seed suppresses itself for a `#/…` fragment, which would open the
    // Members panel on Billing. The panel clears the fragment it owns on the way
    // out; deleting that cleanup fails both halves of this test.
    loadedWithOrganization();
    const { unmount } = renderBody();
    window.location.hash = "#/organization-billing";

    unmount();

    expect(window.location.hash).toBe("");
    expect(new URLSearchParams(window.location.search).get("panel")).toBe(
      "members"
    );

    renderBody();

    expect(window.location.hash).toBe(`#${CLERK_ORGANIZATION_MEMBERS_PATH}`);
  });

  it("contributes exactly one h2 of its own", () => {
    loadedWithOrganization();

    const { container } = renderBody();

    expect(container.querySelectorAll("h2")).toHaveLength(1);
  });

  it("demotes the h1 Clerk injects, so the page keeps one top-level heading", () => {
    // WCAG 2.2 SC 1.3.1. The h1 elements stay in the markup by design — they
    // belong to Clerk's React tree — so what is asserted is what assistive
    // technology computes: an explicit role plus aria-level below the page's
    // own h1. `pnpm check:source-gates` catches this class of regression, and
    // caught exactly it on #6647.
    loadedWithOrganization();

    renderBody();

    const injected = screen
      .getByTestId("clerk-organization-profile")
      .querySelector("h1");
    expect(injected?.getAttribute(DEMOTED_HEADING_ATTRIBUTE)).toBe("3");
    expect(injected?.getAttribute("aria-level")).toBe("3");
  });
});

function member(
  userId: string,
  firstName: string,
  lastName: string,
  role: string
) {
  return {
    userId,
    identifier: `${firstName.toLowerCase()}@acmeco.example`,
    firstName,
    lastName,
    imageUrl: null,
    role,
    createdAt: null,
  };
}

const SEEDED_ROSTER = [
  member(
    "user_vibe_seed_maya_okafor",
    "Maya",
    "Okafor",
    OrganizationRole.Owner
  ),
  member(SIGNED_IN_CLERK_USER_ID, "Jordan", "Avery", OrganizationRole.Admin),
  member(
    "user_vibe_seed_daveth_reyes",
    "Daveth",
    "Reyes",
    OrganizationRole.Member
  ),
];

const SOURCE_READ = "/organizations/members?limit=1";
const ROSTER_READ = "/organizations/members?limit=100&offset=0";

/**
 * Answers the one-row source read with a page carrying `source` (`undefined`:
 * an API from before the field) or an error, and the roster read with the
 * seeded page.
 */
function answerApi(source: OrganizationMembersSource | undefined | Error) {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path !== SOURCE_READ) {
      return Promise.resolve({
        members: SEEDED_ROSTER,
        total: SEEDED_ROSTER.length,
        hasMore: false,
        source: OrganizationMembersSource.Seeded,
      });
    }
    if (source instanceof Error) {
      return Promise.reject(source);
    }
    return Promise.resolve({
      members: SEEDED_ROSTER.slice(0, 1),
      total: SEEDED_ROSTER.length,
      hasMore: true,
      ...(source === undefined ? {} : { source }),
    });
  });
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (!row) {
    throw new Error(`no roster row for ${name}`);
  }
  return row;
}

// ISS-12135: a seeded Vercel vibe preview binds the person's real Clerk
// organization, so the embed would list their real coworkers. A read that
// lists nobody says where the roster comes from, and the panel follows it
// without guessing; only `seeded` reads the roster.
describe("MembersSettingsPanelBody by the roster read's source", () => {
  it("lists the seeded people read-only when the source is seeded", async () => {
    loadedWithOrganization();
    answerApi(OrganizationMembersSource.Seeded);

    renderBody(SettingsPanelIntent.View, null);

    const roster = await screen.findByRole("list", { name: "Members" });
    expect(mocks.apiGet.mock.calls.map(([path]) => path)).toEqual([
      SOURCE_READ,
      ROSTER_READ,
    ]);
    expect(within(roster).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(rowFor("Maya Okafor")).getByRole("combobox")
    ).toHaveTextContent("Owner");
    const signedIn = rowFor("Jordan Avery");
    expect(within(signedIn).getByRole("combobox")).toHaveTextContent("Admin");
    expect(within(signedIn).getByText("You")).toBeTruthy();
    expect(
      within(rowFor("Daveth Reyes")).getByRole("combobox")
    ).toHaveTextContent("Member");
    for (const combobox of within(roster).getAllByRole("combobox")) {
      expect(combobox).toBeDisabled();
    }
    expect(within(roster).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("clerk-organization-profile")).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("mounts Clerk's embed when the source is clerk", async () => {
    loadedWithOrganization();
    answerApi(OrganizationMembersSource.Clerk);

    renderBody(SettingsPanelIntent.View, null);

    expect(
      await screen.findByTestId("clerk-organization-profile")
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Members" })).toBeNull();
    expect(mocks.apiGet.mock.calls.map(([path]) => path)).toEqual([
      SOURCE_READ,
    ]);
    expect(window.location.hash).toBe(`#${CLERK_ORGANIZATION_MEMBERS_PATH}`);
  });

  it("mounts Clerk's embed when an older API sends no source", async () => {
    loadedWithOrganization();
    answerApi(undefined);

    renderBody(SettingsPanelIntent.View, null);

    expect(
      await screen.findByTestId("clerk-organization-profile")
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Members" })).toBeNull();
    expect(mocks.apiGet.mock.calls.map(([path]) => path)).toEqual([
      SOURCE_READ,
    ]);
  });

  it("shows the panel's error state, not the embed, when the read fails", async () => {
    loadedWithOrganization();
    answerApi(new Error("api down"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderBody(SettingsPanelIntent.View, null);

    await waitFor(() =>
      expect(
        document.querySelector('[data-settings-panel-state="render-error"]')
      ).toBeTruthy()
    );
    expect(screen.queryByTestId("clerk-organization-profile")).toBeNull();
    expect(screen.queryByRole("list", { name: "Members" })).toBeNull();
    consoleError.mockRestore();
  });

  it("asks nothing and shows the no-organization state when Clerk has no organization", () => {
    mocks.useOrganization.mockReturnValue({
      isLoaded: true,
      organization: null,
    });

    renderBody(SettingsPanelIntent.View, null);

    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-members-panel-state="no-organization"]')
    ).toBeTruthy();
  });

  it("asks nothing while Clerk's organization read is in flight", () => {
    mocks.useOrganization.mockReturnValue({
      isLoaded: false,
      organization: undefined,
    });

    renderBody(SettingsPanelIntent.View, null);

    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-settings-panel-state="loading"]')
    ).toBeTruthy();
  });

  it("shows neither the embed nor a roster while the read is in flight", () => {
    loadedWithOrganization();
    mocks.apiGet.mockReturnValue(new Promise(() => undefined));

    renderBody(SettingsPanelIntent.View, null);

    expect(
      document.querySelector('[data-settings-panel-state="loading"]')
    ).toBeTruthy();
    expect(screen.queryByTestId("clerk-organization-profile")).toBeNull();
    expect(window.location.hash).toBe("");
  });
});
