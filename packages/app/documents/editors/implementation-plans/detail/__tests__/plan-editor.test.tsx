import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  PullRequestState,
  RepositoryRole,
} from "@repo/api/src/types/document";
import { PlanEditor } from "@repo/app/documents/editors/implementation-plans/detail/plan-editor";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ISS-6722: the editor's only test reference was a header sub-component, so
 * nothing covered the editor's OWN prop derivation. Asserting the shared
 * `DocumentEditorScaffold` rendered is a false green; it is covered elsewhere.
 * Everything below asserts a derived value.
 */

const useDocumentPullRequestMock = vi.fn();

type HeaderProps = {
  pullRequests: unknown;
};
const headerProps: HeaderProps[] = [];

// The scaffold is shared and separately covered. It is doubled here as a
// pass-through that invokes the editor's own render slots, which is the only
// way this editor's derived props become observable.
vi.mock("@repo/app/documents/components/document-editor-scaffold", () => ({
  DocumentEditorScaffold: ({
    renderHeader,
    detailsSections,
  }: {
    renderHeader: (ctx: unknown) => React.ReactNode;
    detailsSections: (ctx: { isDetailsActive: boolean }) => React.ReactNode;
  }) => (
    <div>
      {renderHeader({
        actions: { handleCopy: vi.fn(), handleDownload: vi.fn() },
        chrome: {
          openDeleteDialog: vi.fn(),
          openMoveDialog: vi.fn(),
          toggleMetadataPanel: vi.fn(),
        },
        contentController: { restoreVersion: vi.fn() },
        metadata: { status: DocumentStatus.Draft },
        session: { isViewingHistorical: false },
      })}
      {detailsSections({ isDetailsActive: true })}
    </div>
  ),
}));

vi.mock(
  "@repo/app/documents/editors/implementation-plans/detail/components/plan-editor-header",
  () => ({
    PlanEditorHeader: (props: HeaderProps) => {
      headerProps.push(props);
      return <div data-testid="plan-editor-header" />;
    },
  })
);

vi.mock(
  "@repo/app/documents/components/relationships/branches-section",
  () => ({ BranchesSection: () => null })
);

vi.mock("@repo/app/documents/components/use-comment-permalink-builder", () => ({
  useCommentPermalinkBuilder: () => vi.fn(),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentPullRequest: () => useDocumentPullRequestMock(),
}));

vi.mock(
  "@repo/app/documents/components/document-host-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/document-host-context")
    >()),
    useOrgSlug: () => "acme",
  })
);

vi.mock(
  "@repo/app/documents/editors/implementation-plans/detail/components/plan-context-section",
  () => ({
    PlanContextSection: () => null,
  })
);

describe("PlanEditor", () => {
  beforeEach(() => {
    headerProps.length = 0;
    useDocumentPullRequestMock.mockReset();
    useDocumentPullRequestMock.mockReturnValue({ data: undefined });
  });

  test("hands the header the plan's pull requests in the order they came back", () => {
    const pullRequests = [
      pullRequest({
        repoFullName: "acme/docs-site",
        headBranch: "docs-branch",
      }),
      pullRequest({ repoFullName: "acme/core", headBranch: "core-branch" }),
    ];
    useDocumentPullRequestMock.mockReturnValue({ data: pullRequests });

    render(<PlanEditor {...editorProps()} />, { wrapper: NavigationWrapper });

    expect(headerProps.at(-1)?.pullRequests).toEqual(pullRequests);
  });

  test("hands the header an empty list while the plan has no pull request", () => {
    render(<PlanEditor {...editorProps()} />, { wrapper: NavigationWrapper });

    // The header's list prop must still be an array, never the hook's
    // `undefined`; a header mapping over it would otherwise throw on a plan
    // whose PR query has not resolved.
    expect(headerProps.at(-1)?.pullRequests).toEqual([]);
  });
});

function pullRequest(overrides: {
  repoFullName: string;
  headBranch: string;
  state?: string;
}) {
  return {
    number: 1,
    state: overrides.state ?? PullRequestState.Open,
    title: "A pull request",
    url: "https://github.test/acme/core/pull/1",
    headBranch: overrides.headBranch,
    repoFullName: overrides.repoFullName,
  };
}

function editorProps() {
  return {
    currentVersion: 1,
    document: {
      id: "plan-1",
      slug: "PLN-1",
      title: "Ship it",
      type: DocumentType.ImplementationPlan,
      status: DocumentStatus.Draft,
      projectId: "project-1",
      project: { id: "project-1", teams: [{ id: "team-1" }] },
      repositorySnapshot: {
        repositories: [
          { fullName: "acme/docs-site", role: RepositoryRole.Additional },
          { fullName: "acme/core", role: RepositoryRole.Primary },
        ],
      },
    } as unknown as DocumentDetail,
    onVersionChange: vi.fn(),
  };
}

function NavigationWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <NavigationProvider adapter={createMemoryNavigation().adapter}>
      {children}
    </NavigationProvider>
  );
}
