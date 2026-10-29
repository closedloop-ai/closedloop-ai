// @vitest-environment jsdom

import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { IssuesIndexView } from "@repo/app/issues/components/issues-index-view";
import { selectionSentence } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { HeaderPrimaryAction } from "@repo/app/shared/components/header-primary-action";
import {
  createMockDocument,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../hooks/use-issues-index-read", () => ({
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
vi.mock("@repo/app/documents/components/table/documents-bulk-actions", () => ({
  useDocumentsBulkActionDescriptors: () => [],
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: () => vi.fn(),
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
vi.mock("../create-issue-modal", () => ({ CreateIssueModal: () => null }));
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
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
    listRead: undefined,
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

describe("IssuesIndexView selection reconciliation", () => {
  it("prunes a collapsed owner band and clears selection when filtering unmounts results", async () => {
    const user = userEvent.setup();
    render(<IssuesIndexView />);
    await user.click(screen.getByLabelText("Owner column options"));
    await user.click(screen.getByRole("menuitem", { name: "Group" }));
    selectIssue("issue-1");
    selectIssue("issue-2", true);
    await user.click(groupToggle(FIRST_OWNER_PATTERN));
    await user.click(groupToggle(FIRST_OWNER_PATTERN));
    expect(issueRow("issue-1")).toHaveAttribute("aria-selected", "false");
    expect(issueRow("issue-2")).toHaveAttribute("aria-selected", "true");

    await user.type(
      screen.getByRole("textbox", { name: "Filter items" }),
      "missing"
    );
    await waitFor(() =>
      expect(document.querySelector('[data-grid-row-id="issue-1"]')).toBeNull()
    );
    await user.clear(screen.getByRole("textbox", { name: "Filter items" }));
    expect(issueRow("issue-1")).toHaveAttribute("aria-selected", "false");
    expect(issueRow("issue-2")).toHaveAttribute("aria-selected", "false");
  });
});

describe("IssuesIndexView selection announcer", () => {
  it("mounts exactly one polite selection region, the shell's", () => {
    // ISS-12640: one persistent polite selection status per surface. The
    // Artifact List shell owns it; the Issues bulk actions add none.
    render(<IssuesIndexView />);
    selectIssue("issue-1");
    selectIssue("issue-2", true);

    const regions = document.querySelectorAll('output[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    // The announcement says exactly what the visible rail says.
    const railLabel = screen.getByRole("toolbar").getAttribute("aria-label");
    expect(railLabel).toBe(selectionSentence(2));
    expect(regions[0]?.textContent).toBe(railLabel);
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

describe("IssuesIndexView header action", () => {
  it("renders the shared header primary action, so its size matches every list page", () => {
    // ISS-13007: one page-chrome component owns the action's size.
    const reference = render(
      <HeaderPrimaryAction label="Reference" onClick={vi.fn()} />
    );
    const referenceClass = reference.getByRole("button").className;
    reference.unmount();
    render(<IssuesIndexView renderHeader={(action) => <div>{action}</div>} />);
    expect(screen.getByRole("button", { name: "Add issue" }).className).toBe(
      referenceClass
    );
  });
});
