/**
 * ISS-8007 — the Pensero credential card.
 *
 * The contract worth pinning here is the SECURITY one: the token field is
 * write-only and never prefilled, and nothing the server sends can end up in an
 * input a client could read back. The flag gate that decides whether this card
 * renders at all lives in `api-keys-credential-cards.test.tsx`.
 */

import { PenseroRouteErrorCode } from "@repo/api/src/types/pensero-integration";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { SettingsPanelDataState } from "../../../lib/settings-panel-data-state";

const TOKEN = "tk_public:sk_secret4321";

const TOKEN_LABEL = /API token/i;
const ENDPOINT_LABEL = /API endpoint/i;
const STORED_TITLE = /Credential stored/i;
const NOT_STORED_TITLE = /No credential stored/i;
const PENSERO_FORBIDDEN =
  "That change needs an organization admin. The Pensero credential is unchanged.";
const ADMIN_ONLY_NOTICE = /Only organization admins can change/i;
const DEFAULT_ENDPOINT_NOTICE = /Using the default Pensero API endpoint/i;
const TEAMS_LABEL = /Pensero teams/i;
const ALL_TEAMS_NOTICE = /All teams/i;

/**
 * A blank message, built rather than written inline: Biome's `useErrorMessage`
 * rejects an inline whitespace-only literal, and the branch under test is
 * exactly "the failure carried no usable message".
 */
const BLANK_ERROR_MESSAGE = " ".repeat(3);
const TOKEN_LAST_FOUR = "4321";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  teamIdentifiersFlag: false,
  setCredential: vi.fn(),
  removeCredential: vi.fn(),
  setPending: false,
  removePending: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../../../../pensero/hooks/use-pensero-integration", () => ({
  usePenseroIntegrationInfo: () => mocks.info(),
  useSetPenseroCredential: () => ({
    mutateAsync: mocks.setCredential,
    isPending: mocks.setPending,
  }),
  useRemovePenseroCredential: () => ({
    mutateAsync: mocks.removeCredential,
    isPending: mocks.removePending,
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("../../../../../shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => mocks.teamIdentifiersFlag,
}));

import { PenseroCredentialCard } from "../pensero-credential-card";

const CONNECTED = {
  isSet: true,
  lastFour: TOKEN_LAST_FOUR,
  baseUrl: null,
  teamIdentifiers: [],
  setAt: "2026-01-01T00:00:00.000Z",
};

const NOT_CONNECTED = {
  isSet: false,
  lastFour: null,
  baseUrl: null,
  teamIdentifiers: [],
  setAt: null,
};

function tokenField(): HTMLInputElement {
  return screen.getByLabelText(TOKEN_LABEL) as HTMLInputElement;
}

function cardState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setPending = false;
  mocks.removePending = false;
  mocks.info.mockReturnValue({
    data: NOT_CONNECTED,
    error: null,
    isPending: false,
  });
  mocks.setCredential.mockResolvedValue(CONNECTED);
  mocks.removeCredential.mockResolvedValue({ deleted: true });
});

describe("the token is write-only", () => {
  /**
   * The positive sibling for the emptiness assertions below: without it, a card
   * that rendered no token field at all would satisfy every "field is empty"
   * test trivially.
   */
  it("renders an empty password field for an org with no credential", () => {
    render(<PenseroCredentialCard isAdmin />);

    const field = tokenField();
    expect(field).toBeInTheDocument();
    expect(field.type).toBe("password");
    expect(field.value).toBe("");
  });

  it("does not prefill the token field for an org that already has a credential", () => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(tokenField().value).toBe("");
  });

  it("shows the fingerprint as the only trace of the stored credential", () => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByText(`****${TOKEN_LAST_FOUR}`)).toBeInTheDocument();
    expect(screen.getByText(STORED_TITLE)).toBeInTheDocument();
  });

  /**
   * Booleans rather than `not.toContain(TOKEN)`: a containment matcher renders
   * its subject into stdout and the HTML report on failure, which would print a
   * credential on exactly the run where something went wrong.
   */
  it("clears the typed token from the field after a successful save", async () => {
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    expect(tokenField().value.length > 0).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setCredential).toHaveBeenCalledWith({
      token: TOKEN,
      baseUrl: null,
    });
    expect(tokenField().value === "").toBe(true);
  });
});

describe("an unreadable status is not reported as no credential", () => {
  /**
   * The positive sibling: a SUCCESSFUL read of an org with no credential must
   * still say so, otherwise "never claims not-stored" would pass trivially.
   */
  it("says no credential is stored when the read succeeds and finds none", () => {
    mocks.info.mockReturnValue({
      data: NOT_CONNECTED,
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByText(NOT_STORED_TITLE)).toBeInTheDocument();
  });

  it("renders the failed data-state screen when the read fails", () => {
    mocks.info.mockReturnValue({
      data: undefined,
      error: new ApiError("boom", 500),
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(cardState()).toBe(SettingsPanelDataState.Failed);
    expect(screen.queryByText(NOT_STORED_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(TOKEN_LABEL)).not.toBeInTheDocument();
  });

  it("hides the form and Disconnect while the admin read has failed", () => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });

    render(
      <PenseroCredentialCard
        accessState={SettingsPanelDataState.Failed}
        isAdmin
      />
    );

    expect(cardState()).toBe(SettingsPanelDataState.Failed);
    expect(screen.queryByLabelText(TOKEN_LABEL)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" })
    ).not.toBeInTheDocument();
  });
});

describe("a refused write gets the admin sentence, not a toast", () => {
  it("renders the Pensero forbidden alert when a save is refused with 403", async () => {
    const user = userEvent.setup();
    mocks.setCredential.mockRejectedValue(new ApiError("denied", 403));
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(PENSERO_FORBIDDEN)).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("toasts the server message, not the admin alert, for a 403 rollout refusal", async () => {
    // A rollout refusal reaches real admins, so "needs an organization admin"
    // would be false there.
    const user = userEvent.setup();
    mocks.setCredential.mockRejectedValue(
      new ApiError(
        "Pensero is not enabled for this organization",
        403,
        PenseroRouteErrorCode.RolloutDisabled
      )
    );
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Pensero is not enabled for this organization"
      )
    );
    expect(screen.queryByText(PENSERO_FORBIDDEN)).not.toBeInTheDocument();
  });

  it("closes the disconnect dialog and renders the alert when a disconnect is refused with 403", async () => {
    const user = userEvent.setup();
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });
    mocks.removeCredential.mockRejectedValue(new ApiError("denied", 403));
    render(<PenseroCredentialCard isAdmin />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect" })
    );

    expect(await screen.findByText(PENSERO_FORBIDDEN)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

describe("admin gating of the form", () => {
  it("offers the credential form to an admin", () => {
    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("hides the credential form from a non-admin", () => {
    render(<PenseroCredentialCard isAdmin={false} />);

    expect(screen.queryByLabelText(TOKEN_LABEL)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(ADMIN_ONLY_NOTICE)).toBeInTheDocument();
  });

  it("hides Disconnect from a non-admin even when a credential exists", () => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin={false} />);

    expect(
      screen.queryByRole("button", { name: "Disconnect" })
    ).not.toBeInTheDocument();
  });

  it("offers Disconnect to an admin when a credential exists", () => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(
      screen.getByRole("button", { name: "Disconnect" })
    ).toBeInTheDocument();
  });
});

describe("the base URL override", () => {
  /**
   * NOT tested here: that a whitespace-padded endpoint is trimmed. A
   * `type="url"` input is whitespace-sanitized by the platform (and by jsdom)
   * before the component's onChange fires, so no component-level test can
   * distinguish a trim from its absence — the assertion would be green either
   * way. That guarantee is enforced and tested at the route instead
   * (`apps/api/app/settings/pensero/__tests__/route.test.ts`), which is where
   * it has to hold for every client rather than just this one.
   */
  it("sends the entered https override", async () => {
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    fireEvent.change(screen.getByLabelText(ENDPOINT_LABEL), {
      target: { value: "https://pensero.example.com/api" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setCredential).toHaveBeenCalledWith({
      token: TOKEN,
      baseUrl: "https://pensero.example.com/api",
    });
  });

  it("sends null rather than an empty string when the field is left blank", async () => {
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setCredential).toHaveBeenCalledWith({
      token: TOKEN,
      baseUrl: null,
    });
  });

  it("says the deployment default is in use when no override is stored", () => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByText(DEFAULT_ENDPOINT_NOTICE)).toBeInTheDocument();
  });

  it("shows the stored override when one exists", () => {
    mocks.info.mockReturnValue({
      data: { ...CONNECTED, baseUrl: "https://pensero.example.com/api" },
      error: null,
      isPending: false,
    });

    render(<PenseroCredentialCard isAdmin />);

    expect(
      screen.getByText("https://pensero.example.com/api")
    ).toBeInTheDocument();
  });
});

describe("failures are surfaced, not swallowed", () => {
  it("shows the server's rejection reason verbatim so the admin can fix it", async () => {
    const user = userEvent.setup();
    mocks.setCredential.mockRejectedValue(
      new Error("Pensero base URL must be an absolute https:// URL")
    );
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Pensero base URL must be an absolute https:// URL"
    );
  });

  it("falls back to a generic message when the failure carries none", async () => {
    const user = userEvent.setup();
    mocks.setCredential.mockRejectedValue(new Error(BLANK_ERROR_MESSAGE));
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Failed to save the Pensero credential."
    );
  });

  it("keeps the typed token in the field when the save fails, so it is not retyped from scratch", async () => {
    const user = userEvent.setup();
    mocks.setCredential.mockRejectedValue(new Error("nope"));
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(tokenField().value.length > 0).toBe(true);
  });
});

/**
 * Save and Disconnect write the SAME row in opposite directions (#6030,
 * tamsinb). Before this, each was disabled only by its own `isPending`, so a
 * slow PUT could still be in flight while the admin confirmed a DELETE; the
 * DELETE could land first and the delayed upsert would then recreate the
 * credential the admin had just revoked.
 *
 * Every case here has a positive sibling in the idle case below, so a card that
 * rendered a permanently disabled button — or no button at all — could not
 * satisfy them.
 */
describe("a write in flight blocks the opposing write", () => {
  beforeEach(() => {
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });
  });

  it("offers both actions when nothing is in flight", async () => {
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
  });

  it("blocks Disconnect while a save is in flight", async () => {
    const user = userEvent.setup();
    mocks.setPending = true;
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);

    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  });

  it("blocks Save while a disconnect is in flight", async () => {
    const user = userEvent.setup();
    mocks.removePending = true;
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("save is not offered without a token", () => {
  it("disables Save until a token is entered", async () => {
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.type(tokenField(), TOKEN);
    expect(save).toBeEnabled();
  });

  it("does not treat whitespace as a token", async () => {
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), "   ");

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.setCredential).not.toHaveBeenCalled();
  });
});

/**
 * ISS-8761 — the team-identifiers field is gated CLOSED by its own PostHog key,
 * separate from the card's. The card gate is already on for whoever is in the
 * credential rollout, so reusing it would have shipped this field, on, to them.
 */
describe("team identifiers field (ISS-8761)", () => {
  it("renders no team field, and sends no team list, while the flag is off", async () => {
    mocks.teamIdentifiersFlag = false;
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    expect(screen.queryByLabelText(TEAMS_LABEL)).toBeNull();

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // OMITTED, not `[]`: with the input hidden the admin stated no intent, and
    // an empty array would silently clear a list they cannot currently see.
    expect(mocks.setCredential).toHaveBeenCalledWith({
      token: TOKEN,
      baseUrl: null,
    });
  });

  it("sends the parsed list, dropping blanks, while the flag is on", async () => {
    mocks.teamIdentifiersFlag = true;
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.type(
      screen.getByLabelText(TEAMS_LABEL),
      "Engineering, Platform,"
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setCredential).toHaveBeenCalledWith({
      token: TOKEN,
      baseUrl: null,
      teamIdentifiers: ["Engineering", "Platform"],
    });
  });

  it("reports an empty stored list as All teams, not as a missing value", () => {
    mocks.teamIdentifiersFlag = true;
    mocks.info.mockReturnValue({
      data: CONNECTED,
      error: null,
      isPending: false,
    });
    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByText(ALL_TEAMS_NOTICE)).toBeInTheDocument();
  });

  it("HYDRATES the field from the stored list rather than starting blank", () => {
    // whitlockk (#6492). Starting blank meant an admin who opened the card to
    // rotate a token — never touching this input — submitted `[]` and cleared a
    // narrowing they had not seen. Asserted before any typing, so the value can
    // only have come from `info`.
    mocks.teamIdentifiersFlag = true;
    mocks.info.mockReturnValue({
      data: { ...CONNECTED, teamIdentifiers: ["Engineering", "Platform"] },
      error: null,
      isPending: false,
    });
    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByLabelText(TEAMS_LABEL)).toHaveValue(
      "Engineering, Platform"
    );
  });

  it("round-trips the hydrated list unchanged when the admin edits only the token", async () => {
    // The teeth on the hydration above: hydrating the INPUT while still sending
    // the old blank-derived list would look identical on screen.
    mocks.teamIdentifiersFlag = true;
    mocks.info.mockReturnValue({
      data: { ...CONNECTED, teamIdentifiers: ["Engineering", "Platform"] },
      error: null,
      isPending: false,
    });
    const user = userEvent.setup();
    render(<PenseroCredentialCard isAdmin />);

    await user.type(tokenField(), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setCredential).toHaveBeenCalledWith({
      token: TOKEN,
      baseUrl: null,
      teamIdentifiers: ["Engineering", "Platform"],
    });
  });

  it("treats an ABSENT list from an older API as not-narrowed", () => {
    // The skew case the optional response field exists for: no `teamIdentifiers`
    // key at all must render as All teams, never as a crash or a blank claim.
    mocks.teamIdentifiersFlag = true;
    mocks.info.mockReturnValue({
      data: { ...CONNECTED, teamIdentifiers: undefined },
      error: null,
      isPending: false,
    });
    render(<PenseroCredentialCard isAdmin />);

    expect(screen.getByText(ALL_TEAMS_NOTICE)).toBeInTheDocument();
    expect(screen.getByLabelText(TEAMS_LABEL)).toHaveValue("");
  });
});
