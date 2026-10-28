import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import { settingsViewModelKeys } from "../../../hooks/use-settings-view-model";
import { buildTagFixture } from "../../../test-fixtures/governance-panel-fixtures";
import { TagsPanel } from "../tags-panel";

type Responder = () => Promise<unknown>;

const responders = new Map<string, Responder>();

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn((path: string) => {
    const responder = responders.get(path);
    if (responder === undefined) {
      return Promise.reject(new Error(`unstubbed GET ${path}`));
    }
    return responder();
  }),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
};

vi.mock("../../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// Recorded, not discarded: the shared query client toasts every rejected
// mutation unless the hook opts out, so "the panel shows its own alert" is only
// half the contract. The other half is that nothing ELSE speaks for the same
// outcome, and a wholesale `vi.fn()` mock cannot see that.
const toastCalls: { kind: string; message: string }[] = [];

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

const TAG = buildTagFixture();

// NEUTRAL, not "needs an organization admin". There is no admin gate anywhere
// in `apps/api/app/tags`, so naming one would send the user after a permission
// nobody holds (ISS-8367 review, bha_p0_f3).
const REFUSED_WRITE_TEXT =
  "You aren't allowed to make that change. Nothing was changed.";
const ADMIN_REQUIRED_TEXT =
  "That change needs an organization admin. Nothing was changed.";
const DELETE_CONFIRMATION_RE = /remove the tag "Customer request"/;
const COLOR_PICKER_RE = /^Color:/;

function renderPanel() {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...render(<TagsPanel />, { wrapper }), queryClient };
}

function panelState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
  responders.clear();
  responders.set("/settings/view-model", () =>
    Promise.resolve(
      projectSettingsViewModel({
        resolution: {
          role: SettingsActorRole.Member,
          status: SettingsActorRoleStatus.Resolved,
        },
        staleSessionRole: false,
      })
    )
  );
});

describe("TagsPanel read states", () => {
  it("renders a FAILED read as failed, never as an empty tag list", async () => {
    // THE regression this panel exists for. The legacy tab reads
    // `const { data: tags = [] } = useTags()`, so this exact case renders an
    // empty table and tells the user their organization has no tags.
    responders.set("/tags", () => Promise.reject(new ApiError("boom", 500)));

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("failed"));
    expect(screen.queryByText("No tags yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps loading, empty, refused and undecided apart", async () => {
    responders.set("/tags", () => new Promise(() => undefined));
    const loading = renderPanel();
    await waitFor(() => expect(panelState()).toBe("loading"));
    loading.unmount();

    responders.set("/tags", () => Promise.resolve([]));
    const empty = renderPanel();
    await waitFor(() => expect(panelState()).toBe("empty"));
    expect(screen.getByText("No tags yet")).toBeInTheDocument();
    empty.unmount();

    responders.set("/tags", () => Promise.reject(new ApiError("denied", 403)));
    const forbidden = renderPanel();
    await waitFor(() => expect(panelState()).toBe("forbidden"));
    forbidden.unmount();

    responders.set("/tags", () =>
      Promise.reject(new ApiError("role unresolved", 503))
    );
    renderPanel();
    await waitFor(() => expect(panelState()).toBe("unavailable"));
  });
});

describe("TagsPanel first tag", () => {
  it("opens the create row from the EMPTY state, not just from a populated list", async () => {
    // The regression: `TagCreateRow` used to render only inside the `Ready`
    // branch, so an organization with zero tags clicked "Create tag", watched
    // the button disable itself, and got no input at all — it could not create
    // its first tag from this panel. The legacy tab it replaces has no such
    // dead end.
    const user = userEvent.setup();
    responders.set("/tags", () => Promise.resolve([]));

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Create tag" }));

    expect(
      await screen.findByRole("textbox", { name: "New tag name" })
    ).toBeInTheDocument();
  });
});

describe("TagsPanel write authorization", () => {
  it("offers no inline editor when the capability read FAILED", async () => {
    // The panel says "no editing controls are offered" in that state. The name
    // editor and the colour picker have to answer to the same grant, or the
    // sentence is false while two of the three write controls stay live.
    responders.set("/settings/view-model", () =>
      Promise.reject(new ApiError("boom", 500))
    );
    responders.set("/tags", () => Promise.resolve([TAG]));

    renderPanel();

    // The row renders — the name appears in both the Name cell and the preview
    // chip — but the Name cell is now static text, not the editor's button.
    expect((await screen.findAllByText(TAG.name)).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: TAG.name })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: COLOR_PICKER_RE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open actions menu" })
    ).not.toBeInTheDocument();
  });
});

describe("TagsPanel write outcomes", () => {
  it("reports a refused rename and leaves the old name standing", async () => {
    // The legacy tab fires this mutation and never looks at the result: the row
    // re-renders from server data, so the typed name simply vanishes with no
    // statement of why.
    const user = userEvent.setup();
    responders.set("/tags", () => Promise.resolve([TAG]));
    mockApiClient.patch.mockRejectedValue(new ApiError("denied", 403));

    renderPanel();

    await user.click(await screen.findByRole("button", { name: TAG.name }));
    const input = screen.getByRole("textbox", { name: "Rename tag" });
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    expect(await screen.findByText(REFUSED_WRITE_TEXT)).toBeInTheDocument();
    // And it must NOT claim an admin gate this domain does not have.
    expect(screen.queryByText(ADMIN_REQUIRED_TEXT)).not.toBeInTheDocument();
    // ONE message for one outcome. The shared client's default handler used to
    // toast "try again" alongside this alert — advice that cannot work for a
    // 403, and the #6392 double-message defect arriving one state over.
    expect(toastCalls).toEqual([]);
    expect(mockApiClient.patch).toHaveBeenCalledWith(`/tags/${TAG.id}`, {
      name: "Renamed",
    });
    // And the row still shows what the server actually holds.
    expect(screen.getByRole("button", { name: TAG.name })).toBeInTheDocument();
  });

  it("stays silent about a rename that never left the client", async () => {
    // An unchanged name is not a write, so there is nothing to report either
    // way. Without this the alert state could be set on every blur.
    const user = userEvent.setup();
    responders.set("/tags", () => Promise.resolve([TAG]));

    renderPanel();

    await user.click(await screen.findByRole("button", { name: TAG.name }));
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: TAG.name })).toBeInTheDocument()
    );
    expect(mockApiClient.patch).not.toHaveBeenCalled();
    expect(screen.queryByText(REFUSED_WRITE_TEXT)).not.toBeInTheDocument();
  });

  it("confirms before deleting, and reports a refused delete without losing the row", async () => {
    const user = userEvent.setup();
    responders.set("/tags", () => Promise.resolve([TAG]));
    mockApiClient.delete.mockRejectedValue(new ApiError("denied", 403));

    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Open actions menu" })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete tag" })
    );

    // The confirmation stands between the menu item and the request.
    expect(await screen.findByText(DELETE_CONFIRMATION_RE)).toBeInTheDocument();
    expect(mockApiClient.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    // Confirming actually runs the delete, and its refusal is reported rather
    // than swallowed — with the tag still on screen, because it was not deleted.
    expect(mockApiClient.delete).toHaveBeenCalledWith(`/tags/${TAG.id}`);
    expect(await screen.findByText(REFUSED_WRITE_TEXT)).toBeInTheDocument();
    expect((await screen.findAllByText(TAG.name)).length).toBeGreaterThan(0);
    expect(toastCalls).toEqual([]);
  });

  it("does not fire a second create when Enter is pressed twice", async () => {
    // Enter used to call `onSubmit` unguarded while the button carried its own
    // `disabled`, so a second press during an in-flight create sent a duplicate
    // request and answered with a duplicate-name error.
    const user = userEvent.setup();
    responders.set("/tags", () => Promise.resolve([]));
    mockApiClient.post.mockReturnValue(new Promise(() => undefined));

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Create tag" }));
    const input = await screen.findByRole("textbox", { name: "New tag name" });
    await user.type(input, "Beta{Enter}");
    await user.keyboard("{Enter}");

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
  });

  it("takes the open create row away when the grant is lost mid-flow", async () => {
    // The row is mounted above the read branch so an empty organization can
    // reach it. That must not outlive the grant: an access refetch that fails
    // while the row is open would otherwise leave a live name field and Create
    // button under an alert saying no editing controls are offered.
    const user = userEvent.setup();
    responders.set("/tags", () => Promise.resolve([TAG]));

    const { queryClient } = renderPanel();

    await user.click(await screen.findByRole("button", { name: "Create tag" }));
    expect(
      await screen.findByRole("textbox", { name: "New tag name" })
    ).toBeInTheDocument();

    responders.set("/settings/view-model", () =>
      Promise.reject(new ApiError("boom", 500))
    );
    await queryClient.refetchQueries({
      queryKey: settingsViewModelKeys.viewModel(),
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "New tag name" })
      ).not.toBeInTheDocument()
    );
  });
});
