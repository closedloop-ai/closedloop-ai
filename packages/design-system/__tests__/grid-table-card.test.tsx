/**
 * The empty-value contract shared by the grid and its narrow-surface card
 * (ISS-6385). `isEmptyCellValue` is what makes a card drop a field instead of
 * stacking a blank "Model —" line, so it has to recognise the shared sentinel
 * in every shape it ships in — and it recognises nothing else, which is why a
 * surface that invents a second empty affordance has to teach this function
 * about it in the same change.
 */

import {
  buildGridTableCardHeaderFields,
  GridEmptyValue,
  GridTableCard,
  GridTableCardHeaderFields,
  isEmptyCellValue,
} from "@closedloop-ai/design-system/components/ui/grid-table-card";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const HEADER = <span>artifact-cells</span>;

afterEach(() => {
  cleanup();
});

describe("GridTableCard — empty fields are dropped, not stacked", () => {
  it("renders only the fields that have a value", () => {
    render(
      <GridTableCard
        fields={[
          { key: "owner", label: "Owner", value: "Ada Lovelace" },
          { key: "model", label: "Model", value: <GridEmptyValue /> },
          { key: "pr", label: "PR", value: null },
        ]}
        header={HEADER}
      />
    );

    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("PR")).not.toBeInTheDocument();
  });

  it("renders no field list at all when every field is empty", () => {
    const { container } = render(
      <GridTableCard
        fields={[
          { key: "model", label: "Model", value: <GridEmptyValue /> },
          { key: "pr", label: "PR", value: undefined },
        ]}
        header={HEADER}
      />
    );

    expect(screen.getByText("artifact-cells")).toBeInTheDocument();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("drops a sentinel that carries its own alignment and explanation", () => {
    render(
      <GridTableCard
        fields={[
          {
            key: "cost",
            label: "Cost",
            value: <GridEmptyValue alignEnd title="Not yet computed" />,
          },
        ]}
        header={HEADER}
      />
    );

    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
  });
});

describe("isEmptyCellValue — the sentinel, and only the sentinel", () => {
  it("recognises the shared sentinel however it is configured", () => {
    expect(isEmptyCellValue(<GridEmptyValue />)).toBe(true);
    expect(isEmptyCellValue(<GridEmptyValue alignEnd />)).toBe(true);
    expect(isEmptyCellValue(<GridEmptyValue title="Unavailable" />)).toBe(true);
  });

  it("recognises a cell that renders nothing", () => {
    expect(isEmptyCellValue(null)).toBe(true);
    expect(isEmptyCellValue(undefined)).toBe(true);
  });

  it("does not recognise a look-alike dash a surface rolled itself", () => {
    expect(isEmptyCellValue(<span>—</span>)).toBe(false);
    expect(isEmptyCellValue("—")).toBe(false);
  });

  it("does not treat a real value as empty", () => {
    expect(isEmptyCellValue("Ada Lovelace")).toBe(false);
    expect(isEmptyCellValue(0)).toBe(false);
    expect(isEmptyCellValue(<span>0</span>)).toBe(false);
  });
});

/**
 * ISS-5532 — a value a card promotes into its HEADER carries its own label.
 *
 * The card has no column header row, so a promoted value arrives anonymous; the
 * Agents card opened `Tool —`. These cover the primitive's half of that: the
 * pairing is a real `dt`/`dd` relationship (announced to assistive tech, WCAG
 * 1.3.1) rather than two adjacent spans, and the builder takes its terms from
 * the columns so a caller cannot restate a label that then drifts.
 */
describe("GridTableCardHeaderFields — promoted values are named", () => {
  it("pairs each value with its label as dt/dd", () => {
    const { container } = render(
      <GridTableCardHeaderFields
        fields={[{ key: "type", label: "Type", value: "Tool" }]}
      />
    );

    const term = screen.getByText("Type");
    expect(term.tagName).toBe("DT");
    // The pairing, not merely the presence of both strings: two adjacent spans
    // would satisfy a `getByText` pair while announcing nothing.
    expect(term.nextElementSibling?.tagName).toBe("DD");
    expect(term.nextElementSibling).toHaveTextContent("Tool");
    expect(container.querySelector("dl")).not.toBeNull();
  });

  it("drops an empty value together with its label", () => {
    const { container } = render(
      <GridTableCardHeaderFields
        fields={[
          { key: "type", label: "Type", value: "Tool" },
          { key: "metric", label: "LOC / $", value: <GridEmptyValue /> },
        ]}
      />
    );

    expect(screen.queryByText("LOC / $")).not.toBeInTheDocument();
    // Positive sibling for that absence: the list did render, and kept the
    // populated pair, so the miss is the empty field's own rather than an
    // unrendered component satisfying the query vacuously.
    expect(container.querySelector("dl")).not.toBeNull();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("drops a field with no label, whose value the header could not name", () => {
    // The one place this DIFFERS from the card body, which tolerates a blank
    // term. Naming is this component's whole job, so a `<dt></dt>` pair would
    // ship the anonymous value ISS-5532 exists to remove — and ship it announced
    // as a term/value pair, which is worse than not pairing it at all.
    const { container } = render(
      <GridTableCardHeaderFields
        fields={[
          { key: "type", label: "Type", value: "Tool" },
          { key: "actions", label: "", value: "menu" },
        ]}
      />
    );

    expect(screen.queryByText("menu")).not.toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(1);
    // Positive sibling: the labelled pair beside it did render, so the drop is
    // the blank term's own and not an unrendered component.
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("renders nothing at all when every field is empty", () => {
    const { container } = render(
      <GridTableCardHeaderFields
        fields={[{ key: "metric", label: "LOC / $", value: null }]}
      />
    );

    expect(container.querySelector("dl")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("buildGridTableCardHeaderFields — terms come from the columns", () => {
  const COLUMNS = [
    { id: "type", label: "Type" },
    { id: "metric", label: "LOC / $" },
    { id: "harness", label: "Harness" },
  ];

  it("selects the named ids, in the order named, with their column labels", () => {
    const fields = buildGridTableCardHeaderFields(
      COLUMNS,
      ["metric", "type"],
      (columnId: string, item: { id: string }) => `${item.id}:${columnId}`,
      { id: "row-1" }
    );

    expect(fields).toEqual([
      { key: "metric", label: "LOC / $", value: "row-1:metric" },
      { key: "type", label: "Type", value: "row-1:type" },
    ]);
  });

  it("skips an id the surviving column set no longer carries", () => {
    // A column the grid dropped must not resurface on the card, which stacks
    // and therefore never had the width problem that dropped it.
    const fields = buildGridTableCardHeaderFields(
      [{ id: "type", label: "Type" }],
      ["type", "metric"],
      () => "value",
      {}
    );

    expect(fields.map((field) => field.key)).toEqual(["type"]);
  });

  it("falls back to cardLabel for a label-less column", () => {
    const fields = buildGridTableCardHeaderFields(
      [{ id: "installed", label: "", cardLabel: "Installed" }],
      ["installed"],
      () => "value",
      {}
    );

    expect(fields[0]?.label).toBe("Installed");
  });
});
