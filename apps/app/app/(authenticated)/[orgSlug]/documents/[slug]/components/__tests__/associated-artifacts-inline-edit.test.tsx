import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { ISSUE_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ISS-8543 — the PRD detail children rows commit status, assignee and priority
 * in place.
 *
 * The assertion that carries this suite is the REFUSED write. A row that keeps
 * showing a value the server rejected is worse than the read-only row it
 * replaced, so "reverts on rejection" is tested as its own case rather than
 * inferred from the happy path passing.
 */

const mocks = vi.hoisted(() => ({
  useResolvedArtifactLinks: vi.fn(),
  useDeleteArtifactLink: vi.fn(),
  useOrganizationUsers: vi.fn(),
  useUpdateDocument: vi.fn(),
  updateMutateAsync: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/acme/prds/PRD-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "PRD-1" }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useResolvedArtifactLinks: mocks.useResolvedArtifactLinks,
  useDeleteArtifactLink: mocks.useDeleteArtifactLink,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useUpdateDocument: mocks.useUpdateDocument,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: mocks.useOrganizationUsers,
}));

// cmdk (the Command list inside UserSelectPopover) needs ResizeObserver, which
// jsdom does not implement.
class MockResizeObserver {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

import { AssociatedArtifactsSection } from "@repo/app/documents/editors/prds/detail/components/associated-artifacts-section";

const RE_ADA = /Ada/;
const RE_NO_ASSOCIATED_FEATURES = /No associated features yet/;
const RE_PRIORITY_CONTROL = /^Priority:/;
const PRD_ID = "prd-1";
const CHILD_ID = "iss-7495";

const KERENSA: BasicUser = {
  id: "user-kerensa",
  email: "kerensa.whitlock@closedloop.ai",
  firstName: "Kerensa",
  lastName: "Whitlock",
  avatarUrl: null,
};

const ADA: BasicUser = {
  id: "user-ada",
  email: "ada.lovelace@closedloop.ai",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};

function makeEndpoint(
  overrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkEndpoint {
  return {
    id: CHILD_ID,
    organizationId: "org-1",
    projectId: "project-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Feature,
    name: "Raise branch coverage",
    slug: "ISS-7495",
    status: IssueStatus.Todo,
    priority: Priority.Low,
    assigneeId: KERENSA.id,
    assignee: KERENSA,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeProducesLink(
  targetOverrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkWithEndpoints {
  const target = makeEndpoint(targetOverrides);
  return {
    id: `link-${target.id}`,
    organizationId: "org-1",
    sourceId: PRD_ID,
    targetId: target.id,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    source: makeEndpoint({
      id: PRD_ID,
      subtype: ArtifactSubtype.Prd,
      name: "The PRD",
      slug: "PRD-1",
    }),
    target,
  };
}

function renderSection() {
  return render(<AssociatedArtifactsSection prdId={PRD_ID} />);
}

describe("AssociatedArtifacts inline edit (ISS-8543)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeProducesLink()],
    });
    mocks.useDeleteArtifactLink.mockReturnValue({ mutate: vi.fn() });
    mocks.useOrganizationUsers.mockReturnValue({ data: [KERENSA, ADA] });
    mocks.useUpdateDocument.mockReturnValue({
      mutateAsync: mocks.updateMutateAsync,
    });
    mocks.updateMutateAsync.mockResolvedValue({});
  });

  test("every editable control sits above the row's stretched link", () => {
    // The title link paints `after:absolute after:inset-0` over the whole row,
    // so a control that does not raise itself above it is unreachable by mouse
    // — the click navigates to the child instead of opening the menu. jsdom has
    // no layout, so no click test can catch this: `userEvent.click` dispatches
    // straight at the element whatever is painted on top of it. Asserting the
    // stacking contract on the rendered control is the only guard available
    // here, and the literals are written out rather than read back from the
    // class constant they police.
    renderSection();

    for (const name of ["Todo", "Priority: Low", "Kerensa Whitlock"]) {
      const control = screen.getByRole("button", { name });
      const raised =
        control.classList.contains("z-10") || control.closest(".z-10") !== null;
      expect(
        raised,
        `the "${name}" control must sit above the row's stretched link`
      ).toBe(true);
    }
  });

  test("committing a status writes that status for that child", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Todo" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "In Progress" })
    );

    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
        id: CHILD_ID,
        status: IssueStatus.InProgress,
        surface: ArtifactStatusEditSurface.InlineCell,
      });
    });
    // The glyph now speaks the new status, so the write and the render agree.
    expect(
      screen.getByRole("button", { name: "In Progress" })
    ).toBeInTheDocument();
  });

  test("committing a priority writes that priority for that child", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Priority: Low" }));
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));

    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
        id: CHILD_ID,
        priority: Priority.Urgent,
        // ISS-9443: these rows go through `useArtifactRowEdit`, which now names
        // the surface it IS, so the priority telemetry event can be attributed
        // without the API guessing where the write came from.
        surface: ArtifactStatusEditSurface.InlineCell,
      });
    });
    expect(
      screen.getByRole("button", { name: "Priority: Urgent" })
    ).toBeInTheDocument();
  });

  // ISS-11198 (whitlockk review, PR #7924): guarded by the assignee it replaced.
  test("committing an assignee writes that assignee id for that child", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Kerensa Whitlock" }));
    await user.click(await screen.findByRole("option", { name: RE_ADA }));

    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
        id: CHILD_ID,
        assigneeId: ADA.id,
        expectedAssigneeId: KERENSA.id,
      });
    });
    expect(
      screen.getByRole("button", { name: "Ada Lovelace" })
    ).toBeInTheDocument();
  });

  test("a REFUSED status write puts the previous status back on the row", async () => {
    // The server rejects a status outside this artifact's vocabulary, which is
    // a real 400 from `PUT /documents/:id` (`statusOptionsForSubtype`), not a
    // synthetic failure.
    mocks.updateMutateAsync.mockRejectedValue(new Error("Status not valid"));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Todo" }));
    await user.click(await screen.findByRole("menuitem", { name: "Done" }));

    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalled();
    });
    // The row must not keep claiming a status the server refused …
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Todo" })).toBeInTheDocument();
    });
    // … and the refused value must be gone, not merely joined by the old one.
    expect(
      screen.queryByRole("button", {
        name: ISSUE_STATUS_LABELS[IssueStatus.Done],
      })
    ).not.toBeInTheDocument();
  });

  test("a REFUSED assignee write puts the previous assignee back on the row", async () => {
    mocks.updateMutateAsync.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Kerensa Whitlock" }));
    await user.click(await screen.findByRole("option", { name: RE_ADA }));

    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Kerensa Whitlock" })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Ada Lovelace" })
    ).not.toBeInTheDocument();
  });

  test("a roster that never arrives withholds ONLY the assignee picker", async () => {
    // Previously this case asserted the whole row went inert, which is the
    // behaviour ISS-8543's review found wrong: `/users` can fail as well as
    // load, and neither status nor priority ever needed the roster, so gating
    // all three on it left the feature silently dead for the page's lifetime
    // on a failed read. The expectation changed because the behaviour did.
    mocks.useOrganizationUsers.mockReturnValue({ data: undefined });
    const user = userEvent.setup();

    renderSection();

    // Status is live and commits …
    await user.click(screen.getByRole("button", { name: "Todo" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "In Progress" })
    );
    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
        id: CHILD_ID,
        status: IssueStatus.InProgress,
        surface: ArtifactStatusEditSurface.InlineCell,
      });
    });
    // … and so is priority.
    expect(
      screen.getByRole("button", { name: RE_PRIORITY_CONTROL })
    ).toHaveAttribute("aria-haspopup", "menu");

    // Only the picker is withheld, and the avatar it would have replaced keeps
    // BOTH the things that trigger costs: the assignee's name in the
    // accessibility tree, and the link to their profile.
    expect(
      screen.queryByRole("button", { name: "Kerensa Whitlock" })
    ).not.toBeInTheDocument();
    const avatar = screen.getByRole("img", { name: "Kerensa Whitlock" });
    expect(avatar.closest("a")).not.toBeNull();
  });

  test("two fast picks on one field reach the API in the order they were made", async () => {
    // The ledger orders what the ROW SHOWS and never sees the network, so
    // without a per-field write queue both PUTs go out at once and the server
    // may apply them in either order — leaving the row showing `Done` while the
    // database holds `In Progress`, until the next invalidation flips the row
    // back to a value the user had already replaced.
    const settle: Array<() => void> = [];
    mocks.updateMutateAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle.push(resolve);
        })
    );
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Todo" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "In Progress" })
    );
    await user.click(screen.getByRole("button", { name: "In Progress" }));
    await user.click(await screen.findByRole("menuitem", { name: "Done" }));

    // The second write is NOT in flight beside the first — that is the whole
    // fix, and it is what makes the arrival order at the server knowable.
    expect(mocks.updateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.updateMutateAsync).toHaveBeenNthCalledWith(1, {
      id: CHILD_ID,
      status: IssueStatus.InProgress,
      surface: ArtifactStatusEditSurface.InlineCell,
    });

    settle[0]();
    await waitFor(() => {
      expect(mocks.updateMutateAsync).toHaveBeenCalledTimes(2);
    });
    expect(mocks.updateMutateAsync).toHaveBeenNthCalledWith(2, {
      id: CHILD_ID,
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.InlineCell,
    });

    settle[1]();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    });
  });

  test("an endpoint with no joined assignee still names them from the roster", async () => {
    // Deploy skew: a pre-ISS-7732 `/artifact-links/resolved` omits the joined
    // user, and the adapter normalizes that absence to `assignee: null` while
    // PRESERVING `assigneeId`. Reading that `null` as the answer renders an
    // assigned artifact as "Unassigned" — the row lying about who owns the
    // work, with no current value for the picker to open on.
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeProducesLink({ assignee: undefined })],
    });

    renderSection();

    expect(
      await screen.findByRole("button", { name: "Kerensa Whitlock" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: UNASSIGNED_ASSIGNEE_LABEL })
    ).not.toBeInTheDocument();
  });

  test("a populated list mounts the roster fetch and the mutation", () => {
    // The edit wiring lives in a child of the body so the empty-list return
    // can render without either hook. This pins that a POPULATED list does
    // reach them, which is what the empty-list sibling below is measured
    // against.
    renderSection();

    expect(mocks.useOrganizationUsers).toHaveBeenCalled();
    expect(mocks.useUpdateDocument).toHaveBeenCalled();
  });

  test("an empty list renders the empty copy without the roster or mutation", () => {
    // The cost argument the retired flag used to carry now rests entirely on
    // this seam: no children means no roster fetch and no mutation subscribed.
    mocks.useResolvedArtifactLinks.mockReturnValue({ data: [] });

    renderSection();

    expect(screen.getByText(RE_NO_ASSOCIATED_FEATURES)).toBeInTheDocument();
    expect(mocks.useOrganizationUsers).not.toHaveBeenCalled();
    expect(mocks.useUpdateDocument).not.toHaveBeenCalled();
  });
});
