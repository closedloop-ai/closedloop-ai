import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
import { sectionIcon } from "@repo/app/documents/components/table/group-section-icon";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { render } from "@testing-library/react";
import { CircleDashedIcon, CircleHelpIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

describe("sectionIcon", () => {
  it("uses an unknown-status glyph for the null status band", () => {
    const unknown = render(
      sectionIcon({
        key: "status:unknown",
        label: "Unknown",
        mode: GroupByMode.Status,
        status: null,
      })
    );
    const icon = render(
      <CircleHelpIcon className="h-4 w-4 text-muted-foreground" />
    );

    expect(unknown.container.innerHTML).toBe(icon.container.innerHTML);
  });

  it("renders shared IN_REVIEW status groups with the canonical feature icon", () => {
    const section = render(
      sectionIcon({
        artifactType: DocumentType.Prd,
        key: DocumentStatus.InReview,
        label: "In Review",
        mode: GroupByMode.Status,
        status: DocumentStatus.InReview,
      })
    );
    const canonicalFeatureIcon = render(
      <IssueStatusIcon status={IssueStatus.InReview} />
    );

    expect(section.container.innerHTML).toBe(
      canonicalFeatureIcon.container.innerHTML
    );
  });

  it("renders distinct icons for unknown priority and no priority", () => {
    const unknown = render(
      sectionIcon({
        isUnknownPriority: true,
        key: "priority:value:BLOCKER",
        label: "Unknown priority",
        mode: GroupByMode.Priority,
        priority: null,
      })
    );
    const none = render(
      sectionIcon({
        isUnknownPriority: false,
        key: "priority:none",
        label: "No priority",
        mode: GroupByMode.Priority,
        priority: null,
      })
    );
    const expectedUnknown = render(
      <CircleHelpIcon className="h-4 w-4 text-muted-foreground" />
    );
    const expectedNone = render(
      <CircleDashedIcon className="h-4 w-4 text-muted-foreground" />
    );

    expect(unknown.container.innerHTML).toBe(
      expectedUnknown.container.innerHTML
    );
    expect(none.container.innerHTML).toBe(expectedNone.container.innerHTML);
    expect(unknown.container.innerHTML).not.toBe(none.container.innerHTML);
  });

  it("routes Doc status groups through the document vocabulary", () => {
    const section = render(
      sectionIcon({
        artifactType: DocumentType.Doc,
        key: DocumentStatus.Draft,
        label: "Draft",
        mode: GroupByMode.Status,
        status: DocumentStatus.Draft,
      })
    );
    const documentIcon = render(
      <DocumentStatusIcon status={DocumentStatus.Draft} />
    );

    expect(section.container.innerHTML).toBe(documentIcon.container.innerHTML);
  });
});
