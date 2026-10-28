import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

const LATEST_DRAFT_CONTENT =
  "The live draft, which is NOT the saved latestVersionContent.";
const SAVED_CONTENT = "The saved latest version.";

const mocks = vi.hoisted(() => ({
  contextSection: vi.fn((_props: { latestContent?: string }) => null),
  customFieldsSection: vi.fn(() => null),
}));

// The scaffold is shared and separately covered. It is doubled here as a
// pass-through that invokes `detailsSections` with a synthetic ScaffoldSlotContext,
// which is the only way this editor's derived props become observable.
vi.mock("@repo/app/documents/components/document-editor-scaffold", () => ({
  DocumentEditorScaffold: ({
    detailsSections,
  }: {
    detailsSections: (ctx: {
      latestContentForAttachmentWarnings: string;
      isDetailsActive: boolean;
    }) => ReactNode;
  }) => (
    <div>
      {detailsSections({
        latestContentForAttachmentWarnings: LATEST_DRAFT_CONTENT,
        isDetailsActive: true,
      })}
    </div>
  ),
}));

vi.mock(
  "@repo/app/documents/editors/issues/detail/components/context-section",
  () => ({
    ContextSection: mocks.contextSection,
  })
);

vi.mock(
  "@repo/app/documents/editors/issues/detail/components/issue-editor-header",
  () => ({
    IssueEditorHeader: () => null,
  })
);
vi.mock(
  "@repo/app/documents/editors/issues/detail/components/plan-section",
  () => ({ PlanSection: () => null })
);
vi.mock("@repo/app/custom-fields/components/custom-fields-section", () => ({
  CustomFieldsSection: mocks.customFieldsSection,
}));
vi.mock(
  "@repo/app/documents/components/relationships/branches-section",
  () => ({
    BranchesSection: () => null,
  })
);
vi.mock("@repo/app/documents/components/use-comment-permalink-builder", () => ({
  useCommentPermalinkBuilder: () => () => "",
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
vi.mock("@repo/app/documents/editors/issues/detail/use-issue-state", () => ({
  useIssueState: () => ({ hasPlan: false, linkedPlanId: null }),
}));

import { IssueEditor } from "@repo/app/documents/editors/issues/detail/issue-editor";

function makeFeature(): DocumentDetail {
  return {
    ...makeArtifact({ id: "feature-1", slug: "ISS-1", title: "Ship it" }),
    latestVersionContent: SAVED_CONTENT,
    version: { content: SAVED_CONTENT },
  } as unknown as DocumentDetail;
}

describe("IssueEditor attachment content wiring (ISS-8036)", () => {
  test("hands ContextSection the scaffold's attachment-warning content, not the saved body", () => {
    render(
      <IssueEditor
        currentVersion={1}
        document={makeFeature()}
        onVersionChange={vi.fn()}
      />,
      { wrapper: NavigationWrapper }
    );

    // The rail and the Context section must decide "does the body already render
    // this inline image?" from ONE derivation. Reading `latestVersionContent`
    // here instead would make the two disagree on an unsaved paste — the same
    // file hidden in one panel and listed in the other.
    expect(mocks.contextSection).toHaveBeenCalled();
    const props = mocks.contextSection.mock.calls.at(-1)?.[0];
    expect(props?.latestContent).toBe(LATEST_DRAFT_CONTENT);
    expect(props?.latestContent).not.toBe(SAVED_CONTENT);
    expect(mocks.customFieldsSection).toHaveBeenCalledWith(
      expect.objectContaining({ surface: ArtifactStatusEditSurface.Detail }),
      undefined
    );
  });
});

function NavigationWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <NavigationProvider adapter={createMemoryNavigation().adapter}>
      {children}
    </NavigationProvider>
  );
}
