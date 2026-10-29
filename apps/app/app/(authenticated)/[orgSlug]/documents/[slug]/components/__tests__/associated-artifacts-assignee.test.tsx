import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useResolvedArtifactLinks: vi.fn(),
  useDeleteArtifactLink: vi.fn(),
  deleteLinkMutate: vi.fn(),
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

import { AssociatedArtifactsSection } from "@repo/app/documents/editors/prds/detail/components/associated-artifacts-section";

const PRD_ID = "prd-1";

const KERENSA: BasicUser = {
  id: "user-kerensa",
  email: "kerensa.whitlock@closedloop.ai",
  firstName: "Kerensa",
  lastName: "Whitlock",
  avatarUrl: "https://img.example.test/kerensa.png",
};

function makeEndpoint(
  overrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkEndpoint {
  return {
    id: "iss-7495",
    organizationId: "org-1",
    projectId: "project-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Feature,
    name: "Raise branch coverage",
    slug: "ISS-7495",
    status: DocumentStatus.Draft,
    priority: null,
    assigneeId: null,
    assignee: null,
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

describe("AssociatedArtifacts assignee hydration (ISS-7732)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useResolvedArtifactLinks.mockReturnValue({ data: [] });
    mocks.useDeleteArtifactLink.mockReturnValue({
      mutate: mocks.deleteLinkMutate,
    });
    // ISS-8543 shipped to 100% and the gate is now retired, so every row on
    // this surface carries the picker. The roster is what decides whether the
    // picker mounts at all, so it is pinned here rather than left to a real
    // query: an absent roster would silently test the read-only fallback.
    mocks.useOrganizationUsers.mockReturnValue({ data: [KERENSA] });
    mocks.useUpdateDocument.mockReturnValue({
      mutateAsync: mocks.updateMutateAsync,
    });
  });

  test("renders the real assignee for a linked artifact that has one", () => {
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeProducesLink({ assigneeId: KERENSA.id, assignee: KERENSA })],
    });

    render(<AssociatedArtifactsSection prdId={PRD_ID} />);

    // The row is present, and it identifies WHO is assigned. On the editable
    // row that name lives on the picker trigger — the avatar inside it is
    // `decorative`, so the button is the row's only statement of identity in
    // the accessibility tree. The initials fallback is asserted alongside it
    // because either alone survives half the ISS-7732 regression: a button
    // named for the assignee over an avatar that painted nobody is still a row
    // that lost the identity it claims to show.
    expect(screen.getByText("ISS-7495")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Kerensa Whitlock" })
    ).toBeInTheDocument();
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(screen.getByText("K")).toBeInTheDocument();
  });

  test("renders the unassigned state for a genuinely unassigned artifact", () => {
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeProducesLink({ assigneeId: null, assignee: null })],
    });

    render(<AssociatedArtifactsSection prdId={PRD_ID} />);

    // Row still renders — this is what makes the absence assertion meaningful
    // rather than trivially true on a failed render.
    expect(screen.getByText("ISS-7495")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: UNASSIGNED_ASSIGNEE_LABEL })
    ).toBeInTheDocument();
    expect(screen.queryByText("KW")).not.toBeInTheDocument();
    // The unassigned avatar is genuinely RENDERED, not merely missing — this
    // separates "shows the unassigned state" from "dropped the avatar slot".
    expect(
      document.querySelectorAll('[data-slot="avatar-fallback"]')
    ).toHaveLength(1);
  });
});
