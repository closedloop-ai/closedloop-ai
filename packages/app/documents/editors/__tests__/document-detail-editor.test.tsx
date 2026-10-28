import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import type { VersionedDocumentEditorProps } from "@repo/app/documents/components/versioned-document-editor-container";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-12855: one dispatcher picks the detail editor by the loaded document's
// type for both shells; a Template resolves through the shell's not-found
// action (PRD-799 "Template UI is absent").

const received = vi.hoisted(() => ({
  props: undefined as VersionedDocumentEditorProps | undefined,
}));

function leaf(testId: string) {
  return (props: VersionedDocumentEditorProps) => {
    received.props = props;
    return <div data-testid={testId} />;
  };
}

vi.mock("@repo/app/documents/editors/prds/detail/prd-editor", () => ({
  PRDEditor: leaf("prd-editor"),
}));
vi.mock(
  "@repo/app/documents/editors/implementation-plans/detail/plan-editor",
  () => ({ PlanEditor: leaf("plan-editor") })
);
vi.mock("@repo/app/documents/editors/issues/detail/issue-editor", () => ({
  IssueEditor: leaf("issue-editor"),
}));
vi.mock("@repo/app/documents/editors/documents/detail/document-editor", () => ({
  DocumentEditor: leaf("doc-editor"),
}));

import { DocumentDetailEditor } from "../document-detail-editor";

const NOT_FOUND = "NOT_FOUND";

function documentOf(type: DocumentType): DocumentDetail {
  return { id: "doc-1", slug: "DOC-1", type } as unknown as DocumentDetail;
}

afterEach(() => {
  received.props = undefined;
  vi.clearAllMocks();
});

describe("DocumentDetailEditor", () => {
  it.each([
    [DocumentType.Prd, "prd-editor"],
    [DocumentType.ImplementationPlan, "plan-editor"],
    [DocumentType.Feature, "issue-editor"],
    [DocumentType.Doc, "doc-editor"],
  ])("mounts the %s editor", (type, testId) => {
    const onNotFound = vi.fn((): never => {
      throw new Error(NOT_FOUND);
    });

    render(
      <DocumentDetailEditor
        currentVersion={1}
        document={documentOf(type)}
        onNotFound={onNotFound}
        onVersionChange={vi.fn()}
      />
    );

    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(onNotFound).not.toHaveBeenCalled();
  });

  it("calls onNotFound for a Template", () => {
    const onNotFound = vi.fn((): never => {
      throw new Error(NOT_FOUND);
    });

    expect(() =>
      render(
        <DocumentDetailEditor
          currentVersion={1}
          document={documentOf(DocumentType.Template)}
          onNotFound={onNotFound}
          onVersionChange={vi.fn()}
        />
      )
    ).toThrow(NOT_FOUND);
    expect(onNotFound).toHaveBeenCalled();
  });

  it("passes the document, version and version handler through to the editor", () => {
    const document = documentOf(DocumentType.Prd);
    const onVersionChange = vi.fn();

    render(
      <DocumentDetailEditor
        currentVersion={3}
        document={document}
        onNotFound={vi.fn((): never => {
          throw new Error(NOT_FOUND);
        })}
        onVersionChange={onVersionChange}
      />
    );

    expect(received.props).toEqual({
      currentVersion: 3,
      document,
      onVersionChange,
    });
  });
});
