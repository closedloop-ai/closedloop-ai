import { OrgPolicyField } from "@repo/app/settings/lib/org-policy-toggle-state";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSyncPolicyCard } from "../session-sync-policy-card";
import { TranscriptSearchCard } from "../transcript-search-card";

const mocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  useOrganization: vi.fn(),
  useUpdateOrganization: vi.fn(),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

vi.mock("@repo/app/organizations/hooks/use-organizations", () => ({
  useOrganization: mocks.useOrganization,
  useUpdateOrganization: mocks.useUpdateOrganization,
}));

const ORGANIZATION_ID = "org-1";

const CURRENT_USER = { id: "user-1", organizationId: ORGANIZATION_ID };

const DEFAULT_MUTATE = vi.fn();

const LOADING_RE = /loading settings/i;

const UNKNOWN_BADGE_LABEL = "Status unknown";

const SESSION_SYNC_HELP_RE = /stays on each member's machine/i;

const TRANSCRIPT_SEARCH_HELP_RE = /not just their titles/i;

const HELP_TEXT_RE_BY_FIELD: Record<string, RegExp> = {
  [OrgPolicyField.SessionSyncPolicyEnabled]: SESSION_SYNC_HELP_RE,
  [OrgPolicyField.SearchIncludeTranscripts]: TRANSCRIPT_SEARCH_HELP_RE,
};

const UNAVAILABLE_EXPLANATION_RE = /can't read this setting from the server/i;

const NOT_CONFIRMED_RE = /couldn't confirm that change saved/i;

const SAVE_ERROR_RE = /couldn't save that change/i;

/**
 * Both settings toggles ride the same optional-field contract (ISS-4624), so
 * the deploy-skew states are proven once against both cards.
 */
const CARDS = [
  {
    name: "SessionSyncPolicyCard",
    Component: SessionSyncPolicyCard,
    field: OrgPolicyField.SessionSyncPolicyEnabled,
    title: "Sync session data to the cloud",
  },
  {
    name: "TranscriptSearchCard",
    Component: TranscriptSearchCard,
    field: OrgPolicyField.SearchIncludeTranscripts,
    title: "Search session transcripts",
  },
] as const;

function settledOrganization(record: Record<string, boolean>) {
  return {
    data: { id: ORGANIZATION_ID, ...record },
    isLoading: false,
    error: null,
  };
}

describe.each(CARDS)("$name deploy-skew states", ({
  Component,
  field,
  title,
}) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useCurrentUser.mockReturnValue({
      data: CURRENT_USER,
      isLoading: false,
      error: null,
    });
    mocks.useOrganization.mockReturnValue(
      settledOrganization({ [field]: false })
    );
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
    });
  });

  it("renders the unavailable state when a previous API strips the field", () => {
    // Old/stripped-field shape: the org read settled, but this API build
    // predates the policy field so it never sent one.
    mocks.useOrganization.mockReturnValue(settledOrganization({}));

    render(<Component isAdmin />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_BADGE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_EXPLANATION_RE)).toBeInTheDocument();
    // The whole point: unavailable is not a confident OFF switch...
    expect(screen.queryByRole("switch")).toBeNull();
    // ...and it is not the loading state either.
    expect(screen.queryByText(LOADING_RE)).toBeNull();
  });

  it("renders a real switch, not the unavailable state, when the field is present", () => {
    mocks.useOrganization.mockReturnValue(
      settledOrganization({ [field]: false })
    );

    render(<Component isAdmin />);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false"
    );
    expect(screen.queryByText(UNKNOWN_BADGE_LABEL)).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_EXPLANATION_RE)).toBeNull();
  });

  it("keeps the loading state distinct from the unavailable state", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<Component isAdmin />);

    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_BADGE_LABEL)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("holds the loading card when the org query settles without data", () => {
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    render(<Component isAdmin />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_BADGE_LABEL)).toBeNull();
  });

  it("shows the unknown state instead of an endless spinner when the user has no organization", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
      error: null,
    });
    mocks.useOrganization.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    render(<Component isAdmin />);

    expect(screen.getByText(UNKNOWN_BADGE_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(LOADING_RE)).toBeNull();
  });

  it("keeps describing what the setting controls in the unknown state", () => {
    mocks.useOrganization.mockReturnValue(settledOrganization({}));

    render(<Component isAdmin />);

    expect(screen.getByText(HELP_TEXT_RE_BY_FIELD[field])).toBeInTheDocument();
  });

  it("reports a save whose response omits the field as not confirmed", () => {
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID },
    });

    render(<Component isAdmin />);

    expect(screen.getByRole("alert")).toHaveTextContent(NOT_CONFIRMED_RE);
  });

  it("reports a save whose response echoes a different value as not confirmed", () => {
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID, [field]: false },
    });

    render(<Component isAdmin />);

    expect(screen.getByRole("alert")).toHaveTextContent(NOT_CONFIRMED_RE);
  });

  it("stays silent when the response echoes the requested value", () => {
    mocks.useOrganization.mockReturnValue(
      settledOrganization({ [field]: true })
    );
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID, [field]: true },
    });

    render(<Component isAdmin />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("clears the warning once a follow-up read shows the requested value", () => {
    // The write landed but a stale replica answered without the field. The
    // refetched org proves it applied, so the card must not keep nagging.
    mocks.useOrganization.mockReturnValue(
      settledOrganization({ [field]: true })
    );
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID },
    });

    render(<Component isAdmin />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("holds the warning back while the follow-up read is still in flight", () => {
    mocks.useOrganization.mockReturnValue({
      ...settledOrganization({ [field]: false }),
      isFetching: true,
    });
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID },
    });

    render(<Component isAdmin />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prefers the transport failure message when the request itself failed", () => {
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: true,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: undefined,
    });

    render(<Component isAdmin />);

    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_ERROR_RE);
  });

  it("holds the requested value and keeps the switch disabled while the reread lands after the PUT settles", () => {
    // PUT has settled (isPending false) and the echo already confirmed the new
    // value, but the invalidated org query is still refetching and holds the
    // pre-write false. The switch must stay ON and disabled until the reread
    // catches up — following isPending alone would snap it back to false and
    // re-enable it mid-refetch.
    mocks.useOrganization.mockReturnValue({
      ...settledOrganization({ [field]: false }),
      isFetching: true,
    });
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID, [field]: true },
    });

    render(<Component isAdmin />);

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle).toBeDisabled();
  });

  it("re-enables the switch and follows the server once the reread agrees", () => {
    // The refetch landed with the requested value, so the write is confirmed:
    // the switch reflects the server and the control unlocks again.
    mocks.useOrganization.mockReturnValue(
      settledOrganization({ [field]: true })
    );
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [field]: true },
      data: { id: ORGANIZATION_ID, [field]: true },
    });

    render(<Component isAdmin />);

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle).toBeEnabled();
  });

  it("ignores a mutation whose variables belong to a different organization", () => {
    // Org switch without a remount: TanStack still holds the previous org's
    // pending true-write. This org's card must not read it as pending, must not
    // paint its switch ON, and must not surface a save warning for it.
    mocks.useOrganization.mockReturnValue(
      settledOrganization({ [field]: false })
    );
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: true,
      isError: false,
      variables: { id: "other-org", [field]: true },
      data: undefined,
    });

    render(<Component isAdmin />);

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a sibling field's echo when judging this card's save", () => {
    const siblingField =
      field === OrgPolicyField.SessionSyncPolicyEnabled
        ? OrgPolicyField.SearchIncludeTranscripts
        : OrgPolicyField.SessionSyncPolicyEnabled;
    mocks.useUpdateOrganization.mockReturnValue({
      mutate: DEFAULT_MUTATE,
      isPending: false,
      isError: false,
      variables: { id: ORGANIZATION_ID, [siblingField]: true },
      data: { id: ORGANIZATION_ID, [siblingField]: true },
    });

    render(<Component isAdmin />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
