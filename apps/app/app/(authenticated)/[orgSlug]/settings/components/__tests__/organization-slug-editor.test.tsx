import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  organizationReload: vi.fn().mockResolvedValue(undefined),
  sessionReload: vi.fn().mockResolvedValue(undefined),
  queryClientClear: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@repo/app/organizations/hooks/use-organizations", () => ({
  useUpdateOrganization: () => ({
    isPending: mocks.isPending,
    mutate: mocks.mutate,
  }),
}));

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({
    organization: { reload: mocks.organizationReload },
  }),
  useSession: () => ({
    session: { reload: mocks.sessionReload },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    clear: mocks.queryClientClear,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({
    replace: mocks.routerReplace,
    push: vi.fn(),
    back: vi.fn(),
  })),
  useParams: vi.fn(() => ({ orgSlug: "acme" })),
}));

import { OrganizationSlugEditor } from "../organization-slug-editor";

const DEFAULT_PROPS = {
  currentSlug: "acme",
  organizationId: "org-1",
  organizationName: "Acme",
};
const SAVE_BUTTON_NAME_PATTERN = /save/i;
const EDIT_BUTTON_NAME_PATTERN = /edit/i;
const CANCEL_BUTTON_NAME_PATTERN = /cancel/i;

async function enterEditMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: EDIT_BUTTON_NAME_PATTERN })
  );
}

describe("OrganizationSlugEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPending = false;
  });

  it("renders the current slug in read-only mode with an Edit button", () => {
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(
      screen.getByText("http://localhost:3000/acme/prds/...")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: EDIT_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    ).not.toBeInTheDocument();
  });

  it("enters edit mode when Edit is clicked", async () => {
    const user = userEvent.setup();
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);

    expect(screen.getByLabelText("Slug")).toHaveValue("acme");
    expect(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();
  });

  it("returns to read-only mode when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.click(
      screen.getByRole("button", { name: CANCEL_BUTTON_NAME_PATTERN })
    );

    expect(
      screen.getByRole("button", { name: EDIT_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
  });

  it.each(["api", "a"])("disables Save for invalid slug %s", async (slug) => {
    const user = userEvent.setup();
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), slug);

    expect(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    ).toBeDisabled();
  });

  it("normalizes input: lowercase, spaces to hyphens, strips non-alphanumeric, collapses consecutive hyphens", async () => {
    const user = userEvent.setup();
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "My Cool Org!");

    expect(screen.getByLabelText("Slug")).toHaveValue("my-cool-org");
  });

  it("updates the preview as the draft changes", async () => {
    const user = userEvent.setup();
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "new-acme");

    expect(
      screen.getByText("http://localhost:3000/new-acme/prds/...")
    ).toBeInTheDocument();
  });

  it("submits the slug and returns to read-only mode on success", async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation(
      (_variables: unknown, options: { onSuccess: (org: unknown) => void }) => {
        options.onSuccess({
          id: "org-1",
          name: "Acme",
          slug: "new-acme",
        });
      }
    );
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "new-acme");
    await user.click(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    );

    expect(mocks.mutate).toHaveBeenCalledWith(
      { id: "org-1", slug: "new-acme" },
      { onError: expect.any(Function), onSuccess: expect.any(Function) }
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Organization slug updated"
    );
    expect(
      screen.getByRole("button", { name: EDIT_BUTTON_NAME_PATTERN })
    ).toBeInTheDocument();
  });

  it("does not install a local error toast for non-conflict rejections", async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation(
      (_variables: unknown, options: { onError: (err: Error) => void }) => {
        options.onError(new Error("Network error"));
      }
    );
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "new-acme");
    await user.click(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    );

    expect(mocks.mutate).toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("disables Save while the mutation is pending", async () => {
    const user = userEvent.setup();
    mocks.isPending = true;
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "new-acme");

    expect(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    ).toBeDisabled();
  });

  it("shows inline conflict error when the slug is unavailable", async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation(
      (_variables: unknown, options: { onError: (err: ApiError) => void }) => {
        options.onError(new ApiError("Slug is unavailable", 409));
      }
    );
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "taken-slug");
    await user.click(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    );

    expect(screen.getByText("This slug is already taken")).toBeInTheDocument();
  });

  it("clears conflict error when the user edits the slug", async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation(
      (_variables: unknown, options: { onError: (err: ApiError) => void }) => {
        options.onError(new ApiError("Slug is unavailable", 409));
      }
    );
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "taken-slug");
    await user.click(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    );
    expect(screen.getByText("This slug is already taken")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "different-slug");
    expect(
      screen.queryByText("This slug is already taken")
    ).not.toBeInTheDocument();
  });

  it("reloads Clerk org and session, clears query cache, then navigates on slug change", async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation(
      (
        _variables: unknown,
        options: { onSuccess: (org: unknown) => Promise<void> }
      ) => {
        options.onSuccess({
          id: "org-1",
          name: "Acme",
          slug: "new-acme",
        });
      }
    );
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "new-acme");
    await user.click(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    );

    await vi.waitFor(() => {
      expect(mocks.organizationReload).toHaveBeenCalled();
    });
    expect(mocks.sessionReload).toHaveBeenCalled();
    expect(mocks.queryClientClear).toHaveBeenCalled();
    expect(mocks.routerReplace).toHaveBeenCalledWith("/new-acme/settings");
  });

  it("navigates even if Clerk reload fails, and still attempts session reload", async () => {
    const user = userEvent.setup();
    mocks.organizationReload.mockRejectedValueOnce(new Error("Clerk down"));
    mocks.mutate.mockImplementation(
      (
        _variables: unknown,
        options: { onSuccess: (org: unknown) => Promise<void> }
      ) => {
        options.onSuccess({
          id: "org-1",
          name: "Acme",
          slug: "new-acme",
        });
      }
    );
    render(<OrganizationSlugEditor {...DEFAULT_PROPS} />);

    await enterEditMode(user);
    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "new-acme");
    await user.click(
      screen.getByRole("button", { name: SAVE_BUTTON_NAME_PATTERN })
    );

    await vi.waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/new-acme/settings");
    });
    expect(mocks.sessionReload).toHaveBeenCalled();
    expect(mocks.queryClientClear).toHaveBeenCalled();
  });
});
