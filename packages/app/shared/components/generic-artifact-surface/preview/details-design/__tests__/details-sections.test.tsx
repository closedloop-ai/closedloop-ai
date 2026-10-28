// @vitest-environment jsdom

import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { DETAILS_DESIGN_HOST } from "@repo/app/documents/components/details-design/details-design-preview-host";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_VERSION_HISTORY_TITLE,
  CommonArtifactDetails,
} from "../../components/artifact-detail-sections";
import { genericArtifacts } from "../../fixtures";
import {
  branchDetailsConfig,
  issueDetailsConfig,
  sessionDetailsConfig,
} from "../details-design-fixtures";
import {
  DETAILS_SECTION_TITLES,
  DetailsAvailability,
  type DetailsConfig,
  type DetailsField,
  DetailsFieldId,
  type DetailsFieldValue,
  DetailsReadOnlyKind,
  DetailsRowFlag,
  DetailsSectionId,
} from "../details-design-model";
import { DETAILS_EMPTY_VALUE } from "../details-field-value";

import {
  cellOf,
  configOf,
  DESIGN_OPTION,
  deferred,
  EDIT_BUTTON,
  oneTextField,
  PRIORITY_TRIGGER,
  RESEARCH_OPTION,
  renderDetails,
  SAVE_ERROR,
  STATUS_TRIGGER,
  tagsField,
} from "./details-test-support";

/**
 * ISS-10792 design harness. These pin the renderer's rules, so the review
 * screenshots cannot drift from what the layout claims.
 */

const DONE_OPTION = /Done/;
const F = DetailsFieldId;
/**
 * ISS-12197's field set and ORDER per type, with the ticket's own wording for
 * every row (decision 4, 2026-10-07). This spec deliberately polices that
 * copy, so the labels are the ticket's words re-typed here, not read off the
 * fixture: a fixture row relabelled or moved fails this, and a row the ticket
 * does not list fails this. Sessions carry no Parent (decision 2, 2026-10-07).
 */
const ISS_12197_ROWS = {
  Session: [
    [F.Name, "Name"],
    [F.Slug, "Slug"],
    [F.Owner, "Owner"],
    [F.Collaborators, "Collaborators"],
    [F.Status, "Status"],
    [F.Priority, "Priority"],
    [F.DueDate, "Due date"],
    [F.CreatedAt, "Created at"],
    [F.CreatedBy, "Created by"],
    [F.Updated, "Updated at"],
    [F.Project, "Project"],
    [F.Tags, "Tags"],
    [F.SessionId, "Session ID"],
    [F.Autonomy, "Autonomy"],
    [F.Harness, "Harness"],
    [F.Model, "Model"],
    [F.Repository, "Repository"],
    [F.OtherRepositories, "Other repositories"],
    [F.Started, "Started at"],
    [F.LastActive, "Last active at"],
    [F.Duration, "Duration"],
    [F.InputTokens, "Input tokens"],
    [F.OutputTokens, "Output tokens"],
    [F.CacheReadTokens, "Cache read tokens"],
    [F.CacheWriteTokens, "Cache write tokens"],
    [F.Cost, "Estimated cost"],
    [F.Branch, "Branches"],
    [F.PullRequests, "Pull requests"],
    [F.SubagentCount, "Number of subagents"],
    [F.ToolUseCount, "Number of tool calls"],
    [F.ErrorCount, "Number of errors"],
  ],
  Branch: [
    [F.Name, "Name"],
    [F.Slug, "Slug"],
    [F.Owner, "Owner"],
    [F.Collaborators, "Collaborators"],
    [F.Status, "Status"],
    [F.Priority, "Priority"],
    [F.DueDate, "Due date"],
    [F.CreatedAt, "Created at"],
    [F.CreatedBy, "Created by"],
    [F.Updated, "Updated at"],
    [F.Project, "Project"],
    [F.Parent, "Parent"],
    [F.Tags, "Tags"],
    [F.Repository, "Repository"],
    [F.PullRequests, "Pull Request"],
    [F.ChecksStatus, "Checks status"],
    [F.Changes, "Changes"],
    [F.CommitCount, "Commit count"],
    [F.Cost, "Estimated cost"],
    [F.LocPerDollar, "LOC / $"],
    [F.LinkedSessions, "Sessions"],
  ],
} as const satisfies Record<
  string,
  readonly (readonly [DetailsFieldId, string])[]
>;

/**
 * The Issue reuse check keeps what the Issue page has today; it is not in
 * ISS-12197, so only its set is pinned, not an order.
 */
const ISSUE_FIELDS = [
  F.Name, // the issue title, editable in production
  F.Status, // issue metadata bar
  F.Priority, // issue metadata bar
  F.Assignee, // issue metadata bar
  F.Project, // issue header "Move to project"
  F.IssueId, // the issue slug
  F.DueDate, // artifacts grid due date
  F.Tags, // document-metadata-bar.tsx TagPicker
] as const satisfies readonly DetailsFieldId[];

const rowsOf = (config: DetailsConfig) => [...config.core, ...config.linkRows];

describe.each([
  ["Session", sessionDetailsConfig],
  ["Branch", branchDetailsConfig],
] as const)("%s Details rows (ISS-12197)", (type, configFor) => {
  const config = configFor(DETAILS_DESIGN_HOST);

  it("carries the ticket's core rows, in the ticket's order, under its labels", () => {
    expect(config.core.map((field) => [field.id, field.label])).toEqual(
      ISS_12197_ROWS[type]
    );
  });
});

describe("Issue Details rows (reuse check)", () => {
  it("carries exactly the Issue page's field set", () => {
    const rows = rowsOf(issueDetailsConfig(DETAILS_DESIGN_HOST)).map(
      (field) => field.id
    );
    expect([...rows].sort()).toEqual([...ISSUE_FIELDS].sort());
  });
});

describe.each([
  ["Session", sessionDetailsConfig],
  ["Branch", branchDetailsConfig],
  ["Issue", issueDetailsConfig],
] as const)("%s Details blocks", (_type, configFor) => {
  const config = configFor(DETAILS_DESIGN_HOST);

  it("draws the prototype's blocks, leaving out a block with no rows", () => {
    const { container } = renderDetails(config);
    const expected = [
      DetailsSectionId.Core,
      ...(config.customFields.length > 0
        ? [DetailsSectionId.CustomFields]
        : []),
      ...(config.linked.length + config.linkRows.length > 0
        ? [DetailsSectionId.Links]
        : []),
    ];

    const rendered = [
      ...container.querySelectorAll<HTMLElement>("[data-details-section]"),
    ].map((section) => section.dataset.detailsSection);
    expect(rendered).toEqual(expected);
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent)
    ).toEqual(
      expected
        .filter((id) => id !== DetailsSectionId.Core)
        .map((id) => DETAILS_SECTION_TITLES[id])
    );
  });

  it("has no revision history or Activity section", () => {
    const { container } = renderDetails(config);

    // Located through the constants the components render, never a re-typed
    // string (ISS-10792 AC): the prototype's own history heading, the
    // shell's label for the tab that owns history, and the known block ids.
    // The test below proves the history locator finds the prototype's.
    expect(
      screen.queryByRole("heading", { name: ARTIFACT_VERSION_HISTORY_TITLE })
    ).toBeNull();
    expect(
      screen.queryByRole("heading", {
        name: ARTIFACT_DETAIL_TAB_LABELS[ArtifactDetailTab.Activity],
      })
    ).toBeNull();
    const known: readonly string[] = Object.values(DetailsSectionId);
    const unknown = [
      ...container.querySelectorAll<HTMLElement>("[data-details-section]"),
    ]
      .map((section) => section.dataset.detailsSection ?? "")
      .filter((id) => !known.includes(id));
    expect(unknown).toEqual([]);
  });

  it("carries priority through the canonical priority control", () => {
    renderDetails(config);

    expect(
      screen.getByRole("button", { name: PRIORITY_TRIGGER })
    ).toHaveAttribute("aria-haspopup", "menu");
  });

  it.each([DetailsAvailability.Offline, DetailsAvailability.NoPermission])(
    "locks every editable field with the host's reason when %s",
    (mode) => {
      const editable = [...rowsOf(config), ...config.customFields].filter(
        (field) => field.edit.mode === "editable"
      );
      renderDetails(config, mode);

      expect(
        screen.queryByRole("button", { name: PRIORITY_TRIGGER })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: EDIT_BUTTON })
      ).not.toBeInTheDocument();
      expect(editable.length).toBeGreaterThan(0);
      for (const field of editable) {
        const lock = screen.getByRole("button", {
          name: config.readOnlyName(field.label, config.viewerReasons[mode]),
        });
        // A situation lock is a tab stop: the field would otherwise be editable.
        expect(lock).not.toHaveAttribute("tabindex", "-1");
      }
    }
  );
});

describe("Empty-row rule (ISS-12197)", () => {
  const readOnly = {
    mode: "read-only",
    reason: { kind: DetailsReadOnlyKind.NotEditable, text: "Test: derived." },
  } as const;
  const readOnlyRow = (
    id: DetailsFieldId,
    value: DetailsField["value"]
  ): DetailsField<DetailsFieldId> =>
    ({ edit: readOnly, id, label: id, value }) as DetailsField<DetailsFieldId>;

  it("leaves out a read-only row whose value is empty, per kind", () => {
    renderDetails(
      configOf([
        readOnlyRow(F.Slug, { kind: "text", text: "  " }),
        readOnlyRow(F.Tags, { kind: "tags", tags: [] }),
        readOnlyRow(F.DueDate, { date: null, kind: "date" }),
        readOnlyRow(F.CreatedBy, { choices: [], kind: "person", name: "" }),
        readOnlyRow(F.Parent, {
          empty: true,
          kind: "custom",
          render: () => "Test: should not render",
        }),
        readOnlyRow(F.Collaborators, { kind: "people", people: [] }),
      ])
    );

    for (const id of [
      F.Slug,
      F.Tags,
      F.DueDate,
      F.CreatedBy,
      F.Parent,
      F.Collaborators,
    ]) {
      expect(cellOf(id)).toBeNull();
    }
    expect(screen.queryByText("Test: should not render")).toBeNull();
  });

  it("draws a read-only row that has a value, a custom cell the host did not mark empty, and never-empty kinds", () => {
    renderDetails(
      configOf([
        readOnlyRow(F.Slug, { kind: "text", text: "SES-0001" }),
        readOnlyRow(F.Parent, {
          kind: "custom",
          render: () => "Test: parent",
        }),
        readOnlyRow(F.Changes, {
          additions: 0,
          deletions: 0,
          kind: "changes",
        }),
      ])
    );

    expect(cellOf(F.Slug)).toHaveTextContent("SES-0001");
    expect(cellOf(F.Parent)).toHaveTextContent("Test: parent");
    expect(cellOf(F.Changes)).not.toBeNull();
  });

  it("draws an empty read-only row the host did not mark never-written: a writable field this tab locks", () => {
    renderDetails(
      configOf([
        {
          edit: { mode: "read-only" },
          id: F.Project,
          label: "Owning project",
          value: { kind: "text", text: "" },
        },
        {
          edit: {
            mode: "read-only",
            reason: { kind: DetailsReadOnlyKind.NotEditable },
          },
          id: F.Repository,
          label: "Repository",
          value: { kind: "text", text: "" },
        },
      ])
    );

    expect(cellOf(F.Project)).toHaveTextContent(DETAILS_EMPTY_VALUE);
    // A never-written marker with no wording draws no lock.
    expect(screen.queryByRole("button")).toBeNull();
    expect(cellOf(F.Repository)).toBeNull();
  });

  it("always draws an editable row, even with no value", () => {
    renderDetails(
      configOf([
        {
          edit: { mode: "editable", onSave: () => Promise.resolve() },
          id: F.DueDate,
          label: "Due date",
          value: { date: null, kind: "date" },
        },
      ])
    );

    expect(
      within(cellOf(F.DueDate)).getByRole("button", { name: "Edit due date" })
    ).toHaveTextContent(DETAILS_EMPTY_VALUE);
  });

  it.each([DetailsAvailability.Offline, DetailsAvailability.NoPermission])(
    "keeps an empty editable row under a situation lock when %s",
    (mode) => {
      renderDetails(
        configOf([
          {
            edit: { mode: "editable", onSave: () => Promise.resolve() },
            id: F.DueDate,
            label: "Due date",
            value: { date: null, kind: "date" },
          },
        ]),
        mode
      );

      expect(cellOf(F.DueDate)).toHaveTextContent(DETAILS_EMPTY_VALUE);
    }
  );

  it("leaves out a block whose every row is empty", () => {
    const { container } = renderDetails(
      configOf(
        [readOnlyRow(F.Name, { kind: "text", text: "Test: name" })],
        [
          {
            edit: readOnly,
            id: "cf-empty",
            label: "Test: empty custom field",
            value: { kind: "text", text: "" },
          },
        ]
      )
    );

    expect(
      container.querySelector(
        `[data-details-section="${DetailsSectionId.CustomFields}"]`
      )
    ).toBeNull();
  });
});

describe("Details labels", () => {
  it("finds the prototype's version history through the same constant", () => {
    render(
      <TooltipProvider>
        <CommonArtifactDetails artifact={genericArtifacts[0]!} />
      </TooltipProvider>
    );
    expect(
      screen.getByRole("heading", { name: ARTIFACT_VERSION_HISTORY_TITLE })
    ).toBeInTheDocument();
  });
});

describe("Flag-gated rows", () => {
  const gated = (flag: DetailsRowFlag, id: DetailsFieldId) =>
    ({
      edit: { mode: "read-only" },
      flag,
      id,
      label: id,
      value: { kind: "text", text: "Test: gated" },
    }) as const;
  const config = () =>
    configOf([
      gated(DetailsRowFlag.LaunchAttribution, DetailsFieldId.FirstSkill),
      gated(DetailsRowFlag.SessionsTags, DetailsFieldId.Tags),
      {
        edit: { mode: "read-only" },
        id: DetailsFieldId.Harness,
        label: "Harness",
        value: { kind: "text", text: "Test: ungated" },
      },
    ]);

  it.each([
    [
      DetailsRowFlag.LaunchAttribution,
      DetailsFieldId.FirstSkill,
      DetailsFieldId.Tags,
    ],
    [
      DetailsRowFlag.SessionsTags,
      DetailsFieldId.Tags,
      DetailsFieldId.FirstSkill,
    ],
  ] as const)("%s turns on its own row only", (flag, own, other) => {
    renderDetails(config(), DetailsAvailability.CanEdit, [flag]);
    expect(cellOf(own)).not.toBeNull();
    expect(cellOf(other)).toBeNull();
    expect(cellOf(DetailsFieldId.Harness)).not.toBeNull();
  });

  it("ships the Session fixture's Tags row behind its production flag", () => {
    renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      []
    );
    expect(cellOf(DetailsFieldId.Tags)).toBeNull();
    expect(cellOf(DetailsFieldId.Harness)).not.toBeNull();
  });

  it("uses production's other LOC / $ label while its flag is on", () => {
    const loc =
      LOC_METRIC_DEFINITION[LocMetricDefinitionId.BranchDetailPublicationLoc];
    const ticketLabel = ISS_12197_ROWS.Branch.find(
      ([id]) => id === F.LocPerDollar
    )?.[1];
    const { unmount } = renderDetails(
      branchDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      [DetailsRowFlag.OneLabelPerMetric]
    );
    expect(
      screen.getByRole("group", { name: loc.canonicalLabel })
    ).toBeInTheDocument();
    unmount();

    renderDetails(branchDetailsConfig(DETAILS_DESIGN_HOST));
    expect(
      screen.getByRole("group", { name: ticketLabel })
    ).toBeInTheDocument();
  });
});

describe("DetailsSections editing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the prototype's editors where production writes the field", () => {
    renderDetails(issueDetailsConfig(DETAILS_DESIGN_HOST));

    expect(screen.getByRole("button", { name: "Edit name" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit project" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit due date" })).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Edit assignee, currently Taylor Morgan",
      })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: PRIORITY_TRIGGER })
    ).toBeVisible();
  });

  it("keeps Session tags editable", () => {
    renderDetails(sessionDetailsConfig(DETAILS_DESIGN_HOST));

    expect(
      within(cellOf(F.Tags)).getByRole("button", {
        name: "Edit tags: Design system",
      })
    ).toBeInTheDocument();
  });

  it("saves a text field from its popover on Enter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    renderDetails(oneTextField(onSave));

    await user.click(screen.getByRole("button", { name: "Edit risk" }));
    await user.type(
      screen.getByRole("textbox", { name: "Risk" }),
      "High{Enter}"
    );

    expect(onSave).toHaveBeenCalledWith({ kind: "text", text: "High" });
    expect(
      await screen.findByRole("button", { name: "Edit risk" })
    ).toHaveTextContent("High");
    expect(screen.queryByRole("textbox", { name: "Risk" })).toBeNull();
  });

  it("discards the draft on Escape without saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    renderDetails(oneTextField(onSave));

    await user.click(screen.getByRole("button", { name: "Edit risk" }));
    await user.type(screen.getByRole("textbox", { name: "Risk" }), "High");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "Risk" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Edit risk" })
    ).not.toHaveTextContent("High");
  });

  it("discards the draft on Cancel without saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    renderDetails(oneTextField(onSave));

    await user.click(screen.getByRole("button", { name: "Edit risk" }));
    await user.type(screen.getByRole("textbox", { name: "Risk" }), "High");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox", { name: "Risk" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Edit risk" })
    ).not.toHaveTextContent("High");
  });

  it("keeps the draft and shows the host's error when the save rejects", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.reject(new Error("nope")));
    renderDetails(oneTextField(onSave));

    await user.click(screen.getByRole("button", { name: "Edit risk" }));
    await user.type(screen.getByRole("textbox", { name: "Risk" }), "High");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ kind: "text", text: "High" });
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    const input = screen.getByRole("textbox", { name: "Risk" });
    expect(input).toHaveValue("High");
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("cannot be dismissed or cancelled while a save is pending", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const onSave = vi.fn(() => pending.promise);
    renderDetails(oneTextField(onSave));

    await user.click(screen.getByRole("button", { name: "Edit risk" }));
    await user.type(screen.getByRole("textbox", { name: "Risk" }), "High");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: "Risk" })).toBeInTheDocument();

    pending.reject(new Error("refused"));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    expect(screen.getByRole("textbox", { name: "Risk" })).toHaveValue("High");
  });

  it("changes the assignee through the owner menu", async () => {
    const user = userEvent.setup();
    renderDetails(issueDetailsConfig(DETAILS_DESIGN_HOST));

    await user.click(
      screen.getByRole("button", {
        name: "Edit assignee, currently Taylor Morgan",
      })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Jordan Kim" })
    );

    expect(
      await screen.findByRole("button", {
        name: "Edit assignee, currently Jordan Kim",
      })
    ).toBeVisible();
  });

  it("rolls a refused menu choice back and says so, without undoing a newer one", async () => {
    const user = userEvent.setup();
    const first = deferred();
    const second = deferred();
    const onSave = vi
      .fn<(next: DetailsFieldValue) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderDetails(
      configOf([
        {
          edit: { mode: "editable", onSave },
          id: F.Assignee,
          label: "Assignee",
          value: { choices: ["Ann", "Bo", "Cy"], kind: "person", name: "Ann" },
        },
      ])
    );

    await user.click(screen.getByRole("button", { name: EDIT_BUTTON }));
    await user.click(await screen.findByRole("menuitem", { name: "Bo" }));
    await user.click(screen.getByRole("button", { name: EDIT_BUTTON }));
    await user.click(await screen.findByRole("menuitem", { name: "Cy" }));
    first.reject(new Error("stale"));
    second.resolve();
    expect(
      await screen.findByRole("button", { name: "Edit assignee, currently Cy" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when a priority write is refused", async () => {
    const user = userEvent.setup();
    renderDetails(
      configOf([
        {
          edit: {
            mode: "editable",
            onSave: () => Promise.reject(new Error("no")),
          },
          id: F.Priority,
          label: "Priority",
          value: {
            kind: "priority",
            priority: "MEDIUM",
            support: ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Session],
          },
        },
      ])
    );

    await user.click(screen.getByRole("button", { name: "Priority: Medium" }));
    await user.click(await screen.findByRole("menuitem", { name: "High" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    expect(
      screen.getByRole("button", { name: "Priority: Medium" })
    ).toBeInTheDocument();
  });

  it("says so when a status write is refused", async () => {
    const user = userEvent.setup();
    const status = issueDetailsConfig(DETAILS_DESIGN_HOST).core.find(
      (field) => field.id === F.Status
    );
    if (status?.value.kind !== "status") {
      throw new Error("the Issue fixture carries an editable status");
    }
    renderDetails(
      configOf([
        {
          edit: {
            mode: "editable",
            onSave: () => Promise.reject(new Error("no")),
          },
          id: F.Status,
          label: status.label,
          value: status.value,
        },
      ])
    );

    await user.click(screen.getByRole("button", { name: STATUS_TRIGGER }));
    await user.click(
      await screen.findByRole("menuitem", { name: DONE_OPTION })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
  });

  it("rolls back and says so when the latest of two writes is refused", async () => {
    const user = userEvent.setup();
    const first = deferred();
    const second = deferred();
    const onSave = vi
      .fn<(next: DetailsFieldValue) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderDetails(
      configOf([
        {
          edit: { mode: "editable", onSave },
          id: F.Assignee,
          label: "Assignee",
          value: { choices: ["Ann", "Bo", "Cy"], kind: "person", name: "Ann" },
        },
      ])
    );

    await user.click(screen.getByRole("button", { name: EDIT_BUTTON }));
    await user.click(await screen.findByRole("menuitem", { name: "Bo" }));
    await user.click(screen.getByRole("button", { name: EDIT_BUTTON }));
    await user.click(await screen.findByRole("menuitem", { name: "Cy" }));
    first.resolve();
    second.reject(new Error("refused"));

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    expect(
      screen.getByRole("button", { name: "Edit assignee, currently Bo" })
    ).toBeInTheDocument();
  });

  it("returns to the last confirmed tags when two quick toggles are both refused", async () => {
    const user = userEvent.setup();
    const first = deferred();
    const second = deferred();
    const onSave = vi
      .fn<(next: DetailsFieldValue) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderDetails(tagsField(onSave));

    await user.click(
      screen.getByRole("button", { name: "Edit tags: Product" })
    );
    await user.click(
      await screen.findByRole("button", { name: RESEARCH_OPTION })
    );
    await user.click(
      await screen.findByRole("button", { name: DESIGN_OPTION })
    );
    first.reject(new Error("refused"));
    second.reject(new Error("refused"));

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_ERROR);
    expect(
      screen.getByRole("button", { name: "Edit tags: Product" })
    ).toBeInTheDocument();
  });

  it("gives an empty editable tags row a visible, named affordance", () => {
    renderDetails(branchDetailsConfig(DETAILS_DESIGN_HOST));
    const trigger = within(cellOf(F.Tags)).getByRole("button", {
      name: "Edit tags",
    });

    expect(trigger).toHaveTextContent(DETAILS_EMPTY_VALUE);
  });

  it("edits priority through the editor menu, never a text input", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    renderDetails(
      configOf([
        {
          edit: { mode: "editable", onSave },
          id: F.Priority,
          label: "Priority",
          value: {
            kind: "priority",
            priority: "MEDIUM",
            support: ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Session],
          },
        },
      ])
    );

    await user.click(screen.getByRole("button", { name: "Priority: Medium" }));
    const high = await screen.findByRole("menuitem", { name: "High" });
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(high);

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "priority", priority: "HIGH" })
    );
    expect(
      await screen.findByRole("button", { name: "Priority: High" })
    ).toBeInTheDocument();
  });
});
