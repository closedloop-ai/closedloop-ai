import { CLERK_OAUTH_STRATEGY } from "@repo/app/shared/lib/clerk-oauth-strategy";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";

const mocks = vi.hoisted(() => ({
  openUserProfile: vi.fn(),
  useClerk: vi.fn(),
  useUser: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: mocks.useClerk,
  useUser: mocks.useUser,
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";
import { ProfileSettingsPanelBody } from "../profile-settings-panel-body";

/** Every fixture value the approved prototype hardcodes. None may ship. */
const PROTOTYPE_FIXTURE_STRINGS = [
  "Ottilie Eastwick",
  "Product builder",
  "ottilie.eastwick@example.com",
  "aeyecoe",
];

const CLERK_SECURITY_PATH = "/security";

const PROFILE_LOAD_FAILURE = /couldn't load your profile/i;
const NO_PRIMARY_EMAIL = /No primary email address is set/i;
const PRIMARY_EMAIL_BADGE = "Primary";
const CHANGE_PASSWORD_LABEL = /Change password/i;
const SET_PASSWORD_LABEL = /Set password/i;
const ADD_EMAIL_LABEL = /Add email address/i;

installPointerCaptureShims();

function githubAccount(overrides: Record<string, unknown> = {}) {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    emailAddress: "ada@example.com",
    provider: DesktopSignInProvider.GitHub,
    username: "adalovelace",
    verification: { status: "verified" },
    ...overrides,
  };
}

function signedIn(overrides: Record<string, unknown> = {}) {
  const user = {
    createExternalAccount: vi.fn().mockResolvedValue({ verification: null }),
    deleteSelfEnabled: true,
    externalAccounts: [],
    firstName: "Ada",
    imageUrl: "",
    lastName: "Lovelace",
    passwordEnabled: false,
    primaryEmailAddress: { emailAddress: "ada@example.com" },
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  mocks.useUser.mockReturnValue({ isLoaded: true, user });
  return user;
}

function clerkClient(lastAuthenticationStrategy: string | null = null) {
  mocks.useClerk.mockReturnValue({
    client: { lastAuthenticationStrategy },
    openUserProfile: mocks.openUserProfile,
  });
}

function renderBody() {
  return render(<ProfileSettingsPanelBody intent={SettingsPanelIntent.View} />);
}

beforeEach(() => {
  vi.stubGlobal("location", {
    assign: vi.fn(),
    href: "http://localhost:3000/acme/settings",
  });
  clerkClient();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("while Clerk is still loading", () => {
  it("shows a busy status, never an empty profile", () => {
    // A blank row here would say "you have no email addresses" about a read
    // that has not finished.
    mocks.useUser.mockReturnValue({ isLoaded: false, user: undefined });

    renderBody();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("Email addresses")).not.toBeInTheDocument();
  });
});

describe("when Clerk loaded but produced no user", () => {
  it("raises an alert rather than rendering an empty profile", () => {
    mocks.useUser.mockReturnValue({ isLoaded: true, user: null });

    renderBody();

    expect(screen.getByRole("alert")).toHaveTextContent(PROFILE_LOAD_FAILURE);
    expect(screen.queryByText("Password not set")).not.toBeInTheDocument();
  });
});

describe("identity", () => {
  it("renders the signed-in user's real name and primary email", () => {
    signedIn();

    renderBody();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText(PRIMARY_EMAIL_BADGE)).toBeInTheDocument();
  });

  it("ships none of the prototype's fixture values", () => {
    signedIn({ externalAccounts: [githubAccount()] });

    renderBody();

    for (const fixture of PROTOTYPE_FIXTURE_STRINGS) {
      expect(screen.queryByText(fixture), fixture).not.toBeInTheDocument();
    }
  });

  it("says so when Clerk holds no primary email, instead of leaving a blank row", () => {
    signedIn({ primaryEmailAddress: null });

    renderBody();

    expect(screen.getByText(NO_PRIMARY_EMAIL)).toBeInTheDocument();
    expect(screen.queryByText(PRIMARY_EMAIL_BADGE)).not.toBeInTheDocument();
  });

  it("switches the password row on Clerk's passwordEnabled", () => {
    signedIn({ passwordEnabled: true });

    renderBody();

    expect(screen.getByText("Password set")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CHANGE_PASSWORD_LABEL })
    ).toBeInTheDocument();
    expect(screen.queryByText("Password not set")).not.toBeInTheDocument();
  });

  it("offers to set a password when the account has none", () => {
    signedIn();

    renderBody();

    expect(screen.getByText("Password not set")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SET_PASSWORD_LABEL })
    ).toBeInTheDocument();
  });

  it("hides the delete-account card when the Clerk instance forbids self-deletion", () => {
    // The prototype's card is unconditional; that is fixture behavior. Offering
    // an action the instance will refuse is a control that lies.
    signedIn({ deleteSelfEnabled: false });

    renderBody();

    expect(
      screen.queryByRole("button", { name: "Delete account" })
    ).not.toBeInTheDocument();
  });

  it("shows the delete-account card when self-deletion is allowed", () => {
    signedIn();

    renderBody();

    expect(
      screen.getByRole("button", { name: "Delete account" })
    ).toBeInTheDocument();
  });
});

describe("the Clerk-owned controls", () => {
  it("opens the profile modal at its default page for Update profile", async () => {
    signedIn();
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: "Update profile" })
    );

    expect(mocks.openUserProfile).toHaveBeenCalledWith();
  });

  it("opens the profile modal at its default page for Add email address", async () => {
    // Email management lives on that same default page, so this control
    // deliberately passes no start path.
    signedIn();
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: ADD_EMAIL_LABEL })
    );

    expect(mocks.openUserProfile).toHaveBeenCalledWith();
  });

  it("opens the security page for Set password", async () => {
    signedIn();
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: SET_PASSWORD_LABEL })
    );

    expect(mocks.openUserProfile).toHaveBeenCalledWith({
      __experimental_startPath: CLERK_SECURITY_PATH,
    });
  });

  it("opens the security page for Delete account", async () => {
    signedIn();
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete account" })
    );

    expect(mocks.openUserProfile).toHaveBeenCalledWith({
      __experimental_startPath: CLERK_SECURITY_PATH,
    });
  });
});

describe("sign-in methods", () => {
  it("renders a connected provider from Clerk's external accounts", () => {
    signedIn({ externalAccounts: [githubAccount()] });

    renderBody();

    expect(screen.getByText("· adalovelace")).toBeInTheDocument();
  });

  it("badges the provider named by the client's last authentication strategy", () => {
    clerkClient(CLERK_OAUTH_STRATEGY[DesktopSignInProvider.GitHub]);
    signedIn({ externalAccounts: [githubAccount()] });

    renderBody();

    expect(screen.getByText("Current sign-in")).toBeInTheDocument();
  });

  it("badges nothing when the client records a non-oauth strategy", () => {
    clerkClient("password");
    signedIn({ externalAccounts: [githubAccount()] });

    renderBody();

    expect(screen.queryByText("Current sign-in")).not.toBeInTheDocument();
  });

  it("wires Connect GitHub to the shared authorize seam with a settings return", async () => {
    // Pinned to the canonical URL builder, not a literal, so a re-implemented
    // connect URL fails here.
    signedIn();
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: "GitHub sign-in options" })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Connect GitHub" })
    );

    await waitFor(() => {
      expect(globalThis.location.assign).toHaveBeenCalledWith(
        getGitHubConnectUrl("authorize", { returnTo: "/acme/settings" })
      );
    });
  });

  it("wires a disconnect through to Clerk", async () => {
    // Proves the body actually hands the actions hook to the section: delete
    // that wiring and this fails, where a hook-only test would still pass.
    const account = githubAccount();
    const user = signedIn({ externalAccounts: [account] });
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: "GitHub sign-in options" })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Disconnect GitHub" })
    );

    await waitFor(() => {
      expect(account.destroy).toHaveBeenCalledTimes(1);
    });
    expect(user.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the row connected and names the reason on the row when Clerk refuses the removal", async () => {
    const account = githubAccount();
    account.destroy = vi.fn().mockRejectedValue({
      errors: [{ longMessage: "You cannot remove your last sign-in method." }],
    });
    signedIn({ externalAccounts: [account] });
    renderBody();

    await userEvent.click(
      screen.getByRole("button", { name: "GitHub sign-in options" })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Disconnect GitHub" })
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "You cannot remove your last sign-in method."
      );
    });
    expect(
      screen.getAllByText("You cannot remove your last sign-in method.")
    ).toHaveLength(1);
    expect(screen.getByText("· adalovelace")).toBeInTheDocument();
  });
});
