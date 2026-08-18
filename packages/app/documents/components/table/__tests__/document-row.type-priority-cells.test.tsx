/**
 * Tests for the Type and Priority cells in DocumentRow:
 * - Type renders as a plain colored text label, not a filled badge (FEA-3947)
 * - On the My Issues view the Priority cell renders the compact icon but omits
 *   the "Medium" default text (FEA-3946); every other surface keeps the label
 * - The priority trigger always carries an accessible name
 */

import { Priority } from "@repo/api/src/types/common";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";

const EDIT_HANDLERS: RowEditHandlers = {
  onUpdatePriority: vi.fn(),
};

/** My Issues view — the only surface with the compact/label-omitting priority. */
const MY_TASKS_HANDLERS: RowEditHandlers = {
  onUpdatePriority: vi.fn(),
  surfaceVariant: "my-tasks",
};

afterEach(() => {
  cleanup();
});

describe("TypeCell — plain colored label (FEA-3947)", () => {
  it("renders the type label as plain text, not a filled badge", () => {
    const item: DocumentRowItem = { kind: "document", data: makeArtifact() };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[Col.Type]} />
    );

    // The PRD short label is rendered...
    expect(screen.getByText("PRD")).toBeInTheDocument();
    // ...but NOT as a DS Badge (filled badges are reserved for status).
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("carries the canonical type text color on the label", () => {
    const item: DocumentRowItem = { kind: "document", data: makeArtifact() };
    render(<DocumentRow item={item} visibleColumns={[Col.Type]} />);

    const label = screen.getByText("PRD");
    // PRD's canonical color is the blue text token (DOCUMENT_TYPE_COLORS).
    expect(label.className).toContain("text-blue-700");
  });
});

describe("PriorityCell — compact / omitted-when-default (FEA-3946)", () => {
  it("omits the 'Medium' text for the default priority on My Issues", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.Medium }),
    };
    render(
      <DocumentRow
        editHandlers={MY_TASKS_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    expect(screen.queryByText("Medium")).toBeNull();
  });

  it("keeps the 'Medium' label on the general table (not My Issues)", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.Medium }),
    };
    render(
      <DocumentRow
        editHandlers={EDIT_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

  it("still renders the compact priority icon for the default priority", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.Medium }),
    };
    const { container } = render(
      <DocumentRow
        editHandlers={MY_TASKS_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    // The PriorityIcon svg (its distinctive viewBox) stays as the compact
    // indicator even when the text label is suppressed.
    expect(
      container.querySelector('svg[viewBox="-2 -2 20 20"]')
    ).not.toBeNull();
  });

  it("shows the label for a non-default priority", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.Urgent }),
    };
    render(
      <DocumentRow
        editHandlers={MY_TASKS_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    expect(screen.getByText("Urgent")).toBeInTheDocument();
  });

  it("gives the priority trigger an accessible name even when the label is suppressed", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ priority: Priority.Medium }),
    };
    render(
      <DocumentRow
        editHandlers={MY_TASKS_HANDLERS}
        item={item}
        visibleColumns={[Col.Priority]}
      />
    );

    // The visible "Medium" text is dropped, so the button must still name the
    // current priority + action for screen-reader / voice-control users.
    expect(
      screen.getByRole("button", { name: "Priority: Medium" })
    ).toBeInTheDocument();
  });
});
