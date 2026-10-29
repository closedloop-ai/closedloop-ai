import {
  ColumnAlignment,
  ColumnFieldKind,
  ColumnRegistryIssueCode,
  validateColumnDefinitions,
} from "@repo/design-system/lib/column-registry";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_COLUMN_REGISTRY,
  artifactColumnDefinitions,
  artifactColumns,
} from "../fixtures";

/**
 * ISS-9095 column contract item 1.
 *
 * The clean-set assertion below is NOT what catches a refused declaration:
 * `fixtures.ts` builds its registry at module scope, so a refusal throws while
 * this file's own import is still evaluating and no case in here ever runs. What
 * it pins is narrower and still worth pinning — that the shipped set is clean,
 * which is the precondition every story depends on. The rule ITSELF is covered
 * by the broken-copy case beside it, which is the only shape that can prove the
 * validator names the offending column rather than merely refusing the set.
 */
describe("artifactColumnDefinitions", () => {
  it("is a clean set today", () => {
    expect(validateColumnDefinitions([...artifactColumnDefinitions])).toEqual(
      []
    );
  });

  it("names the offending column when a declaration breaks its kind's policy", () => {
    // `Date` has no natural bands, so `COLUMN_KIND_POLICY` refuses `groupable`
    // on it. Asserted against a copy: the real set cannot carry this, because
    // carrying it would stop the module importing at all.
    const issues = validateColumnDefinitions(
      artifactColumnDefinitions.map((definition) =>
        definition.id === "updated"
          ? { ...definition, groupable: true }
          : definition
      )
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.columnId).toBe("updated");
    expect(issues[0]?.code).toBe(ColumnRegistryIssueCode.UnsupportedCapability);
  });

  it("reserves Custom for columns the reader invents, never a declared one", () => {
    // `kind` is required and union-typed, so an absent or off-union kind is a
    // `tsc` failure rather than a red test. What a declaration change CAN do is
    // reach for the escape hatch — every capability is permitted under `Custom`,
    // so a declared column taking it opts out of the policy silently.
    for (const definition of artifactColumnDefinitions) {
      expect(definition.kind).not.toBe(ColumnFieldKind.Custom);
    }
  });

  it("declares a default width for every column, so the track needs no second map", () => {
    for (const definition of artifactColumnDefinitions) {
      expect(definition.width?.default).toBeGreaterThan(0);
    }
  });
});

/**
 * The render prop is DERIVED, not authored beside the declarations. A column
 * added to one and not the other is what the old `GridTableV2Column[]` plus
 * `Record<string, number>` pair allowed; this pins that they cannot diverge.
 */
describe("artifactColumns", () => {
  it("carries exactly the declared columns, in declaration order", () => {
    expect(artifactColumns.map((column) => column.id)).toEqual(
      artifactColumnDefinitions.map((definition) => definition.id)
    );
  });

  it("resolves alignment from the kind, so Number columns right-align their header", () => {
    const creationCost = artifactColumns.find(
      (column) => column.id === "creationCost"
    );
    expect(creationCost?.align).toBe(ColumnAlignment.End);
  });

  it("aligns a Number column to the edge its own primitive can actually render", () => {
    // `creationCost` follows the kind: `TableNumberCell` right-aligns its value,
    // so the header agrees with it.
    expect(
      artifactColumns.find((column) => column.id === "creationCost")?.align
    ).toBe(ColumnAlignment.End);

    // `comments` and `lineChanges` override BACK to Start, and the mutation this
    // kills is dropping either override to "match the kind": both primitives
    // render their value from the start edge and cannot be told otherwise
    // (`TableCountCell` never reads `useTableCellAlignEnd`; `TableChangeCell`'s
    // figure row carries no justify), so a kind-default header there names a value
    // ~90px away on the majority of rows. Deleting these two is ISS-11328's job,
    // once the primitives can follow — not a declaration's.
    for (const columnId of ["comments", "lineChanges"]) {
      expect(
        artifactColumns.find((column) => column.id === columnId)?.align
      ).toBe(ColumnAlignment.Start);
    }
  });

  it("carries each column's declared capabilities onto the render prop", () => {
    const status = artifactColumns.find((column) => column.id === "status");
    expect(status?.sortable).toBe(true);
    expect(status?.filterable).toBe(true);
    expect(status?.groupable).toBe(true);
    const collaborators = artifactColumns.find(
      (column) => column.id === "collaborators"
    );
    expect(collaborators?.sortable).toBeFalsy();
    expect(collaborators?.groupable).toBeFalsy();
  });

  it("is keyed for lookup by the same ids the declarations carry", () => {
    for (const definition of artifactColumnDefinitions) {
      expect(ARTIFACT_COLUMN_REGISTRY.get(definition.id)?.label).toBe(
        definition.label
      );
    }
  });
});
