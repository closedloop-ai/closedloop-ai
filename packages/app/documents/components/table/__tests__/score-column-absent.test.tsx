/**
 * ISS-9548 — the artifact table has no Quality Score column, and cannot grow
 * one back.
 *
 * The column was deleted along with `score-cell.tsx` and the two suites that
 * exercised it. Deleting those was correct — the contract they covered is
 * retired, not relocated — but it would have left the removal itself
 * unasserted: nothing in the suite would fail if `DocumentColumn.Score` came
 * back. This file is that assertion, written the same three ways the sibling
 * `loop-column-absent.test.tsx` (ISS-5306) is, because the column could return
 * through three different doors:
 *  - the rendered HEADER, located by `data-column-id` (never by index — an
 *    index-based assertion silently drifted on a column reorder in #4480);
 *  - the rendered ROW, so the check runs with a row actually present and cannot
 *    pass merely because nothing rendered;
 *  - the column CONTRACT (`DocumentColumn` + its label map + the default sets),
 *    the door a new column has to come through before it can render anywhere.
 *
 * Scope note: the judge scores themselves are untouched and stay reachable in
 * Judges Analytics. Only the at-a-glance table column is gone, so this file
 * asserts nothing about them.
 */

import { render as renderWithNav } from "@repo/app/shared/test-fixtures/render-with-nav";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

// The table's cells consult feature flags; this suite is about column identity,
// not flag behavior, so resolve every flag to off rather than mount a provider.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(() => false),
  useFeatureFlagEnabledOptional: vi.fn(() => false),
  useFeatureFlagGate: vi.fn(() => ({ isEnabled: false, isLoading: false })),
  useFeatureFlagGateOptional: vi.fn(() => ({ enabled: false, isReady: true })),
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

// Rendered text is matched on the full phrase, never a bare /score/i: row text
// legitimately carries unrelated words containing "score", and a match on those
// would be a false failure — a defect of its own.
const QUALITY_SCORE_PATTERN = /quality\s*score/i;
// Column ids are compared exactly. The retired column's id was "score".
const SCORE_COLUMN_ID = "score";

afterEach(() => {
  cleanup();
});

describe("artifact table — Quality Score column is gone (ISS-9548)", () => {
  it("renders no Quality Score header while still rendering the other columns", () => {
    const { container } = render(
      <DocumentTableHeader
        onSort={vi.fn()}
        sortBy={null}
        sortDir="desc"
        visibleColumns={ALL_ARTIFACT_COLUMNS}
      />
    );

    const renderedColumnIds = Array.from(
      container.querySelectorAll("[data-column-id]")
    ).map((node) => node.getAttribute("data-column-id") ?? "");

    // Guard against a vacuous pass: the header really did render columns.
    expect(renderedColumnIds.length).toBeGreaterThan(1);
    expect(renderedColumnIds).toContain(DocumentColumn.Assignee);

    for (const columnId of renderedColumnIds) {
      expect(columnId).not.toBe(SCORE_COLUMN_ID);
    }
    expect(container.textContent ?? "").not.toMatch(QUALITY_SCORE_PATTERN);
  });

  it("renders a populated row with no score cell and no quality-score vocabulary", () => {
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

    // The cell ids, not just the text. The retired `ScoreCell` rendered a bare
    // percentage ("78%") and never the words "Quality Score", so a text-only
    // assertion here would pass with the real column back in place. The row
    // emits one `data-column-id` per rendered cell, which is what actually
    // closes this door.
    const renderedColumnIds = Array.from(
      container.querySelectorAll("[data-column-id]")
    ).map((node) => node.getAttribute("data-column-id") ?? "");
    expect(renderedColumnIds.length).toBeGreaterThan(1);
    for (const columnId of renderedColumnIds) {
      expect(columnId).not.toBe(SCORE_COLUMN_ID);
    }

    expect(container.textContent ?? "").not.toMatch(QUALITY_SCORE_PATTERN);
  });

  it("offers no Quality Score column through the column contract itself", () => {
    // A column has to exist here before any surface can render it, so this is
    // the upstream door — closing it closes every table at once.
    expect(Object.keys(DocumentColumn)).not.toContain("Score");
    for (const [column, label] of Object.entries(ARTIFACT_COLUMN_LABELS)) {
      expect(column).not.toBe(SCORE_COLUMN_ID);
      expect(label).not.toMatch(QUALITY_SCORE_PATTERN);
    }
    for (const column of [
      ...ALL_ARTIFACT_COLUMNS,
      ...PROJECT_DEFAULT_COLUMNS,
      ...MY_TASKS_DEFAULT_COLUMNS,
    ]) {
      expect(column).not.toBe(SCORE_COLUMN_ID);
    }
  });
});
