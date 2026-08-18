/**
 * ISS-5306 — the artifact table has no Loops column, and cannot grow one back.
 *
 * `#4467` removed the column and deleted `loop-cell.tsx` along with the tests
 * that exercised it. That left the removal itself unasserted: nothing in the
 * suite would have failed if a Loops column were reintroduced, which is exactly
 * the state ISS-5306's acceptance ("a test asserts the column is absent rather
 * than merely that the table renders") calls out. This file is that assertion.
 *
 * It is deliberately written three ways, because a Loops column could come back
 * through three different doors:
 *  - the rendered HEADER, located by accessible name (never by index — an
 *    index-based assertion silently drifted on a column reorder in #4480);
 *  - the rendered ROW, so the check runs with rows actually present and cannot
 *    pass merely because nothing rendered;
 *  - the column CONTRACT (`DocumentColumn` + its label map + the default sets),
 *    which is the door a new column has to come through before it can render.
 *
 * Scope note: `loops/usage/components/loop-usage-tables.tsx` still has a
 * `<TableHead>Loops</TableHead>`. That is the Loops **usage report**, where the
 * loop count is the subject of the page, not an artifact table — ISS-5306
 * leaves it alone on purpose and this file does not assert against it.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render as renderWithNav } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

// The table's cells consult feature flags; this suite is about column identity,
// not flag behavior, so resolve every flag to off rather than mount a provider.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(() => false),
  useFeatureFlagGate: vi.fn(() => ({ isEnabled: false, isLoading: false })),
}));

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { DocumentTableHeader } from "@repo/app/documents/components/table/table-header";
import {
  ALL_ARTIFACT_COLUMNS,
  ARTIFACT_COLUMN_LABELS,
  DocumentColumn,
  MY_TASKS_DEFAULT_COLUMNS,
  PROJECT_DEFAULT_COLUMNS,
} from "@repo/app/shared/hooks/use-column-visibility";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";

const LOOP_PATTERN = /loop/i;

afterEach(() => {
  cleanup();
});

describe("artifact table — Loops column is gone (ISS-5306)", () => {
  it("renders no Loops column header while still rendering the other columns", () => {
    const { container } = render(
      <DocumentTableHeader
        onSort={vi.fn()}
        sortBy={null}
        sortDir="desc"
        visibleColumns={ALL_ARTIFACT_COLUMNS}
      />
    );

    // Columns are located by their `data-column-id`, never by position: an
    // index-based assertion silently drifted on a column reorder in #4480.
    const renderedColumnIds = Array.from(
      container.querySelectorAll("[data-column-id]")
    ).map((node) => node.getAttribute("data-column-id") ?? "");

    // Guard against a vacuous pass: the header really did render columns.
    expect(renderedColumnIds.length).toBeGreaterThan(1);
    expect(renderedColumnIds).toContain(DocumentColumn.Assignee);

    for (const columnId of renderedColumnIds) {
      expect(columnId).not.toMatch(LOOP_PATTERN);
    }
    expect(container.textContent ?? "").not.toMatch(LOOP_PATTERN);
  });

  it("renders a populated row with no loop cell and no loop vocabulary", () => {
    const item: DocumentRowItem = {
      data: makeArtifact({ title: "Quarterly rollout PRD" }),
      kind: "document",
    };

    const { container } = renderWithNav(
      <DocumentRow item={item} visibleColumns={ALL_ARTIFACT_COLUMNS} />
    );

    // The row is genuinely present — without this the absence check below
    // would hold for an empty render just as well.
    expect(screen.getByText("Quarterly rollout PRD")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(LOOP_PATTERN);
  });

  it("offers no Loops column through the column contract itself", () => {
    // A column has to exist here before any surface can render it, so this is
    // the upstream door — closing it closes every table at once.
    expect(Object.keys(DocumentColumn)).not.toContain("Loop");
    for (const [column, label] of Object.entries(ARTIFACT_COLUMN_LABELS)) {
      expect(column).not.toMatch(LOOP_PATTERN);
      expect(label).not.toMatch(LOOP_PATTERN);
    }
    for (const column of [
      ...ALL_ARTIFACT_COLUMNS,
      ...PROJECT_DEFAULT_COLUMNS,
      ...MY_TASKS_DEFAULT_COLUMNS,
    ]) {
      expect(column).not.toMatch(LOOP_PATTERN);
    }
  });
});
