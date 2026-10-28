import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  type BranchCollaborators,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { Priority } from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  DetailsFieldId,
  DetailsReadOnlyKind,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import {
  DETAILS_TAB_FIELD_GROUPS_SELECTOR,
  DetailsTabArtifactType,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { formatLocPerDollar } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchShellDetailsConfig,
  incompleteLabel,
  unavailableLabel,
} from "../branch-shell-details";
import {
  completeMetrics,
  populatedDetail,
} from "../branch-story-metric-fixtures";
import { BRANCH_UNAVAILABLE_LABEL } from "../branch-unavailable-value";

const ORIGINAL_TIME_ZONE = process.env.TZ;

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => false,
}));

const unavailable = unavailableArtifactCollaborators(
  CollaboratorArtifactType.Branch
);

/**
 * ISS-12197's Branch rows, in the ticket's order and wording, re-typed here
 * so a relabelled or moved row fails (the same policing
 * `details-sections.test.tsx` does for the fixture).
 */
const ARTIFACT_DETAILS_LABELS = [
  "Name",
  "Slug",
  "Owner",
  "Collaborators",
  "Status",
  "Priority",
  "Due date",
  "Created at",
  "Created by",
  "Updated at",
  "Project",
  "Parent",
  "Tags",
] as const;

/** The sessions that worked the branch are on the Sessions tab, not a row. */
const BRANCH_DETAILS_LABELS = [
  "Repository",
  "Changes",
  "Commit count",
  "Pull Request",
  "Checks status",
  "Estimated cost",
  "LOC / $",
] as const;

/** The cloud read: every Artifact-row field served, so every row has a value. */
function cloudDetail(): BranchPageDetail {
  return {
    ...populatedDetail(),
    slug: "BR-1",
    assignee: {
      avatarUrl: null,
      email: "grace@example.com",
      firstName: "Grace",
      id: "user-assignee",
      lastName: "Hopper",
    },
    createdAt: "2026-06-10T11:58:00.000Z",
    createdBy: {
      avatarUrl: null,
      email: "ada@example.com",
      firstName: "Ada",
      id: "user-creator",
      lastName: "Lovelace",
    },
    updatedAt: "2026-06-17T12:19:00.000Z",
    dueDate: "2026-06-20T00:00:00.000Z",
    // The cloud read joins both off one row (`canonical-projection.ts`), and
    // ISS-10995's Project row keys its write on the id.
    projectId: "project-desktop-mlp",
    projectName: "Desktop MLP",
    parent: {
      documentType: null,
      id: "artifact-iss-4473",
      name: "Comprehensive Branch details",
      slug: "ISS-4473",
      type: ArtifactType.Document,
    },
    // ISS-10995: Priority and Tags draw only where the producer served them,
    // so the fixture for the full cloud row set carries both. The cloud read
    // always does (`projectBranchTags` emits an availability either way).
    priority: Priority.Medium,
    tagAvailability: ArtifactTagAvailability.Available,
    tags: [{ color: TagColor.Red, id: "tag-1", name: "platform" }],
    commits: [
      {
        committedAt: "2026-06-17T09:30:00.000Z",
        message: "Scaffold the shell",
        sha: "1234567",
      },
      {
        committedAt: "2026-06-17T09:45:00.000Z",
        message: "Wire the Details tab",
        sha: "89abcde",
      },
    ],
  };
}

/**
 * The desktop local read (`shared-branches-api.ts`), which serves none of the
 * Artifact row's generic fields.
 */
function desktopDetail(): BranchPageDetail {
  const {
    assignee: _assignee,
    createdAt: _createdAt,
    createdBy: _createdBy,
    dueDate: _dueDate,
    parent: _parent,
    projectName: _projectName,
    slug: _slug,
    updatedAt: _updatedAt,
    ...local
  } = populatedDetail();
  return local;
}

function renderDetails(
  detail = cloudDetail(),
  collaborators = unavailable,
  props: Omit<Parameters<typeof branchShellDetailsConfig>[0], "detail"> = {}
) {
  return render(
    <AppCoreStoryProviders>
      <TooltipProvider>
        <DetailsTabSections
          config={shippedDetailsTabConfig(
            DetailsTabArtifactType.Branch,
            branchShellDetailsConfig({ detail, ...props }, collaborators)
          )}
          priorityEditor={ArtifactPriorityEditor}
        />
      </TooltipProvider>
    </AppCoreStoryProviders>
  );
}

/** Every field row's label, section after section, in drawn order. */
function coreLabels(): string[] {
  return Array.from(
    document.querySelectorAll(
      `${DETAILS_TAB_FIELD_GROUPS_SELECTOR} [role="group"]`
    )
  ).map((row) => (row.firstElementChild?.textContent ?? "").trim());
}

/** The value half of a drawn row (its first child is the label). */
function cellOf(id: DetailsFieldId): HTMLElement {
  const cell = document.querySelector<HTMLElement>(
    `[data-details-field="${id}"]`
  )?.lastElementChild;
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Expected a drawn ${id} row`);
  }
  return cell;
}

/** The Pull Request row's state chip(s), in order. */
function pullRequestChips(): string[] {
  return Array.from(
    cellOf(DetailsFieldId.PullRequests).querySelectorAll('[data-slot="chip"]')
  ).map((chip) => chip.textContent ?? "");
}

/** Each drawn section's title and its rows' labels, in drawn order. */
function sections(): [string, string[]][] {
  return Array.from(document.querySelectorAll("[data-details-group]")).map(
    (group) => [
      group.querySelector("h2")?.textContent ?? "",
      Array.from(group.querySelectorAll('[role="group"]')).map((row) =>
        (row.firstElementChild?.textContent ?? "").trim()
      ),
    ]
  );
}

describe("Branch shared Details mapping", () => {
  afterEach(() => {
    restoreTimeZone(ORIGINAL_TIME_ZONE);
  });

  it("draws the Details tab's sections: Artifact details, then Branch details, with no Sessions row (ISS-12412)", () => {
    renderDetails();
    expect(sections()).toEqual([
      ["Artifact details", [...ARTIFACT_DETAILS_LABELS]],
      ["Branch details", [...BRANCH_DETAILS_LABELS]],
    ]);
    const config = branchShellDetailsConfig(
      { detail: cloudDetail() },
      unavailable
    );
    // The Branch config has none, so the renderer omits the whole block.
    expect(config.customFields).toEqual([]);
    // The linked groups come only from `BranchLinkedArtifactGroupsScope`.
    expect(config.linked).toEqual([]);
  });

  it("ships exactly the editable set writable, and nothing else (ISS-10995)", () => {
    // The counterfactual for the spec this replaced, which pinned every row
    // read-only "until ISS-10995 adds the write paths". On Branches the
    // editable set is priority, project, tags and custom fields (operator
    // rulings 2026-10-09 and 2026-10-12, the latter making Project editable
    // here and on Sessions); this Branch config carries no custom field.
    const config = branchShellDetailsConfig(
      { detail: cloudDetail() },
      unavailable
    );
    const writable = config.core.filter(
      (field) => field.edit?.mode !== "read-only"
    );
    expect(writable.map((field) => field.id)).toEqual([
      DetailsFieldId.Priority,
      DetailsFieldId.Project,
      DetailsFieldId.Tags,
    ]);
  });

  it("leaves out every Artifact-row field a desktop local read omits, the editable ones included (ISS-10995)", () => {
    // The counterfactual for ISS-10995 (operator ruling 2026-10-09): Priority
    // and Tags used to stay drawn here, on the reasoning that production writes
    // them. The single-user read serves neither, so a drawn row could only be a
    // dash reading as "this branch has none" — it draws no row instead.
    renderDetails(desktopDetail());
    const labels = coreLabels();
    for (const absent of [
      "Slug",
      "Owner",
      "Priority",
      "Due date",
      "Created at",
      "Created by",
      "Updated at",
      "Project",
      "Parent",
      "Tags",
    ]) {
      expect(labels).not.toContain(absent);
    }
    for (const drawn of ["Repository", "Commit count"]) {
      expect(labels).toContain(drawn);
    }
  });

  it("marks only the fields production never writes as never-written", () => {
    const config = branchShellDetailsConfig(
      { detail: cloudDetail() },
      unavailable
    );
    const editOf = (id: DetailsFieldId) =>
      config.core.find((field) => field.id === id)?.edit;
    // ISS-10995: all three left the read-only set for their own cells' writes.
    for (const id of [
      DetailsFieldId.Priority,
      DetailsFieldId.Project,
      DetailsFieldId.Tags,
    ]) {
      expect(editOf(id)).toEqual({ mode: "self-saving" });
    }
    for (const id of [DetailsFieldId.Owner, DetailsFieldId.DueDate]) {
      expect(editOf(id)).toEqual({
        mode: "read-only",
        reason: { kind: DetailsReadOnlyKind.NotEditable },
      });
    }
    for (const id of [
      DetailsFieldId.Name,
      DetailsFieldId.Slug,
      DetailsFieldId.Collaborators,
      DetailsFieldId.Status,
      DetailsFieldId.CreatedAt,
      DetailsFieldId.CreatedBy,
      DetailsFieldId.Updated,
      DetailsFieldId.Parent,
      DetailsFieldId.Repository,
      DetailsFieldId.PullRequests,
      DetailsFieldId.ChecksStatus,
      DetailsFieldId.Changes,
      DetailsFieldId.CommitCount,
      DetailsFieldId.Cost,
      DetailsFieldId.LocPerDollar,
    ]) {
      expect(editOf(id)).toMatchObject({
        mode: "read-only",
        reason: { kind: DetailsReadOnlyKind.NotEditable },
      });
    }
  });

  it("reads Owner from the artifact's assignee, never the push actor (decision 6, 2026-10-07)", () => {
    const detail = cloudDetail();
    expect(detail.owner).toBe("alice");
    renderDetails(detail);
    const owner = cellOf(DetailsFieldId.Owner);
    expect(owner).toHaveTextContent("Grace Hopper");
    expect(owner).not.toHaveTextContent("alice");
  });

  it("renders the generic artifact rows from the Artifact row's fields", () => {
    // The due date reads viewer-local; pinned so the fixture's midnight UTC
    // instant is the 20th wherever the suite runs.
    process.env.TZ = "UTC";
    renderDetails();
    expect(cellOf(DetailsFieldId.Slug)).toHaveTextContent("BR-1");
    expect(
      within(cellOf(DetailsFieldId.Slug)).getByRole("button", {
        name: "Copy slug",
      })
    ).toBeInTheDocument();
    expect(cellOf(DetailsFieldId.CreatedBy)).toHaveTextContent("Ada Lovelace");
    expect(cellOf(DetailsFieldId.DueDate)).toHaveTextContent("2026-06-20");
    expect(cellOf(DetailsFieldId.CreatedAt)).toHaveTextContent("2026");
    expect(cellOf(DetailsFieldId.Updated)).toHaveTextContent("2026");
    expect(cellOf(DetailsFieldId.Project)).toHaveTextContent("Desktop MLP");
    expect(cellOf(DetailsFieldId.Tags)).toHaveTextContent("platform");
  });

  it("links Parent to the artifact that PRODUCES the branch", () => {
    renderDetails(cloudDetail(), unavailable, {
      getArtifactHref: (slug) => `/closedloop-ai/issues/${slug}`,
    });
    expect(
      within(cellOf(DetailsFieldId.Parent)).getByRole("link", {
        name: "ISS-4473",
      })
    ).toHaveAttribute("href", "/closedloop-ai/issues/ISS-4473");
  });

  it("renders each Branch row from the value it derives", () => {
    const detail = cloudDetail();
    renderDetails(detail);
    expect(cellOf(DetailsFieldId.Repository)).toHaveTextContent("owner/repo");
    expect(cellOf(DetailsFieldId.Changes)).toHaveTextContent("180");
    expect(cellOf(DetailsFieldId.CommitCount)).toHaveTextContent("2 commits");
    expect(cellOf(DetailsFieldId.Cost)).toHaveTextContent("$4.00");
    expect(cellOf(DetailsFieldId.LocPerDollar)).toHaveTextContent(
      formatLocPerDollar(42.5)
    );
    expect(cellOf(DetailsFieldId.LocPerDollar)).not.toHaveTextContent("*");
    // A Complete figure has no footnote, so no popover to open one from.
    expect(
      within(cellOf(DetailsFieldId.LocPerDollar)).queryByRole("button", {
        name: "About LOC / $",
      })
    ).not.toBeInTheDocument();
  });

  it("marks a Partial LOC / $ the way the headline card marks the same figure, with the disclosure in the info popover", async () => {
    renderDetails({
      ...cloudDetail(),
      canonicalMetrics: {
        ...completeMetrics(),
        locPerDollar: {
          disclosure: BranchMetricDisclosure.LocIncomplete,
          state: BranchMetricAvailability.Partial,
          value: 1.67,
        },
      },
    });
    const cell = cellOf(DetailsFieldId.LocPerDollar);
    expect(cell).toHaveTextContent(`${formatLocPerDollar(1.67)}*`);
    // ISS-10540: the sentence is not on the row face; it opens from the `(i)`
    // named after the row, as `MetricCard` names the card's.
    expect(cell).not.toHaveTextContent(BranchMetricDisclosure.LocIncomplete);
    fireEvent.click(
      within(cell).getByRole("button", { name: "About LOC / $" })
    );
    const dialog = await screen.findByRole("dialog", { name: "About LOC / $" });
    expect(dialog.textContent).toContain(BranchMetricDisclosure.LocIncomplete);
  });

  it("draws the Pull Request row as the pull request's link, title and its own lifecycle chip (ISS-12412)", () => {
    renderDetails();
    const cell = cellOf(DetailsFieldId.PullRequests);
    expect(within(cell).getByRole("link", { name: "#1270" })).toHaveAttribute(
      "href",
      "https://github.com/owner/repo/pull/1270"
    );
    expect(cell).toHaveTextContent("Add Branch Detail page");
    expect(pullRequestChips()).toEqual(["Merged"]);
  });

  it("states the pull request's own state, not the branch's, with the Draft flag on every draft", () => {
    const pullRequestIn = (
      state: GitHubPRState,
      isDraft: boolean,
      status: BranchStatus
    ): BranchPageDetail => {
      const detail = cloudDetail();
      const selected = detail.selectedPullRequest;
      if (!selected) {
        throw new Error("Expected the fixture's selected pull request");
      }
      return {
        ...detail,
        prState: state,
        selectedPullRequest: { ...selected, isDraft, state },
        status,
      };
    };
    const cases: [BranchPageDetail, string[]][] = [
      // The branch reads Draft (ISS-9664), but the pull request was closed:
      // both facts stay on screen, as the old "Closed · Draft" text row had.
      [
        pullRequestIn(GitHubPRState.Closed, true, BranchStatus.Draft),
        ["Closed", "Draft"],
      ],
      [
        pullRequestIn(GitHubPRState.Merged, true, BranchStatus.Merged),
        ["Merged", "Draft"],
      ],
      [
        pullRequestIn(GitHubPRState.Closed, false, BranchStatus.Closed),
        ["Closed"],
      ],
      [pullRequestIn(GitHubPRState.Open, true, BranchStatus.Draft), ["Draft"]],
      [pullRequestIn(GitHubPRState.Open, false, BranchStatus.Review), ["Open"]],
    ];
    for (const [detail, chips] of cases) {
      const view = renderDetails(detail);
      expect(pullRequestChips()).toEqual(chips);
      view.unmount();
    }
  });

  it("says Status unavailable about a pull request nobody observed, never the column's OPEN (ISS-8422)", () => {
    const detail = cloudDetail();
    renderDetails({
      ...detail,
      selectedPullRequest: detail.selectedPullRequest
        ? { ...detail.selectedPullRequest, lifecycleObserved: false }
        : null,
    });
    expect(cellOf(DetailsFieldId.PullRequests)).toHaveTextContent("#1270");
    expect(pullRequestChips()).toEqual(["Status unavailable"]);
  });

  it("reads the branch's pull request state when an older producer sends no selection, and says Status unavailable when it sends no state either", () => {
    const view = renderDetails({
      ...cloudDetail(),
      selectedPullRequest: undefined,
    });
    expect(pullRequestChips()).toEqual(["Merged"]);
    view.unmount();

    // The ISS-8422 unobserved case reads the same with or without a selection.
    renderDetails({
      ...cloudDetail(),
      prState: null,
      selectedPullRequest: undefined,
    });
    expect(cellOf(DetailsFieldId.PullRequests)).toHaveTextContent("#1270");
    expect(pullRequestChips()).toEqual(["Status unavailable"]);
  });

  it("takes the number, title and link from the selected pull request, never mixing two pull requests in one cell", () => {
    const detail = cloudDetail();
    const selected = detail.selectedPullRequest;
    if (!selected) {
      throw new Error("Expected the fixture's selected pull request");
    }
    // The branch's columns name #12 (open); the selection is #15 (merged).
    const columns = {
      prNumber: 12,
      prState: GitHubPRState.Open,
      prTitle: "Older attempt",
      prUrl: "https://github.com/owner/repo/pull/12",
    };
    const view = renderDetails({
      ...detail,
      ...columns,
      selectedPullRequest: {
        ...selected,
        isDraft: false,
        number: 15,
        state: GitHubPRState.Merged,
        title: "Final attempt",
        url: "https://github.com/owner/repo/pull/15",
      },
    });
    let cell = cellOf(DetailsFieldId.PullRequests);
    expect(within(cell).getByRole("link", { name: "#15" })).toHaveAttribute(
      "href",
      "https://github.com/owner/repo/pull/15"
    );
    expect(cell).toHaveTextContent("Final attempt");
    expect(cell).not.toHaveTextContent("#12");
    expect(cell).not.toHaveTextContent("Older attempt");
    expect(pullRequestChips()).toEqual(["Merged"]);
    view.unmount();

    // A selection missing its title and link does not borrow #12's.
    renderDetails({
      ...detail,
      ...columns,
      selectedPullRequest: {
        ...selected,
        number: 15,
        title: null,
        url: null,
      },
    });
    cell = cellOf(DetailsFieldId.PullRequests);
    expect(cell).toHaveTextContent("#15");
    expect(cell).not.toHaveTextContent("Older attempt");
    expect(within(cell).queryByRole("link")).toBeNull();
  });

  it("links the Pull Request pill only to a canonical GitHub pull request URL", () => {
    const detail = cloudDetail();
    const selected = detail.selectedPullRequest;
    if (!selected) {
      throw new Error("Expected the fixture's selected pull request");
    }
    const view = renderDetails();
    expect(
      within(cellOf(DetailsFieldId.PullRequests)).getByRole("link", {
        name: "#1270",
      })
    ).toBeTruthy();
    view.unmount();

    for (const url of [
      "javascript:alert(1)",
      "https://evil.example.com/owner/repo/pull/1270",
    ]) {
      const unsafe = renderDetails({
        ...detail,
        prUrl: url,
        selectedPullRequest: { ...selected, url },
      });
      const cell = cellOf(DetailsFieldId.PullRequests);
      expect(cell).toHaveTextContent("#1270");
      expect(within(cell).queryByRole("link")).toBeNull();
      unsafe.unmount();
    }
  });

  it("emits no Sessions row: the sessions are on the Sessions tab (ISS-12412)", () => {
    const config = branchShellDetailsConfig(
      { detail: cloudDetail() },
      unavailable
    );
    expect(config.core.map((field) => field.id)).not.toContain(
      DetailsFieldId.LinkedSessions
    );
    expect(config.core.map((field) => field.id)).toContain(
      DetailsFieldId.CommitCount
    );
  });

  it("leaves the Pull Request row out when the branch has no pull request", () => {
    renderDetails({
      ...cloudDetail(),
      prNumber: null,
      prState: null,
      prTitle: null,
      selectedPullRequest: null,
    });
    expect(coreLabels()).not.toContain("Pull Request");
  });

  it("states Checks status in words while the passed count is withheld, and as the tally once both halves are present", () => {
    const detail = cloudDetail();
    // ISS-8241: the detail's rollup is the selected PR's own measurement.
    // ISS-12203 counts `checksPassed` from those rows, but withholds it while
    // any is missing — and a present total alone is not a count.
    expect(detail.checksPassed).toBeNull();
    expect(detail.checksTotal).toBe(3);
    const wordOnly = renderDetails(detail);
    const checks = cellOf(DetailsFieldId.ChecksStatus);
    expect(checks).toHaveTextContent("Checks passing");
    expect(checks).not.toHaveTextContent("/3");
    wordOnly.unmount();

    renderDetails({ ...detail, checksPassed: 2, checksTotal: 3 });
    expect(cellOf(DetailsFieldId.ChecksStatus)).toHaveTextContent(
      "2/3 passing"
    );
  });

  it("leaves Checks status out when no producer reported a rollup at all", () => {
    renderDetails({
      ...cloudDetail(),
      checksPassed: null,
      checksStatus: null,
      checksTotal: null,
    });
    expect(coreLabels()).not.toContain("Checks status");
  });

  it("reads Estimated cost from the attributed figure the Branches list shows (decision 3, 2026-10-07)", () => {
    const detail = cloudDetail();
    expect(detail.estimatedCostUsd).toBe(4);
    renderDetails({ ...detail, attributedCostUsd: 2.5 });
    const cost = cellOf(DetailsFieldId.Cost);
    expect(cost).toHaveTextContent("$2.50");
    expect(cost).not.toHaveTextContent("$4.00");
  });

  it("leaves Estimated cost and LOC / $ out when nobody could price them", () => {
    renderDetails({
      ...cloudDetail(),
      attributedCostUsd: null,
      canonicalMetrics: {
        ...completeMetrics(),
        locPerDollar: {
          state: BranchMetricAvailability.Unavailable,
          value: null,
        },
      },
    });
    const labels = coreLabels();
    expect(labels).not.toContain("Estimated cost");
    expect(labels).not.toContain("LOC / $");
  });

  // Was "leaves Changes out": dropping the row gave a null-LOC branch a
  // different answer on each side of `artifact-detail-shell` — the flag-off
  // `BranchPropertiesPanel` renders the approved word. davetho on PR #8898
  // ruled the shell must match it, so the row stays drawn and the absence
  // expectation is obsolete; `cellOf` throws when a row is not drawn.
  it("shows the unavailable word for Changes when the page resolved no LOC, never +0 -0", () => {
    renderDetails(cloudDetail(), unavailable, {
      loc: { additions: null, churn: null, deletions: null },
    });
    expect(coreLabels()).toContain("Changes");
    expect(cellOf(DetailsFieldId.Changes)).toHaveTextContent(
      BRANCH_UNAVAILABLE_LABEL
    );
  });

  it("renders Changes as a changes row when the page resolved both halves", () => {
    const config = branchShellDetailsConfig(
      {
        detail: populatedDetail(),
        loc: { additions: 12, churn: 15, deletions: 3 },
      },
      unavailable
    );
    const changes = config.core.find(
      (field) => field.id === DetailsFieldId.Changes
    );
    expect(changes?.value).toEqual({
      additions: 12,
      deletions: 3,
      kind: "changes",
    });
  });

  /*
   * ISS-12273 removed the partial-list note from this row (operator ruling,
   * 2026-10-08). The two cases that lived here asserted the note existed and
   * policed its exact word; both are obsolete with it.
   *
   * This is their counterfactual, and it deliberately names the removed words:
   * it is the only thing that fails if a note comes back. `availability` still
   * travels — an empty list the producer could not read in full draws the
   * unknown glyph, which `isDetailsValueEmpty` decides from it.
   */
  it("states a partial list with no note beside it (ISS-12273)", () => {
    const config = branchShellDetailsConfig(
      { detail: populatedDetail() },
      {
        availability: BranchIdentityAvailability.Incomplete,
        people: [
          { id: "u1", displayName: "Tam", login: "tam", avatarUrl: null },
          { id: "u2", displayName: "Wes", login: "wes", avatarUrl: null },
        ] as unknown as BranchCollaborators["people"],
        sources: unavailable.sources,
      }
    );
    const collaborators = config.core.find(
      (field) => field.id === DetailsFieldId.Collaborators
    );

    expect(collaborators?.value).toMatchObject({
      availability: BranchIdentityAvailability.Incomplete,
      kind: "people",
    });
    expect(collaborators?.value).not.toHaveProperty("incompleteNote");
    expect(JSON.stringify(collaborators?.value)).not.toContain(incompleteLabel);
    expect(JSON.stringify(collaborators?.value)).not.toContain(
      unavailableLabel
    );
  });

  it("keeps the unavailable word for the viewer reasons that mean it", () => {
    const config = branchShellDetailsConfig({ detail: populatedDetail() }, {
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: unavailable.sources,
    } as BranchCollaborators);
    // Offline and no-permission are genuinely absent reads, not partial ones.
    expect(config.viewerReasons).toMatchObject({
      "desktop-offline": unavailableLabel,
      "no-permission": unavailableLabel,
    });
  });
});
