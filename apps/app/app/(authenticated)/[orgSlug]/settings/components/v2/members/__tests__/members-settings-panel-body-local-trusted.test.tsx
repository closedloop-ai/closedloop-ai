import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@repo/auth/client", () => ({
  OrganizationProfile: () => null,
  useAuth: () => ({ userId: null }),
  // What the local-trusted hooks answer: no Clerk organization (ISS-12054).
  useOrganization: () => ({ isLoaded: true, organization: null }),
}));

// The roster hook, the identity provider and the panel's error boundary are
// the real ones; only the HTTP client is stubbed.
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => api,
}));

import { OrganizationRole } from "@repo/api/src/types/organization-role";
import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { SettingsPanelErrorBoundary } from "@repo/app/settings/v2/components/settings-panel-boundary";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_USER_ID,
  type LocalTrustedIdentity,
} from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MembersSettingsPanelBody } from "../members-settings-panel-body";

/**
 * ISS-12135 bug 8: Settings > Members on a `pnpm vibe up` stack listed nobody
 * ("No workspace selected"), because that stack has no Clerk and the panel's
 * body is Clerk's embed. It now lists the seeded roster from the API, with the
 * owner and the signed-in admin marked.
 */

const DEFAULT_IDENTITY: LocalTrustedIdentity = {
  orgId: LOCAL_TRUSTED_ORG_ID,
  orgSlug: LOCAL_TRUSTED_ORG_SLUG,
  userId: LOCAL_TRUSTED_USER_ID,
};

const VIBE_IDENTITY: LocalTrustedIdentity = {
  ...DEFAULT_IDENTITY,
  orgSlug: "acme-co",
  orgName: "Acme Co",
  userEmail: "jordan.avery@closedloop.ai",
  userFirstName: "Jordan",
  userLastName: "Avery",
};

function member(
  userId: string,
  firstName: string,
  lastName: string,
  role: string
) {
  return {
    userId,
    identifier: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@acmeco.example`,
    firstName,
    lastName,
    imageUrl: null,
    role,
    createdAt: null,
  };
}

const ROSTER = [
  member(
    "user_vibe_seed_maya_okafor",
    "Maya",
    "Okafor",
    OrganizationRole.Owner
  ),
  member(LOCAL_TRUSTED_USER_ID, "Jordan", "Avery", OrganizationRole.Admin),
  member(
    "user_vibe_seed_daveth_reyes",
    "Daveth",
    "Reyes",
    OrganizationRole.Member
  ),
];

function renderUnder(identity: LocalTrustedIdentity) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <LocalTrustedIdentityProvider identity={identity}>
        <SettingsPanelErrorBoundary>{children}</SettingsPanelErrorBoundary>
      </LocalTrustedIdentityProvider>
    </QueryClientProvider>
  );
  return render(
    <MembersSettingsPanelBody intent={SettingsPanelIntent.View} />,
    {
      wrapper,
    }
  );
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (!row) {
    throw new Error(`no roster row for ${name}`);
  }
  return row;
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue({
    members: ROSTER,
    total: ROSTER.length,
    hasMore: false,
  });
});

describe("MembersSettingsPanelBody under a local-trusted vibe identity", () => {
  it("lists the seeded people with the owner and the signed-in admin marked", async () => {
    renderUnder(VIBE_IDENTITY);

    const roster = await screen.findByRole("list", { name: "Members" });
    expect(api.get).toHaveBeenCalledWith(
      "/organizations/members?limit=100&offset=0"
    );
    expect(within(roster).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(rowFor("Maya Okafor")).getByRole("combobox")
    ).toHaveTextContent("Owner");
    const jordan = rowFor("Jordan Avery");
    expect(within(jordan).getByRole("combobox")).toHaveTextContent("Admin");
    expect(within(jordan).getByText("You")).toBeTruthy();
    expect(
      within(rowFor("Daveth Reyes")).getByRole("combobox")
    ).toHaveTextContent("Member");
    expect(
      document.querySelector('[data-members-panel-state="no-organization"]')
    ).toBeNull();
  });

  it("waits on the roster read instead of showing an empty list", () => {
    api.get.mockReturnValue(new Promise(() => undefined));

    renderUnder(VIBE_IDENTITY);

    expect(
      document.querySelector('[data-settings-panel-state="loading"]')
    ).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("hands a failed roster read to the panel's error boundary", async () => {
    api.get.mockRejectedValue(new Error("roster down"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderUnder(VIBE_IDENTITY);

    await waitFor(() =>
      expect(
        document.querySelector('[data-settings-panel-state="render-error"]')
      ).toBeTruthy()
    );
    expect(screen.queryByRole("listitem")).toBeNull();
    consoleError.mockRestore();
  });

  it("keeps every other local-trusted lane on the no-organization state", () => {
    renderUnder(DEFAULT_IDENTITY);

    expect(api.get).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-members-panel-state="no-organization"]')
    ).toBeTruthy();
  });
});
