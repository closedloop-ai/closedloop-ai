import { Priority } from "@repo/api/src/types/common";
import {
  type ColumnCollapseContext,
  collapseUninformativeColumns,
} from "@repo/app/documents/components/table/column-collapse";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OTHER_USER = { ...TEST_USER, id: "user-2", firstName: "Grace" } as const;

function docRow(
  overrides: Parameters<typeof makeArtifact>[0]
): DocumentRowItem {
  return { kind: "document", data: makeArtifact(overrides) };
}

/**
 * Context where no row has a parent (the common empty case), with the constant
 * Assignee/Project rule opted in (the single-scope "My Issues" view).
 */
const NO_PARENT: ColumnCollapseContext = {
  hasParent: () => false,
  collapseConstantColumns: true,
};

/** Same context but with the constant rule off (the general artifacts table). */
const CONSTANT_RULE_OFF: ColumnCollapseContext = {
  hasParent: () => false,
  collapseConstantColumns: false,
};

const ALL_COLUMNS = [
  Col.Type,
  Col.Assignee,
  Col.Project,
  Col.Priority,
  Col.Parent,
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collapseUninformativeColumns — constant columns (FEA-3945)", () => {
  it("hides Assignee when every row has the same assignee", () => {
    const items = [
      docRow({ id: "a", assignee: TEST_USER }),
      docRow({ id: "b", assignee: TEST_USER }),
    ];
    const result = collapseUninformativeColumns(
      [Col.Assignee],
      items,
      NO_PARENT
    );
    expect(result).not.toContain(Col.Assignee);
  });

  it("keeps Assignee when it varies across rows", () => {
    const items = [
      docRow({ id: "a", assignee: TEST_USER }),
      docRow({ id: "b", assignee: OTHER_USER }),
    ];
    const result = collapseUninformativeColumns(
      [Col.Assignee],
      items,
      NO_PARENT
    );
    expect(result).toContain(Col.Assignee);
  });

  it("hides Project when every row shares the same project", () => {
    const project = { id: "project-1", name: "Mike's Workspace" };
    const items = [docRow({ id: "a", project }), docRow({ id: "b", project })];
    const result = collapseUninformativeColumns(
      [Col.Project],
      items,
      NO_PARENT
    );
    expect(result).not.toContain(Col.Project);
  });

  it("keeps Project when the list spans multiple projects", () => {
    const items = [
      docRow({ id: "a", project: { id: "project-1", name: "One" } }),
      docRow({ id: "b", project: { id: "project-2", name: "Two" } }),
    ];
    const result = collapseUninformativeColumns(
      [Col.Project],
      items,
      NO_PARENT
    );
    expect(result).toContain(Col.Project);
  });
});

describe("collapseUninformativeColumns — empty columns (FEA-3946)", () => {
  it("hides Parent when no row has a parent", () => {
    const items = [docRow({ id: "a" }), docRow({ id: "b" })];
    const result = collapseUninformativeColumns([Col.Parent], items, NO_PARENT);
    expect(result).not.toContain(Col.Parent);
  });

  it("keeps Parent when at least one row has a parent", () => {
    const items = [docRow({ id: "a" }), docRow({ id: "b" })];
    const context: ColumnCollapseContext = {
      hasParent: (id) => id === "b",
    };
    const result = collapseUninformativeColumns([Col.Parent], items, context);
    expect(result).toContain(Col.Parent);
  });

  it("hides Priority when every row is at the default (Medium)", () => {
    const items = [
      docRow({ id: "a", priority: Priority.Medium }),
      docRow({ id: "b", priority: Priority.Medium }),
    ];
    const result = collapseUninformativeColumns(
      [Col.Priority],
      items,
      NO_PARENT
    );
    expect(result).not.toContain(Col.Priority);
  });

  it("keeps Priority when a row carries a non-default priority", () => {
    const items = [
      docRow({ id: "a", priority: Priority.Medium }),
      docRow({ id: "b", priority: Priority.Urgent }),
    ];
    const result = collapseUninformativeColumns(
      [Col.Priority],
      items,
      NO_PARENT
    );
    expect(result).toContain(Col.Priority);
  });
});

describe("collapseUninformativeColumns — constant rule is opt-in (reviewer)", () => {
  it("keeps a constant Assignee when the constant rule is off (general table)", () => {
    const items = [
      docRow({ id: "a", assignee: TEST_USER }),
      docRow({ id: "b", assignee: TEST_USER }),
    ];
    const result = collapseUninformativeColumns(
      [Col.Assignee],
      items,
      CONSTANT_RULE_OFF
    );
    expect(result).toContain(Col.Assignee);
  });

  it("keeps a constant Project when the constant rule is off (general table)", () => {
    const project = { id: "project-1", name: "Mike's Workspace" };
    const items = [docRow({ id: "a", project }), docRow({ id: "b", project })];
    const result = collapseUninformativeColumns(
      [Col.Project],
      items,
      CONSTANT_RULE_OFF
    );
    expect(result).toContain(Col.Project);
  });

  it("still collapses an all-empty Parent column when the constant rule is off", () => {
    const items = [docRow({ id: "a" }), docRow({ id: "b" })];
    const result = collapseUninformativeColumns(
      [Col.Parent],
      items,
      CONSTANT_RULE_OFF
    );
    expect(result).not.toContain(Col.Parent);
  });
});

describe("collapseUninformativeColumns — single-row empty vs constant", () => {
  it("collapses an all-empty column even for a single filtered row", () => {
    const items = [docRow({ id: "a", priority: Priority.Medium })];
    const result = collapseUninformativeColumns(
      [Col.Parent, Col.Priority],
      items,
      NO_PARENT
    );
    expect(result).toEqual([]);
  });

  it("keeps constant Assignee/Project for a single row (trivially constant)", () => {
    const project = { id: "project-1", name: "One" };
    const items = [docRow({ id: "a", assignee: TEST_USER, project })];
    const result = collapseUninformativeColumns(
      [Col.Assignee, Col.Project],
      items,
      NO_PARENT
    );
    expect(result).toEqual([Col.Assignee, Col.Project]);
  });
});

describe("collapseUninformativeColumns — guards", () => {
  it("returns the input unchanged when there are no rows", () => {
    const result = collapseUninformativeColumns(ALL_COLUMNS, [], NO_PARENT);
    expect(result).toEqual(ALL_COLUMNS);
  });

  it("keeps columns with no collapse rule (e.g. Type) untouched", () => {
    const items = [
      docRow({ id: "a", assignee: TEST_USER }),
      docRow({ id: "b", assignee: TEST_USER }),
    ];
    const result = collapseUninformativeColumns([Col.Type], items, NO_PARENT);
    expect(result).toContain(Col.Type);
  });

  it("collapses the full My-Issues set to just Type on a single-scope page", () => {
    const project = { id: "project-1", name: "Mike's Workspace" };
    const items = [
      docRow({
        id: "a",
        assignee: TEST_USER,
        project,
        priority: Priority.Medium,
      }),
      docRow({
        id: "b",
        assignee: TEST_USER,
        project,
        priority: Priority.Medium,
      }),
    ];
    const result = collapseUninformativeColumns(ALL_COLUMNS, items, NO_PARENT);
    expect(result).toEqual([Col.Type]);
  });
});
