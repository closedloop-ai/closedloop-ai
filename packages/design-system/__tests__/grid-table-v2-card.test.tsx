import { GridEmptyValue } from "@closedloop-ai/design-system/components/ui/grid-table-card";
import {
  buildGridTableV2CardFields,
  GridTableV2Card,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2-card";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const HEADER = <span>Branch identity</span>;

afterEach(() => {
  cleanup();
});

describe("GridTableV2Card empty-field policy", () => {
  it("names a blank-label selected field from its column ariaLabel", () => {
    const fields = buildGridTableV2CardFields(
      [{ id: "actions", label: " ", ariaLabel: "Actions" }],
      new Set<string>(),
      () => "Open",
      { id: "row-1" }
    );
    render(
      <GridTableV2Card fields={fields} header={HEADER} preserveEmptyFields />
    );

    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("keeps the established default that omits empty fields", () => {
    const { container } = render(
      <GridTableV2Card
        fields={[
          { key: "owner", label: "Owner", value: "Ada" },
          { key: "sessions", label: "Linked sessions", value: null },
          { key: "pr", label: "Pull request", value: <GridEmptyValue /> },
        ]}
        header={HEADER}
      />
    );

    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByText("Linked sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Pull request")).not.toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(1);
  });

  it("preserves every selected field with the shared empty-value treatment", () => {
    const { container } = render(
      <GridTableV2Card
        fields={[
          { key: "owner", label: "Owner", value: "Ada" },
          { key: "sessions", label: "Linked sessions", value: null },
          { key: "collaborators", label: "Collaborators", value: undefined },
          {
            key: "pr",
            label: "Pull request",
            value: <GridEmptyValue title="No associated pull request" />,
          },
        ]}
        header={HEADER}
        preserveEmptyFields
      />
    );

    expect(container.querySelectorAll("dt")).toHaveLength(4);
    expect(container.querySelectorAll("dd")).toHaveLength(4);
    expect(
      container.querySelectorAll('[data-slot="grid-empty-value"]')
    ).toHaveLength(3);
    expect(screen.getByTitle("No associated pull request")).toBeInTheDocument();
  });
});
