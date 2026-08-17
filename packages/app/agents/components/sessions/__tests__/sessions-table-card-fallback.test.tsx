import { SessionRepositoryDisplayKind } from "@repo/app/agents/lib/session-repository-label";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

// FEA-3865: the GridTable card fallback. `mode` is threaded through from the
// caller; `compact` forces the card list and `expanded` forces the grid, so the
// selection is testable in jsdom without a real container-width measurement.
// `auto` (the default) measures the container and picks one layout at runtime —
// covered by the 360px Playwright spec, not here.

// ISS-4586: the fixture's canonical session status is "active" → "Active" badge.
// ("working" is an AGENT status; as a session value it now folds to Inactive.)
const ROW: SessionTableRow = createSessionTableRowFixture({
  branch: "feature/auth-guard",
  model: "opus-4.8",
  repo: "acme/app",
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

describe("SessionsTable card fallback (FEA-3865)", () => {
  it("renders a card per row with status in the header and columns as a key/value body in compact mode", () => {
    render(
      <SessionsTable items={[ROW]} mode="compact" renderName={renderName} />
    );

    // The card header carries the name link + the status badge.
    expect(
      screen.getByRole("link", { name: "agent/refactor-auth-guard" })
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();

    // The body is a definition list: each visible column is a `<dt>` label +
    // `<dd>` value. Status leads the header, so it is not repeated as a body
    // label. The `<dt>`/`<dd>` pairing is what a screen reader announces.
    const repoLabel = screen.getByText("Repository");
    expect(repoLabel.tagName).toBe("DT");
    const costLabel = screen.getByText("Cost");
    expect(costLabel.tagName).toBe("DT");
    const costValue = costLabel.nextElementSibling as HTMLElement;
    expect(costValue.tagName).toBe("DD");
    expect(within(costValue).getByText("$4.12")).toBeInTheDocument();
  });

  it("renders the grid, not cards, in expanded mode", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );

    // The grid renders its column header labels; the card body definition list
    // does not exist.
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(
      screen.queryByRole("term", { name: "Cost" })
    ).not.toBeInTheDocument();
  });

  it("drops columns that render empty from the card body instead of listing dash lines", () => {
    // A session with no branch, PR, or model — each of those cells renders the
    // shared em-dash empty-value. In a card those must NOT appear as "Branch —",
    // "Model —" lines (that reads as a broken card); the card shows only the
    // columns that carry a real value. ISS-4996 brought Repository into that
    // same rule for an ABSENT remote; only a MALFORMED stored value still keeps
    // a word, and therefore a card row — see the two assertions below.
    const sparseRow: SessionTableRow = {
      ...ROW,
      id: "ses-sparse",
      repo: null,
      branch: null,
      model: null,
      pullRequestSummaryLabel: null,
      mergeStatusLabel: null,
    };
    render(
      <SessionsTable
        items={[sparseRow]}
        mode="compact"
        renderName={renderName}
      />
    );

    // Columns with real values still render as `<dt>` labels…
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    // …but the em-dash empty-rendering columns are omitted entirely, no dash line.
    expect(screen.queryByText("Linked branches")).not.toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
  });

  it("drops the Repository row from the card when no remote was ever resolved (ISS-4996)", () => {
    // FEA-4274 kept a "Repository: Unknown" card row for ANY null repo. ISS-4996
    // split that condition: an ABSENT remote is the same fact as a null branch,
    // so it renders the shared `GridEmptyValue` em dash and the card drops the
    // row exactly as it drops Branch and Model. Rendering the word here made one
    // condition wear two glyphs in adjacent columns and put a value-shaped label
    // in a column whose facet has no "Unknown" option to select it back.
    const noRemoteRow: SessionTableRow = {
      ...ROW,
      id: "ses-no-remote",
      repo: null,
      repositoryDisplay: { kind: SessionRepositoryDisplayKind.Absent },
    };
    render(
      <SessionsTable
        items={[noRemoteRow]}
        mode="compact"
        renderName={renderName}
      />
    );

    expect(screen.queryByText("Repository")).not.toBeInTheDocument();
  });

  it("keeps the Repository row in the card body rendering Unknown when the stored value is malformed (ISS-4996)", () => {
    // The surviving half of FEA-4274's intent: a repository value WAS stored but
    // carries no identity. That is a data-quality signal, not an absence, so it
    // keeps the distinct word — and because it is not the empty sentinel, the
    // card fallback must keep the Repository row visible rather than dropping it.
    const malformedRepoRow: SessionTableRow = {
      ...ROW,
      id: "ses-malformed-repo",
      repo: null,
      repositoryDisplay: { kind: SessionRepositoryDisplayKind.Malformed },
    };
    render(
      <SessionsTable
        items={[malformedRepoRow]}
        mode="compact"
        renderName={renderName}
      />
    );

    const repoLabel = screen.getByText("Repository");
    expect(repoLabel.tagName).toBe("DT");
    const repoValue = repoLabel.nextElementSibling as HTMLElement;
    expect(repoValue.tagName).toBe("DD");
    expect(within(repoValue).getByText("Unknown")).toBeInTheDocument();
  });

  it("renders the subscription cost tooltip chip in a card", () => {
    const subscriptionRow: SessionTableRow = {
      ...ROW,
      id: "ses-sub",
      costLabel: "$3.50",
      costAvailability: "subscription",
      costTooltip: "Billed through your subscription",
    };
    render(
      <SessionsTable
        items={[subscriptionRow]}
        mode="compact"
        renderName={renderName}
      />
    );

    const costLabel = screen.getByText("Cost");
    expect(costLabel.tagName).toBe("DT");
    const costValue = costLabel.nextElementSibling as HTMLElement;
    expect(within(costValue).getByText("$3.50")).toBeInTheDocument();
  });

  it("drops the cost column from card body for no-usage rows", () => {
    const noUsageRow: SessionTableRow = {
      ...ROW,
      id: "ses-nousage",
      costLabel: "",
      costAvailability: "no_usage",
    };
    render(
      <SessionsTable
        items={[noUsageRow]}
        mode="compact"
        renderName={renderName}
      />
    );

    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
  });

  it("renders the host-supplied extra column in the card body", () => {
    // Regression guard: the extra column (e.g. Agent Monitoring's Artifact link)
    // must survive the table→card flip — it is a real visible desktop column, so
    // the card body renders it as a labeled `<dt>`/`<dd>` pair, not silently
    // dropped like a header-only column.
    render(
      <SessionsTable
        extraColumnLabel="Artifact"
        items={[ROW]}
        mode="compact"
        renderExtraColumn={(row) => (
          <a href={`/artifacts/${row.id}`}>plan.md</a>
        )}
        renderName={renderName}
      />
    );

    const extraLabel = screen.getByText("Artifact");
    expect(extraLabel.tagName).toBe("DT");
    const extraValue = extraLabel.nextElementSibling as HTMLElement;
    expect(extraValue.tagName).toBe("DD");
    expect(within(extraValue).getByText("plan.md")).toBeInTheDocument();
  });
});
