import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import {
  SettingsDomainId,
  SettingsDomainStatus,
} from "@repo/api/src/types/settings-domain";
import {
  projectSettingsViewModel,
  SettingsViewModelStatus,
} from "@repo/api/src/types/settings-view-model";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import { buildCustomFieldFixture } from "../../../test-fixtures/governance-panel-fixtures";
import { CustomFieldsPanel } from "../custom-fields-panel";

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

// Recorded, not discarded: "the panel shows its own alert" is only half the
// contract; the other half is that the shared client's generic toast does not
// speak for the same outcome as well.
const toastCalls: { kind: string; message: string }[] = [];

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

// The create/edit dialog is its own already-covered component and mounts closed
// in every case here; stubbing it keeps these cases about the panel.
vi.mock(
  "../../../../../custom-fields/components/create-custom-field-dialog",
  () => ({ CreateCustomFieldDialog: () => null })
);

// Keeps its author id: these cases turn on the difference between a teammate
// who was not found and a teammate read that failed.
const FIELD = buildCustomFieldFixture();

const CREATE_FIELD_LABEL = "Create field";
const CANNOT_CHECK_TEXT = /couldn't check what you're allowed to change/i;
const AUTHORS_CAVEAT_RE = /field authors show as/i;
const UNKNOWN_AUTHOR_LABEL = "Unknown";
const UNAVAILABLE_AUTHOR_LABEL = "Unavailable";
const ACTIONS_MENU_LABEL = "Open actions menu";

function stubViewModelFor(role: SettingsActorRole) {
  responders.set("/settings/view-model", () =>
    Promise.resolve(
      projectSettingsViewModel({
        resolution: { role, status: SettingsActorRoleStatus.Resolved },
        staleSessionRole: false,
      })
    )
  );
}

function renderPanel() {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<CustomFieldsPanel />, { wrapper });
}

function panelState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
  responders.clear();
  // An empty teammate list, not a populated one: a resolved author renders a
  // `UserLink`, which needs a NavigationProvider this panel-level suite has no
  // reason to mount. What these cases care about is the difference between a
  // teammate who was not FOUND and a teammate read that FAILED.
  responders.set("/users", () => Promise.resolve([]));
  stubViewModelFor(SettingsActorRole.Admin);
});

describe("CustomFieldsPanel read states", () => {
  it("keeps loading, empty, refused, undecided and failed apart", async () => {
    // Five facts the legacy tab renders as three. Each gets its own screen, and
    // the attribute is asserted rather than the copy so the case fails if the
    // CLASSIFICATION changes, not merely the wording.
    responders.set("/custom-fields", () => new Promise(() => undefined));
    const loading = renderPanel();
    await waitFor(() => expect(panelState()).toBe("loading"));
    loading.unmount();

    responders.set("/custom-fields", () => Promise.resolve([]));
    const empty = renderPanel();
    await waitFor(() => expect(panelState()).toBe("empty"));
    empty.unmount();

    responders.set("/custom-fields", () =>
      Promise.reject(new ApiError("denied", 403))
    );
    const forbidden = renderPanel();
    await waitFor(() => expect(panelState()).toBe("forbidden"));
    forbidden.unmount();

    responders.set("/custom-fields", () =>
      Promise.reject(new ApiError("role unresolved", 503))
    );
    const unavailable = renderPanel();
    await waitFor(() => expect(panelState()).toBe("unavailable"));
    unavailable.unmount();

    responders.set("/custom-fields", () =>
      Promise.reject(new ApiError("boom", 500))
    );
    renderPanel();
    await waitFor(() => expect(panelState()).toBe("failed"));
  });

  it("keeps the FOUR author outcomes apart", async () => {
    // The em-dash belongs to exactly one of them. An earlier version gave it to
    // three, so a still-loading column and a former colleague both read as
    // "nobody created this" (#6638 review).
    responders.set("/custom-fields", () => Promise.resolve([FIELD]));

    // 1. Lookup still running — a skeleton, never an answer.
    responders.set("/users", () => new Promise(() => undefined));
    const pending = renderPanel();
    expect(await screen.findByText("Customer")).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_AUTHOR_LABEL)).not.toBeInTheDocument();
    expect(
      screen.queryByText(UNAVAILABLE_AUTHOR_LABEL)
    ).not.toBeInTheDocument();
    pending.unmount();

    // 2. Lookup settled and the author simply is not in the org any more.
    responders.set("/users", () => Promise.resolve([]));
    const former = renderPanel();
    expect(await screen.findByText(UNKNOWN_AUTHOR_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(AUTHORS_CAVEAT_RE)).not.toBeInTheDocument();
    former.unmount();

    // 3. Lookup FAILED — a different fact, and the panel says so.
    responders.set("/users", () => Promise.reject(new ApiError("boom", 500)));
    const failed = renderPanel();
    expect(
      await screen.findByText(UNAVAILABLE_AUTHOR_LABEL)
    ).toBeInTheDocument();
    expect(screen.getByText(AUTHORS_CAVEAT_RE)).toBeInTheDocument();
    failed.unmount();

    // 4. The field genuinely has no author — the one case the em-dash owns.
    responders.set("/users", () => Promise.resolve([]));
    responders.set("/custom-fields", () =>
      Promise.resolve([buildCustomFieldFixture({ createdById: null })])
    );
    renderPanel();
    expect(await screen.findByText("Customer")).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_AUTHOR_LABEL)).not.toBeInTheDocument();
  });
});

describe("CustomFieldsPanel write authorization", () => {
  it("shows a member the fields and offers them no write control", async () => {
    // The widening this panel deliberately makes: GET /custom-fields is open to
    // any member, so the read is theirs. POST/PUT/DELETE call isOrgAdmin, so
    // the controls are not.
    stubViewModelFor(SettingsActorRole.Member);
    responders.set("/custom-fields", () => Promise.resolve([FIELD]));

    renderPanel();

    expect(await screen.findByText("Customer")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CREATE_FIELD_LABEL })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ACTIONS_MENU_LABEL })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(CANNOT_CHECK_TEXT)).not.toBeInTheDocument();
  });

  it("offers an admin the write controls", async () => {
    responders.set("/custom-fields", () => Promise.resolve([FIELD]));

    renderPanel();

    expect(
      await screen.findByRole("button", { name: CREATE_FIELD_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ACTIONS_MENU_LABEL })
    ).toBeInTheDocument();
  });

  it("follows the domain's `edit` rung, not the `admin` role fact", async () => {
    // The two coincide for this domain TODAY, so no policy-derived fixture can
    // tell them apart — which is exactly why this hand-built projection does.
    // `SETTINGS_DOMAIN_ACCESS_POLICY[CustomFields].edit` is the rung that moves
    // if someone loosens the row to track a route change; `admin` is a role
    // fact that merely tracks it now. Gating on `admin` would leave this panel
    // behind while TagsPanel followed.
    responders.set("/settings/view-model", () =>
      Promise.resolve({
        actor: {
          role: SettingsActorRole.Member,
          staleSessionRole: false,
          status: SettingsActorRoleStatus.Resolved,
        },
        domains: {
          [SettingsDomainId.CustomFields]: {
            grants: { admin: false, edit: true, owner: false, read: true },
            status: SettingsDomainStatus.Ready,
          },
        },
        status: SettingsViewModelStatus.Ready,
      })
    );
    responders.set("/custom-fields", () => Promise.resolve([FIELD]));

    renderPanel();

    expect(
      await screen.findByRole("button", { name: CREATE_FIELD_LABEL })
    ).toBeInTheDocument();
  });

  it("says the capability read FAILED rather than passing it off as a member", async () => {
    // The case that matters most: an outage rendered as the member view is a
    // denial invented out of a failure, and the user has no way to tell.
    responders.set("/settings/view-model", () =>
      Promise.reject(new ApiError("boom", 500))
    );
    responders.set("/custom-fields", () => Promise.resolve([FIELD]));

    renderPanel();

    expect(await screen.findByText(CANNOT_CHECK_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CREATE_FIELD_LABEL })
    ).not.toBeInTheDocument();
  });
});

describe("CustomFieldsPanel destructive confirmation", () => {
  it("confirms before deleting, and reports a refused delete", async () => {
    const user = userEvent.setup();
    responders.set("/custom-fields", () => Promise.resolve([FIELD]));
    mockApiClient.delete.mockRejectedValue(new ApiError("denied", 403));

    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: ACTIONS_MENU_LABEL })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    // The confirmation stands between the menu item and the request.
    expect(await screen.findByText("Delete custom field")).toBeInTheDocument();
    expect(mockApiClient.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(
        "That change needs an organization admin. Nothing was changed."
      )
    ).toBeInTheDocument();
    // ONE message for one outcome: the shared client's generic "try again"
    // toast is suppressed for this panel, which owns its own sentences.
    expect(toastCalls).toEqual([]);
    // And the field is still there: a refused delete must not read as one that
    // took effect.
    expect(screen.getByText("Customer")).toBeInTheDocument();
  });
});
