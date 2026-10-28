import { SettingsDomainStatus } from "@repo/api/src/types/settings-domain";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";

const mocks = vi.hoisted(() => ({
  currentUser: {} as Record<string, unknown>,
  domainAccess: {} as Record<string, unknown>,
  mutate: vi.fn(),
  isPending: false,
  organization: {} as Record<string, unknown>,
  queryClientClear: vi.fn(),
  resync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../../users/hooks/use-users", () => ({
  useCurrentUser: () => mocks.currentUser,
}));

vi.mock("../../../../../organizations/hooks/use-organizations", () => ({
  useOrganization: () => mocks.organization,
  useUpdateOrganization: () => ({
    isPending: mocks.isPending,
    mutate: mocks.mutate,
  }),
}));

vi.mock("../../../hooks/use-settings-view-model", () => ({
  useSettingsDomainAccess: () => mocks.domainAccess,
}));

vi.mock("../../../../../shared/auth/use-organization-identity-resync", () => ({
  useOrganizationIdentityResync: () => mocks.resync,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: mocks.queryClientClear }),
}));

import { OrganizationProfileCard } from "../organization-profile-card";

const ORGANIZATION = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
};

const ADMIN_GRANTS = { admin: true, edit: true, owner: false, read: true };
const SAVE_BUTTON_NAME = /save changes/i;
const CAPABILITY_ERROR_COPY = /isn't a refusal/i;
const ADMIN_ONLY_SLUG_COPY = /Only an organization admin/i;
const MEMBER_GRANTS = { admin: false, edit: true, owner: false, read: true };

function settled(grants: typeof ADMIN_GRANTS) {
  return { grants, status: "settled" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPending = false;
  mocks.currentUser = { data: { organizationId: "org-1" }, error: null };
  mocks.organization = { data: ORGANIZATION, error: null };
  mocks.domainAccess = settled(ADMIN_GRANTS);
  mocks.resync = vi.fn().mockResolvedValue(undefined);
});

function nameField() {
  return screen.getByLabelText("Organization name");
}

function slugField() {
  return screen.getByLabelText("Organization URL");
}

function saveButton() {
  return screen.getByRole("button", { name: SAVE_BUTTON_NAME });
}

describe("OrganizationProfileCard reads", () => {
  it("shows a skeleton — not an empty form — while the organization is still loading", () => {
    mocks.organization = { data: undefined, error: null };

    render(<OrganizationProfileCard />);

    expect(
      screen.getByTestId("organization-profile-loading")
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Organization name")
    ).not.toBeInTheDocument();
  });

  it("shows a skeleton while the authorization projection is still pending", () => {
    mocks.domainAccess = { status: "pending" };

    render(<OrganizationProfileCard />);

    expect(
      screen.getByTestId("organization-profile-loading")
    ).toBeInTheDocument();
  });

  it("surfaces a failed organization read instead of rendering the form over blanks", () => {
    mocks.organization = { data: undefined, error: new Error("Network down") };

    render(<OrganizationProfileCard />);

    expect(screen.getByText("Network down")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Organization name")
    ).not.toBeInTheDocument();
  });

  it("renders a failed authorization read as its own state, NOT as a read-only form", () => {
    mocks.domainAccess = { status: "error" };

    render(<OrganizationProfileCard />);

    expect(screen.getByText(CAPABILITY_ERROR_COPY)).toBeInTheDocument();
    // The defect this guards: falling back to NO_SETTINGS_DOMAIN_GRANTS would
    // render every field disabled, which reads to the user as "you are not
    // allowed" when the truth is "we could not find out".
    expect(screen.queryByLabelText("Organization URL")).not.toBeInTheDocument();
  });

  it("renders the real organization's name and slug when everything settled", () => {
    render(<OrganizationProfileCard />);

    expect(nameField()).toHaveValue("Acme");
    expect(slugField()).toHaveValue("acme");
  });
});

describe("OrganizationProfileCard authorization", () => {
  it("lets an admin edit the organization URL", () => {
    render(<OrganizationProfileCard />);

    expect(slugField()).not.toBeDisabled();
    expect(screen.queryByText(ADMIN_ONLY_SLUG_COPY)).not.toBeInTheDocument();
  });

  it("offers a member the name but NOT the URL, whose route would answer 403", () => {
    mocks.domainAccess = settled(MEMBER_GRANTS);

    render(<OrganizationProfileCard />);

    expect(nameField()).not.toBeDisabled();
    expect(slugField()).toBeDisabled();
    expect(screen.getByText(ADMIN_ONLY_SLUG_COPY)).toBeInTheDocument();
  });
});

describe("OrganizationProfileCard saving", () => {
  it("does not submit when nothing changed", async () => {
    render(<OrganizationProfileCard />);

    expect(saveButton()).toBeDisabled();
    await userEvent.click(saveButton());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("sends only the name when only the name changed", async () => {
    render(<OrganizationProfileCard />);

    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Acme Rocketry");
    await userEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      id: "org-1",
      name: "Acme Rocketry",
    });
  });

  it("normalizes typed slug input to the shape the shared schema accepts", async () => {
    render(<OrganizationProfileCard />);

    await userEvent.clear(slugField());
    await userEvent.type(slugField(), "Acme Rocketry");

    expect(slugField()).toHaveValue("acme-rocketry");
  });

  it("resyncs the shell onto the NEW slug and then clears the cache", async () => {
    render(<OrganizationProfileCard />);

    await userEvent.clear(slugField());
    await userEvent.type(slugField(), "acme-rocketry");
    await userEvent.click(saveButton());

    const [payload, handlers] = mocks.mutate.mock.calls[0];
    expect(payload).toEqual({ id: "org-1", slug: "acme-rocketry" });

    await act(() =>
      handlers.onSuccess({ ...ORGANIZATION, slug: "acme-rocketry" })
    );

    expect(mocks.resync).toHaveBeenCalledWith("acme-rocketry");
    expect(mocks.queryClientClear).toHaveBeenCalledTimes(1);
  });

  it("resyncs Clerk for a name-only save, but does NOT clear the cache", async () => {
    // The name lives in Clerk's active-organization object too, and the API
    // writes it through the server SDK — without the resync the account menu
    // keeps rendering the old name while this form says "Saved". The cache
    // clear stays slug-only: no org-scoped key was fetched under a stale slug.
    render(<OrganizationProfileCard />);

    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Acme Rocketry");
    await userEvent.click(saveButton());

    const [, handlers] = mocks.mutate.mock.calls[0];
    await act(() =>
      handlers.onSuccess({ ...ORGANIZATION, name: "Acme Rocketry" })
    );

    expect(mocks.resync).toHaveBeenCalledWith(ORGANIZATION.slug);
    expect(mocks.queryClientClear).not.toHaveBeenCalled();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("locks both identity fields while the save is in flight", () => {
    // The inputs used to stay editable, so a draft typed during the request was
    // overwritten by `onSuccess` echoing the older response back into state —
    // and then labelled "Saved".
    mocks.isPending = true;
    render(<OrganizationProfileCard />);

    expect(nameField()).toBeDisabled();
    expect(slugField()).toBeDisabled();
  });

  it("renders a 409 as an inline conflict and NEVER as a save", async () => {
    render(<OrganizationProfileCard />);

    await userEvent.clear(slugField());
    await userEvent.type(slugField(), "taken-slug");
    await userEvent.click(saveButton());

    const [, handlers] = mocks.mutate.mock.calls[0];
    act(() => handlers.onError(new ApiError("Slug is unavailable", 409)));

    expect(
      await screen.findByText("This organization URL is already taken")
    ).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });

  it("clears the conflict once the user edits the slug again", async () => {
    render(<OrganizationProfileCard />);

    await userEvent.clear(slugField());
    await userEvent.type(slugField(), "taken-slug");
    await userEvent.click(saveButton());
    act(() =>
      mocks.mutate.mock.calls[0][1].onError(
        new ApiError("Slug is unavailable", 409)
      )
    );
    await screen.findByText("This organization URL is already taken");

    await userEvent.type(slugField(), "-two");

    await waitFor(() =>
      expect(
        screen.queryByText("This organization URL is already taken")
      ).not.toBeInTheDocument()
    );
    expect(saveButton()).not.toBeDisabled();
  });

  it("installs no local message for a non-conflict rejection, and still does not show Saved", async () => {
    render(<OrganizationProfileCard />);

    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Acme Rocketry");
    await userEvent.click(saveButton());

    act(() =>
      mocks.mutate.mock.calls[0][1].onError(new ApiError("Server error", 500))
    );

    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(
      screen.queryByText("This organization URL is already taken")
    ).not.toBeInTheDocument();
    // Still dirty, so the user can retry the edit they made.
    expect(saveButton()).not.toBeDisabled();
  });
});

describe("OrganizationProfileCard at modal scale (ISS-8975)", () => {
  /**
   * The card no longer sits on a page: the Settings modal's rail takes a fixed
   * 240 off the column, so at a 768px viewport this form has ~432px while a
   * viewport-keyed `sm:` reads 768 and lays out two-up — halving a field whose
   * URL input already gives a `shrink-0` origin prefix its first ~109px, inside
   * a dialog that clips rather than scrolls horizontally.
   *
   * All THREE declarations of this layout are asserted, not just the two grids:
   * the actions row's span is the one a reader forgets, and reverting it alone
   * reinstates the viewport axis this suite exists to keep out. The loading and
   * ready shapes are asserted together because them drifting apart is how the
   * skeleton stops predicting the form.
   */
  it("sizes the form, its skeleton, and its actions row to the panel column, not the viewport", () => {
    mocks.organization = { data: undefined, error: null };
    const view = render(<OrganizationProfileCard />);

    const skeleton = screen.getByTestId("organization-profile-loading");
    expect(skeleton.className).toContain("@2xl/settings-panel:grid-cols-2");
    expect(skeleton.className).not.toContain("sm:grid-cols-2");
    view.unmount();

    mocks.organization = { data: ORGANIZATION, error: null };
    render(<OrganizationProfileCard />);

    const form = nameField().closest("form");
    expect(form?.className).toContain("@2xl/settings-panel:grid-cols-2");
    expect(form?.className).not.toContain("sm:grid-cols-2");

    const actionsRow = saveButton().closest("div");
    expect(actionsRow?.className).toContain("@2xl/settings-panel:col-span-2");
    expect(actionsRow?.className).not.toContain("sm:col-span-2");
  });
});

describe("SettingsDomainStatus contract", () => {
  it("keeps the failed-domain arm the card branches on", () => {
    expect(SettingsDomainStatus.Error).toBe("error");
  });
});
