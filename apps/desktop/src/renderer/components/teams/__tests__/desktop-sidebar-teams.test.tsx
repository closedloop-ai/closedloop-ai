import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { teamKeys } from "@repo/app/teams/hooks/use-teams";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHashHost } from "../../../navigation/__tests__/hash-host-fixture";
import { createDesktopNavigation } from "../../../navigation/desktop-adapter";
import { DesktopSidebarTeams } from "../desktop-sidebar-teams";

const team = {
  id: "019c24dc-9445-75ec-8136-c4e6d83147fa",
  name: "Engineering",
  organizationId: "org_test",
  slug: "engineering",
  memberCount: 1,
  projectCount: 0,
};
const user = {
  id: "user_test",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
};

function mount({
  enabled = true,
  orgId = "org_test",
  userId = "user_test",
}: {
  enabled?: boolean;
  orgId?: string | null;
  userId?: string | null;
} = {}) {
  const host = createFakeHashHost("#/dashboard");
  const navigation = createDesktopNavigation(host);
  const writes: unknown[] = [];
  const result = render(
    <AppCoreStoryProviders
      apiRoutes={[
        { method: "GET", path: "/teams", respond: () => [team] },
        { method: "GET", path: "/projects/favorites", respond: () => [] },
        { method: "GET", path: "/me", respond: () => user },
        { method: "GET", path: "/users", respond: () => [user] },
        {
          method: "POST",
          path: "/teams",
          respond: ({ body }) => {
            writes.push(body);
            return {
              ...team,
              id: "019c24dc-9445-75ec-8136-c4e6d83147fb",
              name: "Platform",
            };
          },
        },
      ]}
      navigationAdapter={navigation.adapter}
      queryData={[
        [teamKeys.lists(), [team]],
        [projectKeys.favorites(), []],
      ]}
    >
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId, userId })}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: enabled
              ? [PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY]
              : [],
          })}
        >
          <SidebarProvider>
            <DesktopSidebarTeams />
          </SidebarProvider>
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </AppCoreStoryProviders>
  );
  return { ...result, host, writes };
}

describe("Desktop Teams host", () => {
  it("keeps missing/off rollout assignments and signed-out identities dark", () => {
    const first = mount({ enabled: false });
    expect(screen.queryByText("Your Teams")).toBeNull();
    first.unmount();
    mount({ userId: null, orgId: null });
    expect(screen.queryByText("Your Teams")).toBeNull();
  });

  it("withholds cached team links from a different active organization", () => {
    mount({ orgId: "org_other" });
    expect(screen.queryByRole("link", { name: "Engineering" })).toBeNull();
    expect(screen.getByText("Your Teams")).not.toBeNull();
  });

  it("uses native team project paths through the hash adapter", async () => {
    const { host } = mount();
    const link = await screen.findByRole("link", { name: "Engineering" });
    expect(link.getAttribute("href")).toBe(`#/teams/${team.id}/projects`);
    fireEvent.click(link);
    expect(host.getHash()).toBe(`#/teams/${team.id}/projects`);
  });

  it("creates through the shared dialog and navigates to the created team's projects", async () => {
    const { host, writes } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add Team" }));
    await screen.findByText("Ada Lovelace");
    fireEvent.change(screen.getByLabelText("Team Name"), {
      target: { value: "Platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    await waitFor(() => expect(writes).toEqual([{ name: "Platform" }]));
    await waitFor(() =>
      expect(host.getHash()).toBe(
        "#/teams/019c24dc-9445-75ec-8136-c4e6d83147fb/projects"
      )
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);
});

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((media: string) => ({
      media,
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
