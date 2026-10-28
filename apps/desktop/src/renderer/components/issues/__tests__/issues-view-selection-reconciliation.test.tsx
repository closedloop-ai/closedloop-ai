import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import {
  createMockDocument,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesView } from "../issues-view";

const SECOND_USER = {
  ...TEST_USER,
  email: "grace@example.com",
  firstName: "Grace",
  id: "user-2",
  lastName: "Hopper",
};
const FIRST_OWNER_PATTERN = new RegExp(
  `${TEST_USER.firstName} ${TEST_USER.lastName}`
);
const ISSUES = [
  createMockDocument({
    assignee: TEST_USER,
    assigneeId: TEST_USER.id,
    id: "issue-1",
    slug: "ISS-1",
    status: IssueStatus.Backlog,
    title: "First issue",
    type: DocumentType.Feature,
    updatedAt: new Date("2026-10-18T00:00:00.000Z"),
  }),
  createMockDocument({
    assignee: SECOND_USER,
    assigneeId: SECOND_USER.id,
    id: "issue-2",
    slug: "ISS-2",
    status: IssueStatus.InProgress,
    title: "Second issue",
    type: DocumentType.Feature,
    updatedAt: new Date("2026-10-18T00:00:00.000Z"),
  }),
];

const read = vi.hoisted(() => vi.fn());
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
}));
vi.mock("@repo/app/issues/hooks/use-issues-index-read", () => ({
  useIssuesIndexRead: read,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: () => ({
    data: ISSUES,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useUpdateDocument: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock(
  "@repo/app/documents/hooks/use-favorite-artifact-ids",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/hooks/use-favorite-artifact-ids")
    >()),
    usePendingFavoriteArtifactIds: () => new Set<string>(),
  })
);
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [], isError: false, isLoading: false }),
  useIsFavoriteArtifact: () => false,
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/documents/hooks/use-related-sessions", () => ({
  useRelatedSessionsPage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@repo/app/shared/hooks/use-artifact-collaborators", () => ({
  useArtifactCollaborators: () => ({ data: undefined, isLoading: false }),
}));
vi.mock(
  "@repo/app/documents/components/documents-prototype-custom-fields",
  () => ({
    useDocumentsPrototypeCustomFields: () => ({
      columns: [],
      fields: [],
      renderCell: () => undefined,
      renderDialog: () => null,
    }),
    documentCustomFieldCreationValues: () => ({}),
  })
);
vi.mock("@repo/app/artifacts/components/artifact-summary", () => ({
  ArtifactSummary: () => null,
}));
vi.mock("@repo/app/artifacts/components/artifact-list-bulk-actions", () => ({
  ArtifactListBulkActions: () => null,
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: TEST_USER }),
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: () => [],
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    clearSort: vi.fn(),
    setSort: vi.fn(),
    sortBy: null,
    sortDir: "asc",
  }),
}));
vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: () => undefined,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (key: string) => key,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", async () => {
  const { useState } = await import("react");
  return {
    useViewStatePersistence: <Value,>(_key: string, initial: Value) => {
      const [value, setValue] = useState(initial);
      return [value, setValue, vi.fn()] as const;
    },
  };
});
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@repo/app/issues/components/create-issue-modal", () => ({
  CreateIssueModal: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: "authenticated", userId: "user-1" },
  }),
}));
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({ identity: { organizationSlug: "acme" } }),
}));
vi.mock("../../../shared-agent-sessions/use-web-app-origin", () => ({
  useWebAppOrigin: () => ({ origin: "https://app.closedloop.test" }),
}));
vi.mock("@closedloop-ai/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

let restoreWidth: (() => void) | undefined;

beforeEach(() => {
  restoreWidth = stubContainerWidthPx(1440);
  read.mockReturnValue({
    documents: ISSUES,
    isError: false,
    isFetching: false,
    isLoading: false,
    isServerPaged: false,
    isSummaryUnsettled: false,
    pagination: undefined,
    refetch: vi.fn(),
    searchAppliedUpstream: false,
    summaryParams: {},
  });
});

afterEach(() => {
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("Desktop Issues host selection reconciliation", () => {
  it("prunes group collapse and filter-empty selection through the shared index", async () => {
    render(<IssuesView />);
    openRadixMenu(screen.getByLabelText("Owner column options"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Group" }));
    selectIssue("issue-1");
    selectIssue("issue-2", true);
    fireEvent.click(groupToggle(FIRST_OWNER_PATTERN));
    fireEvent.click(groupToggle(FIRST_OWNER_PATTERN));
    expect(issueRow("issue-1").getAttribute("aria-selected")).toBe("false");
    expect(issueRow("issue-2").getAttribute("aria-selected")).toBe("true");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter items" }), {
      target: { value: "missing" },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-grid-row-id="issue-1"]')).toBeNull()
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Filter items" }), {
      target: { value: "" },
    });
    expect(issueRow("issue-1").getAttribute("aria-selected")).toBe("false");
    expect(issueRow("issue-2").getAttribute("aria-selected")).toBe("false");
  });
});

function issueRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-grid-row-id="${id}"]`);
  if (!row) {
    throw new Error(`Expected issue row ${id}`);
  }
  return row;
}

function selectIssue(id: string, additive = false): void {
  const cell = issueRow(id).querySelector<HTMLElement>(
    '[data-column-id="updated"]'
  );
  if (!cell) {
    throw new Error(`Expected selectable issue cell ${id}`);
  }
  fireEvent.click(cell, { ctrlKey: additive });
}

function groupToggle(name: RegExp): HTMLElement {
  const toggle = screen
    .getAllByRole("button", { name })
    .find((candidate) => candidate.hasAttribute("aria-expanded"));
  if (!toggle) {
    throw new Error(`Expected group toggle ${name.source}`);
  }
  return toggle;
}

function openRadixMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}
