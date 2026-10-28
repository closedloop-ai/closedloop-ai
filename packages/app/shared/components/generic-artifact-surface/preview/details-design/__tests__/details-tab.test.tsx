// @vitest-environment jsdom

import {
  DETAILS_DESIGN_HOST,
  DetailsPriorityEditorHost,
} from "@repo/app/documents/components/details-design/details-design-preview-host";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailsAvailability } from "../details-design-model";
import {
  branchDetailsTabConfig,
  detailsAssociatedRecord,
  documentDetailsTabConfig,
  issueDetailsTabConfig,
  SESSION_DETAILS_TAB_CODEX_FIXTURE,
  SESSION_DETAILS_TAB_FIXTURE,
  sessionDetailsTabConfig,
} from "../details-tab-fixtures";
import {
  associatedTableGroups,
  DETAILS_TAB_LEFT_OUT,
  DetailsLinkEnd,
  DetailsLinkType,
  DetailsRelationship,
  type DetailsTabConfig,
  detailsRelationship,
  forDetailsTabViewer,
  groupDetailsTabFields,
} from "../details-tab-model";
import { DetailsTabSections } from "../details-tab-sections";

function renderDetailsTab(config: DetailsTabConfig) {
  return render(
    <TooltipProvider>
      <DetailsTabSections
        config={config}
        priorityEditor={DetailsPriorityEditorHost}
      />
    </TooltipProvider>
  );
}

const EDIT_OWNER = /^Edit owner/;

const headings = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);

describe("ISS-12252 Details tab", () => {
  it("maps each link type and end to its relationship", () => {
    const { Produces, Blocks, RelatesTo } = DetailsLinkType;
    const { Source, Target } = DetailsLinkEnd;
    expect(detailsRelationship(Produces, Target)).toBe(
      DetailsRelationship.Parent
    );
    expect(detailsRelationship(Produces, Source)).toBe(
      DetailsRelationship.Child
    );
    expect(detailsRelationship(Blocks, Target)).toBe(
      DetailsRelationship.BlockedBy
    );
    expect(detailsRelationship(Blocks, Source)).toBe(
      DetailsRelationship.Blocking
    );
    expect(detailsRelationship(RelatesTo, Source)).toBe(
      DetailsRelationship.Related
    );
    expect(detailsRelationship(RelatesTo, Target)).toBe(
      DetailsRelationship.Related
    );
  });

  it("lists parents first, then children, blockers, blocked work and peers, within each type", () => {
    const config = sessionDetailsTabConfig(DETAILS_DESIGN_HOST);
    expect(
      config.base.linked.map((group) => [
        group.heading,
        group.rows.map((row) => row.relationship),
      ])
    ).toEqual([
      ["Documents", ["Parent", "Related"]],
      ["Issues", ["Parent", "Blocking", "Related"]],
      ["Branches & pull requests", ["Child", "Child", "Child"]],
    ]);
  });

  it("files every document prefix under Documents and FEA under Issues", () => {
    const groups = associatedTableGroups(
      ["PRD-1", "PLN-1", "DOC-1", "TPL-1", "FEA-1"].map((slug) =>
        detailsAssociatedRecord({
          end: DetailsLinkEnd.Source,
          href: null,
          linkType: DetailsLinkType.RelatesTo,
          name: slug,
          slug,
        })
      )
    );
    expect(
      groups.map((group) => [group.heading, group.rows.map((row) => row.slug)])
    ).toEqual([
      ["Documents", ["PRD-1", "PLN-1", "DOC-1", "TPL-1"]],
      ["Issues", ["FEA-1"]],
    ]);
  });

  it("groups Associated artifacts by type: documents, sessions, issues, branches", () => {
    const groups = sessionDetailsTabConfig(DETAILS_DESIGN_HOST).base.linked;
    expect(groups.map((group) => group.heading)).toEqual([
      "Documents",
      "Issues",
      "Branches & pull requests",
    ]);
    expect(
      groups.at(-1)?.rows.map((row) => [row.slug, row.relationship])
    ).toEqual([
      ["BR-0001", "Child"],
      ["#101", "Child"],
      ["#102", "Child"],
    ]);
    expect(
      branchDetailsTabConfig(DETAILS_DESIGN_HOST).base.linked.map(
        (group) => group.heading
      )
    ).toEqual(["Documents", "Sessions", "Issues"]);
  });

  it("draws Associated artifacts under one heading per type, with no Type column", () => {
    renderDetailsTab(sessionDetailsTabConfig(DETAILS_DESIGN_HOST));
    const associated = document.querySelector(
      detailsTabGroupSelector(DetailsTabGroupId.Associated)
    );
    if (!(associated instanceof HTMLElement)) {
      throw new Error("no Associated artifacts section");
    }
    expect(
      within(associated)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["Documents", "Issues", "Branches & pull requests"]);
    expect(within(associated).queryByText("Type")).toBeNull();
  });

  it("keeps every core row but the ones a type leaves out on purpose", () => {
    for (const config of [
      sessionDetailsTabConfig(DETAILS_DESIGN_HOST),
      branchDetailsTabConfig(DETAILS_DESIGN_HOST),
      documentDetailsTabConfig(DETAILS_DESIGN_HOST),
      issueDetailsTabConfig(DETAILS_DESIGN_HOST),
    ]) {
      const grouped = groupDetailsTabFields(config).flatMap((group) =>
        group.fields.map((field) => field.id)
      );
      const leftOut = DETAILS_TAB_LEFT_OUT[config.type];
      expect([...grouped].sort()).toEqual(
        config.base.core
          .map((field) => field.id)
          .filter((id) => !leftOut.includes(id))
          .sort()
      );
    }
  });

  it("puts a row no group names in a last group rather than losing it", () => {
    const config = documentDetailsTabConfig(DETAILS_DESIGN_HOST);
    const [first] = config.base.core;
    if (!first) {
      throw new Error("fixture has no rows");
    }
    const groups = groupDetailsTabFields({
      ...config,
      base: {
        ...config.base,
        core: [...config.base.core, { ...first, id: "fixture-unplaced" }],
      },
    });
    expect(groups.at(-1)?.fields.map((field) => field.id)).toEqual([
      "fixture-unplaced",
    ]);
  });

  it("gives a Document Current version alone as its own field (PRD-799)", () => {
    renderDetailsTab(documentDetailsTabConfig(DETAILS_DESIGN_HOST));
    const documentGroup = screen
      .getByRole("heading", { level: 2, name: "Document details" })
      .closest("[data-details-group]");
    if (!(documentGroup instanceof HTMLElement)) {
      throw new Error("no Document details section");
    }
    expect(
      within(documentGroup).getByRole("group", { name: "Current version" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Document type" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Approver" })).toBeNull();
  });

  it("lists a Document's Repositories with its artifact fields, read-only (PRD-799)", () => {
    renderDetailsTab(documentDetailsTabConfig(DETAILS_DESIGN_HOST));
    const common = document.querySelector(
      '[data-details-group="artifact-details"]'
    );
    if (!(common instanceof HTMLElement)) {
      throw new Error("no Artifact details section");
    }
    const repositories = within(common).getByRole("group", {
      name: "Repositories",
    });
    expect(repositories).toHaveTextContent("fixture-org/fixture-repo");
    expect(within(repositories).queryByRole("button")).toBeNull();
  });

  it("gives an Issue its own section, with no Status or Parent drawn twice", () => {
    renderDetailsTab(issueDetailsTabConfig(DETAILS_DESIGN_HOST));
    expect(headings()).toEqual([
      "Artifact details",
      "Issue details",
      "Custom fields",
      "Associated artifacts",
    ]);
    const issueGroup = screen
      .getByRole("heading", { level: 2, name: "Issue details" })
      .closest("[data-details-group]");
    if (!(issueGroup instanceof HTMLElement)) {
      throw new Error("no Issue details section");
    }
    for (const name of [
      "Issue status",
      "Closed reason",
      "Parent issue",
      "Sub-issues",
      "Linked branch",
      "External links",
    ]) {
      expect(within(issueGroup).getByRole("group", { name })).toBeVisible();
    }
    expect(screen.queryByRole("group", { name: "Status" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Parent" })).toBeNull();
  });

  it("orders a Session's sections: artifact, session, custom, then associated", () => {
    renderDetailsTab(sessionDetailsTabConfig(DETAILS_DESIGN_HOST));
    expect(headings()).toEqual([
      "Artifact details",
      "Session details",
      "Custom fields",
      "Associated artifacts",
    ]);
  });

  it("names each type's own section after the type", () => {
    const { unmount } = renderDetailsTab(
      documentDetailsTabConfig(DETAILS_DESIGN_HOST)
    );
    expect(headings()).toContain("Document details");
    unmount();
    renderDetailsTab(branchDetailsTabConfig(DETAILS_DESIGN_HOST));
    // A Branch has no custom fields, so that section is left out.
    expect(headings()).toEqual([
      "Artifact details",
      "Branch details",
      "Associated artifacts",
    ]);
  });

  it("separates the sections with a rule, and boxes none of them", () => {
    renderDetailsTab(sessionDetailsTabConfig(DETAILS_DESIGN_HOST));
    const sections = Array.from(
      document.querySelectorAll("[data-details-group]")
    );
    expect(sections).toHaveLength(4);
    for (const section of sections) {
      expect(section.className).not.toContain("rounded");
      expect(section.className).toContain("border-t");
      expect(section.className).toContain("first:border-t-0");
    }
  });

  it("puts usage and Repository in Session details, and no branch rows", () => {
    renderDetailsTab(sessionDetailsTabConfig(DETAILS_DESIGN_HOST));
    const group = document.querySelector(
      '[data-details-group="session-details"]'
    );
    if (!(group instanceof HTMLElement)) {
      throw new Error("no Session details section");
    }
    for (const name of ["Repository", "Input tokens", "Number of subagents"]) {
      expect(within(group).getByRole("group", { name })).toBeInTheDocument();
    }
    for (const name of ["Branches", "Pull requests", "Lines changed"]) {
      expect(screen.queryByRole("group", { name })).toBeNull();
    }
  });

  it("draws a group's rows in the group's order, not the config's", () => {
    renderDetailsTab(branchDetailsTabConfig(DETAILS_DESIGN_HOST));
    const group = document.querySelector(
      '[data-details-group="branch-details"]'
    );
    const ids = Array.from(
      group?.querySelectorAll("[data-details-field]") ?? []
    ).map((row) => row.getAttribute("data-details-field"));
    expect(ids.slice(0, 7)).toEqual([
      "repository",
      "base-branch",
      "head-sha",
      "origin",
      "changes",
      "files-changed",
      "commit-count",
    ]);
    expect(ids).not.toContain("linked-sessions");
  });

  it("says a Branch's pull request in one row: number, title and state", () => {
    renderDetailsTab(branchDetailsTabConfig(DETAILS_DESIGN_HOST));
    const row = screen.getByRole("group", { name: "Pull request" });
    expect(within(row).getByText("#201")).toBeInTheDocument();
    expect(
      within(row).getByText("Fixture: pull request title")
    ).toBeInTheDocument();
    expect(within(row).getByText("In review")).toBeInTheDocument();
  });

  it("draws no Checks count row, which is empty on every branch today", () => {
    const config = branchDetailsTabConfig(DETAILS_DESIGN_HOST);
    expect(config.base.core.map((field) => field.id)).not.toContain("checks");
  });

  it("gives only a Codex session the Codex runtime rows, with no sub-header", () => {
    const { unmount } = renderDetailsTab(
      sessionDetailsTabConfig(DETAILS_DESIGN_HOST)
    );
    expect(screen.queryByRole("group", { name: "Rate limit (5h)" })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Cache write TTL" })
    ).toBeInTheDocument();
    unmount();
    renderDetailsTab(
      sessionDetailsTabConfig(
        DETAILS_DESIGN_HOST,
        SESSION_DETAILS_TAB_CODEX_FIXTURE
      )
    );
    expect(headings()).not.toContain("Codex runtime");
    expect(
      screen.getByRole("group", { name: "Rate limit (5h)" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Cache write TTL" })).toBeNull();
  });

  it("leaves out a reconciliation row the session has no value for", () => {
    renderDetailsTab(
      sessionDetailsTabConfig(DETAILS_DESIGN_HOST, {
        ...SESSION_DETAILS_TAB_FIXTURE,
        launch: undefined,
        turns: undefined,
      })
    );
    expect(screen.queryByRole("group", { name: "Prompt source" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Number of turns" })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Number of steers" })
    ).toBeInTheDocument();
  });

  it("names every parent in one Parents row", () => {
    renderDetailsTab(sessionDetailsTabConfig(DETAILS_DESIGN_HOST));
    const parents = screen.getByRole("group", { name: "Parents" });
    expect(within(parents).getByText("ISS-0001")).toBeInTheDocument();
    expect(within(parents).getByText("PRD-0001")).toBeInTheDocument();
  });

  it("draws no pencil on an editable value", () => {
    const { container } = renderDetailsTab(
      documentDetailsTabConfig(DETAILS_DESIGN_HOST)
    );
    expect(screen.getByRole("button", { name: "Edit name" })).toBeVisible();
    expect(container.querySelector(".lucide-pencil")).toBeNull();
    expect(container.querySelector(".lucide-plus")).toBeNull();
  });

  it("says once, visibly, why a viewer can change nothing, and draws no lock", () => {
    const { container } = renderDetailsTab(
      forDetailsTabViewer(
        documentDetailsTabConfig(DETAILS_DESIGN_HOST),
        DetailsAvailability.NoPermission
      )
    );
    expect(screen.queryByRole("button", { name: "Edit name" })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(
      "Fixture: You can view these details but not change them."
    );
    expect(
      screen.getByRole("group", { name: "Name" })
    ).toHaveAccessibleDescription(
      "Fixture: You can view these details but not change them."
    );
    expect(container.querySelector(".lucide-lock")).toBeNull();
  });

  it("shows no viewer note to a viewer who can edit", () => {
    renderDetailsTab(documentDetailsTabConfig(DETAILS_DESIGN_HOST));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the fields a person sets as editable on a Session and a Branch", () => {
    for (const config of [
      sessionDetailsTabConfig(DETAILS_DESIGN_HOST),
      branchDetailsTabConfig(DETAILS_DESIGN_HOST),
    ]) {
      const { unmount } = renderDetailsTab(config);
      for (const name of ["Edit name", EDIT_OWNER, "Edit due date"]) {
        expect(screen.getByRole("button", { name })).toBeVisible();
      }
      unmount();
    }
  });

  it("gives a session in no project no custom fields", () => {
    renderDetailsTab(
      sessionDetailsTabConfig(DETAILS_DESIGN_HOST, {
        ...SESSION_DETAILS_TAB_FIXTURE,
        project: null,
      })
    );
    expect(screen.queryByRole("heading", { name: "Custom fields" })).toBeNull();
  });

  it("names the project the custom fields come from", () => {
    renderDetailsTab(documentDetailsTabConfig(DETAILS_DESIGN_HOST));
    expect(
      screen.getByText("From Fixture: Artifact detail pages")
    ).toBeInTheDocument();
  });
});
