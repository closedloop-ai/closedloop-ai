// @vitest-environment jsdom

import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { DocumentsUniversalIndexView } from "@repo/app/documents/components/index/documents-universal-index-view";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  createMockDocument,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
const DOCUMENTS = [
  createMockDocument({
    assignee: TEST_USER,
    assigneeId: TEST_USER.id,
    id: "doc-1",
    slug: "DOC-1",
    status: DocumentStatus.Draft,
    title: "First document",
    type: DocumentType.Doc,
    updatedAt: new Date("2026-10-18T00:00:00.000Z"),
  }),
  createMockDocument({
    assignee: SECOND_USER,
    assigneeId: SECOND_USER.id,
    id: "doc-2",
    slug: "DOC-2",
    status: DocumentStatus.Approved,
    title: "Second document",
    type: DocumentType.Doc,
    updatedAt: new Date("2026-10-18T00:00:00.000Z"),
  }),
];

const enabledFlags = vi.hoisted(() => new Set<string>());
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: () => ({
    data: DOCUMENTS,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useDocumentsPage: () => ({
    data: undefined,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  }),
  useUpdateDocument: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock(
  "@repo/app/documents/hooks/use-documents-index-paging",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useDocumentsIndexPageClamp: () => undefined,
    useDocumentsIndexPaging: () => ({
      isPageSizeReady: true,
      offset: 0,
      page: 0,
      pageSize: 25,
      setPage: vi.fn(),
    }),
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
vi.mock(
  "@repo/app/documents/components/table/documents-bulk-actions",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/table/documents-bulk-actions")
    >()),
    DocumentsBulkActions: () => null,
    useDocumentsBulkActionDescriptors: () => [],
  })
);
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: () => vi.fn(),
}));
vi.mock("@repo/app/documents/components/index/documents-create-action", () => ({
  useDocumentsCreateAction: () => vi.fn(),
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: TEST_USER }),
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: () => [],
}));
vi.mock("@repo/app/shared/hooks/use-debounced-value", () => ({
  useDebouncedValue: <Value,>(value: Value) => value,
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
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

let restoreWidth: (() => void) | undefined;

beforeEach(() => {
  enabledFlags.clear();
  restoreWidth = stubContainerWidthPx(1440);
});

afterEach(() => {
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("DocumentsUniversalIndexView selection reconciliation", () => {
  it("prunes a collapsed owner band and clears selection when filtering unmounts results", async () => {
    const user = userEvent.setup();
    render(<DocumentsUniversalIndexView />, { wrapper: queryWrapper });
    await user.click(screen.getByLabelText("Owner column options"));
    await user.click(screen.getByRole("menuitem", { name: "Group" }));
    selectDocument("doc-1");
    selectDocument("doc-2", true);
    await user.click(groupToggle(FIRST_OWNER_PATTERN));
    await user.click(groupToggle(FIRST_OWNER_PATTERN));
    expect(documentRow("doc-1")).toHaveAttribute("aria-selected", "false");
    expect(documentRow("doc-2")).toHaveAttribute("aria-selected", "true");

    await user.type(
      screen.getByRole("textbox", { name: "Filter items" }),
      "missing"
    );
    await waitFor(() =>
      expect(document.querySelector('[data-grid-row-id="doc-1"]')).toBeNull()
    );
    await user.clear(screen.getByRole("textbox", { name: "Filter items" }));
    expect(documentRow("doc-1")).toHaveAttribute("aria-selected", "false");
    expect(documentRow("doc-2")).toHaveAttribute("aria-selected", "false");
  });
});

describe("DocumentsUniversalIndexView selection announcer", () => {
  it("mounts exactly one polite selection region with the bulk rail on", () => {
    // ISS-12640: one persistent polite selection status per surface. The
    // Artifact List shell owns it; the Documents rail inside it adds none.
    enabledFlags.add(ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY);
    render(<DocumentsUniversalIndexView />, { wrapper: queryWrapper });
    selectDocument("doc-1");
    selectDocument("doc-2", true);

    const regions = document.querySelectorAll('output[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent(TWO_SELECTED_PATTERN);
  });
});

function queryWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const TWO_SELECTED_PATTERN = /^2 \S+ selected$/;

function documentRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-grid-row-id="${id}"]`);
  if (!row) {
    throw new Error(`Expected document row ${id}`);
  }
  return row;
}

function selectDocument(id: string, additive = false): void {
  const cell = documentRow(id).querySelector<HTMLElement>(
    '[data-column-id="updated"]'
  );
  if (!cell) {
    throw new Error(`Expected selectable document cell ${id}`);
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
