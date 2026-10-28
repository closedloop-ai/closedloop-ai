/**
 * ISS-7732: the plan's parent-context row is the second caller of
 * `endpointToDocument` and carried the same defect as the PRD screen — every
 * parent artifact rendered as unassigned. The adapter unit test covers the
 * mapping; this covers the production wiring, so deleting the call site or
 * re-hardcoding the null here cannot leave the suite green.
 */
import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useResolvedArtifactLinks: vi.fn(),
  useCreateArtifactLink: vi.fn(),
  useDeleteArtifactLink: vi.fn(),
  useDocumentsByProject: vi.fn(),
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
  usePathname: () => "/acme/implementation-plans/PLN-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "PLN-1" }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useResolvedArtifactLinks: mocks.useResolvedArtifactLinks,
  useCreateArtifactLink: mocks.useCreateArtifactLink,
  useDeleteArtifactLink: mocks.useDeleteArtifactLink,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentsByProject: mocks.useDocumentsByProject,
}));

import { PlanContextSection } from "@repo/app/documents/editors/implementation-plans/detail/components/plan-context-section";

const PLAN_ID = "plan-1";
const PROJECT_ID = "project-1";

const DAVETH: BasicUser = {
  id: "user-daveth",
  email: "daveth.oakhurst@closedloop.ai",
  firstName: "Daveth",
  lastName: "Oakhurst",
  avatarUrl: null,
};

const USER_PROFILE_HREF = /^\/acme\/users\//;

/** Hrefs of the assignee-avatar profile links currently rendered. */
function assigneeProfileLinks(): string[] {
  return screen
    .queryAllByRole("link")
    .map((el) => el.getAttribute("href") ?? "")
    .filter((href) => USER_PROFILE_HREF.test(href));
}

function makeEndpoint(
  overrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkEndpoint {
  return {
    id: "fea-1",
    organizationId: "org-1",
    projectId: PROJECT_ID,
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Feature,
    name: "Parent Feature",
    slug: "FEA-1",
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

function makeParentLink(
  sourceOverrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkWithEndpoints {
  const source = makeEndpoint(sourceOverrides);
  return {
    id: `link-${source.id}`,
    organizationId: "org-1",
    sourceId: source.id,
    targetId: PLAN_ID,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    source,
    target: makeEndpoint({
      id: PLAN_ID,
      subtype: ArtifactSubtype.ImplementationPlan,
    }),
  };
}

describe("PlanContextSection parent assignee hydration (ISS-7732)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useResolvedArtifactLinks.mockReturnValue({ data: [] });
    mocks.useDocumentsByProject.mockReturnValue({ data: [] });
    mocks.useCreateArtifactLink.mockReturnValue({ mutate: vi.fn() });
    mocks.useDeleteArtifactLink.mockReturnValue({ mutate: vi.fn() });
  });

  test("renders the real assignee on the parent-context row", () => {
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeParentLink({ assigneeId: DAVETH.id, assignee: DAVETH })],
    });

    render(<PlanContextSection planId={PLAN_ID} projectId={PROJECT_ID} />);

    expect(screen.getByText("FEA-1")).toBeInTheDocument();
    expect(assigneeProfileLinks()).toEqual([`/acme/users/${DAVETH.id}`]);
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  test("renders the unassigned state for an unassigned parent", () => {
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeParentLink({ assigneeId: null, assignee: null })],
    });

    render(<PlanContextSection planId={PLAN_ID} projectId={PROJECT_ID} />);

    // Row still renders — keeps the absence assertion from being trivially
    // true on a failed render.
    expect(screen.getByText("FEA-1")).toBeInTheDocument();
    expect(assigneeProfileLinks()).toEqual([]);
    expect(screen.queryByText("DO")).not.toBeInTheDocument();
    // The unassigned avatar is genuinely RENDERED, not merely missing — this
    // separates "shows the unassigned state" from "dropped the avatar slot".
    // Asserted on the fallback, not the Avatar root: `TooltipTrigger asChild`
    // merges its own `data-slot` over the root's in the unassigned branch.
    expect(
      document.querySelectorAll('[data-slot="avatar-fallback"]')
    ).toHaveLength(1);
  });
});
