// @vitest-environment jsdom

import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { DOCUMENT_ROUTE_PREFIX } from "@repo/api/src/types/document";
import { SESSION_COST_POPULATION_NOTE } from "@repo/app/agents/components/detail/session-population-notes";
import { DETAILS_DESIGN_HOST } from "@repo/app/documents/components/details-design/details-design-preview-host";
import {
  SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
  SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINKED_ARTIFACT_GROUP_HEADINGS } from "../../components/linked-artifact-groups";
import {
  branchDetailsConfig,
  FIXTURE_INCOMPLETE_NOTE,
  FIXTURE_REASONS,
  SESSION_COLLABORATOR_FIXTURES,
  sessionDetailsConfig,
} from "../details-design-fixtures";
import {
  DetailsAvailability,
  type DetailsField,
  DetailsFieldId,
  DetailsReadOnlyKind,
  DetailsSectionId,
  forViewer,
} from "../details-design-model";
import { DETAILS_EMPTY_VALUE } from "../details-field-value";

import {
  BRANCH_ISSUE_LINK,
  BRANCH_PR_LINK,
  CLAUDE_REPORTED,
  cellOf,
  collaborators,
  DURATION_EVIDENCE,
  ISSUE_LINK,
  PR_LINK,
  READ_ONLY_NAME,
  renderDetails,
} from "./details-test-support";

/** ISS-10792 harness: read-only values, reasons and custom cells. */

const F = DetailsFieldId;

describe("Collaborators (ISS-10992 input)", () => {
  it("draws a complete Session list as read-only avatars", () => {
    renderDetails(
      sessionDetailsConfig(
        DETAILS_DESIGN_HOST,
        SESSION_COLLABORATOR_FIXTURES.complete
      )
    );
    const cell = cellOf(F.Collaborators);

    // ISS-12273: the shared widget makes ONE accessibility statement — the
    // wrapper names every collaborator and the avatars are decorative — so the
    // whole list is asserted here rather than one person at a time.
    expect(
      within(cell).getByRole("img", { name: "Alex Rivera, Jordan Kim" })
    ).toBeInTheDocument();
    // No add or remove: the only control is the read-only lock.
    expect(
      within(cell)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([expect.stringMatching(READ_ONLY_NAME)]);
  });

  /*
   * ISS-12273 removed the host's partial-list note (operator ruling,
   * 2026-10-08). What is still true, and what this pins, is that a partial list
   * draws the people it DID read — the sibling cases below cover the other half,
   * that an EMPTY partial list draws the unknown glyph rather than nothing.
   *
   * The absence arm names the removed note, so a note coming back fails here.
   */
  it("draws a partial list's people, with no note beside them (ISS-12273)", () => {
    const incomplete = SESSION_COLLABORATOR_FIXTURES.incomplete;
    renderDetails(sessionDetailsConfig(DETAILS_DESIGN_HOST, incomplete));
    const cell = cellOf(F.Collaborators);

    expect(
      within(cell).getByRole("img", { name: "Alex Rivera" })
    ).toBeInTheDocument();
    expect(cell).not.toHaveTextContent(FIXTURE_INCOMPLETE_NOTE);
  });

  it("keeps two different people who share a display name apart", () => {
    // whitlockk, #8461: the stack deduped on the DISPLAY NAME, so two distinct
    // users called "Alex Smith" drew one avatar and a count one short. Identity
    // is the person KEY; the name is only what renders. ISS-12273 moved the
    // dedupe into the shared widget, which states the whole list on its wrapper
    // — so BOTH Alex Smiths appearing in that one name is the assertion.
    renderDetails(
      collaborators({
        availability: BranchIdentityAvailability.Complete,
        kind: "people",
        people: [
          { key: "user_1", name: "Alex Smith" },
          { key: "user_2", name: "Alex Smith" },
        ],
      })
    );
    const cell = cellOf(F.Collaborators);

    expect(
      within(cell).getByRole("img", { name: "Alex Smith, Alex Smith" })
    ).toBeInTheDocument();
  });

  it("never draws an unavailable Session list as empty", () => {
    renderDetails(
      sessionDetailsConfig(
        DETAILS_DESIGN_HOST,
        SESSION_COLLABORATOR_FIXTURES.unavailable
      )
    );
    const cell = cellOf(F.Collaborators);

    expect(cell).toHaveTextContent(DETAILS_EMPTY_VALUE);
  });

  it.each([
    {
      availability: BranchIdentityAvailability.Unavailable,
      kind: "people",
      people: [],
    },
    {
      availability: BranchIdentityAvailability.Incomplete,
      kind: "people",
      people: [],
    },
  ] as const)(
    "never claims an empty list when evidence is $availability",
    (value) => {
      renderDetails(collaborators(value));
      const cell = cellOf(F.Collaborators);

      expect(cell).toHaveTextContent(DETAILS_EMPTY_VALUE);
    }
  );

  it("leaves out a fully read empty list (ISS-12197 empty-row rule)", () => {
    renderDetails(
      collaborators({
        availability: BranchIdentityAvailability.Complete,
        kind: "people",
        people: [],
      })
    );

    expect(cellOf(F.Collaborators)).toBeNull();
  });

  it("draws Branch collaborators as read-only avatars", () => {
    renderDetails(branchDetailsConfig(DETAILS_DESIGN_HOST));
    const cell = cellOf(F.Collaborators);

    // ISS-12273: one statement on the wrapper, so the whole list is asserted.
    expect(
      within(cell).getByRole("img", {
        name: "Sam Lee, Alex Rivera, Jordan Kim",
      })
    ).toBeInTheDocument();
    expect(
      within(cell)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([expect.stringMatching(READ_ONLY_NAME)]);
  });
});

// The Created at assertion below is viewer-local by design, so it only means
// something against a pinned zone: unpinned, the fixture's 14:02Z instant is
// Sep 21 from UTC+10 eastward.
const VIEWER_TIME_ZONE = "America/Chicago";
const ORIGINAL_TIME_ZONE = process.env.TZ;

describe("Read-only reasons and custom cells", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreTimeZone(ORIGINAL_TIME_ZONE);
  });

  it("opens a not-editable reason on click, so touch can reach it", async () => {
    const user = userEvent.setup();
    const config = sessionDetailsConfig(DETAILS_DESIGN_HOST);
    renderDetails(config);
    const lock = screen.getByRole("button", {
      name: config.readOnlyName("Harness", FIXTURE_REASONS.fromHarness),
    });
    // Out of the tab order (a never-editable field), yet the reason is the
    // value's accessible description.
    expect(lock).toHaveAttribute("tabindex", "-1");
    expect(cellOf(F.Harness)).toHaveAccessibleDescription(
      FIXTURE_REASONS.fromHarness
    );
    await user.click(lock);
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      FIXTURE_REASONS.fromHarness
    );
  });

  it("keeps +N more as a disclosure that collapses again", async () => {
    const user = userEvent.setup();
    renderDetails(sessionDetailsConfig(DETAILS_DESIGN_HOST));
    const cell = cellOf(F.LinkedArtifacts);

    const more = within(cell).getByRole("button", {
      name: "Show 2 more linked artifacts",
    });
    expect(more).toHaveTextContent("+2");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(cell).getAllByRole("link")).toHaveLength(3);

    await user.click(more);
    expect(within(cell).getByRole("button", { name: "Show less" })).toBe(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(cell).getAllByRole("link")).toHaveLength(5);

    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(cell).getAllByRole("link")).toHaveLength(3);
  });

  it("states production's Cost sentence only behind its flag", () => {
    const { unmount } = renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      [SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY]
    );
    expect(cellOf(F.Cost)).toHaveTextContent(SESSION_COST_POPULATION_NOTE);
    unmount();

    renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      []
    );
    expect(cellOf(F.Cost)).not.toHaveTextContent(SESSION_COST_POPULATION_NOTE);
  });

  it("pairs the estimate with Claude's figure only behind its flag", () => {
    const { unmount } = renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      [SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY]
    );
    expect(cellOf(F.Cost)).toHaveTextContent(CLAUDE_REPORTED);
    unmount();

    renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      []
    );
    expect(cellOf(F.Cost)).not.toHaveTextContent(CLAUDE_REPORTED);
  });

  it("shows duration evidence only behind its production flag", () => {
    const { unmount } = renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY]
    );
    expect(cellOf(F.Duration)).toHaveTextContent(DURATION_EVIDENCE);
    unmount();

    renderDetails(
      sessionDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.CanEdit,
      []
    );
    expect(cellOf(F.Duration)).toHaveTextContent("46m 37s");
    expect(cellOf(F.Duration)).not.toHaveTextContent(DURATION_EVIDENCE);
  });

  it("draws the counts through the design-system count cell, zero as its em-dash", () => {
    renderDetails(sessionDetailsConfig(DETAILS_DESIGN_HOST));

    expect(cellOf(F.ToolUseCount)).toHaveTextContent("148");
    expect(cellOf(F.ToolUseCount)).toHaveTextContent("148 tool calls");
    expect(cellOf(F.ErrorCount)).toHaveTextContent(DETAILS_EMPTY_VALUE);
    expect(cellOf(F.ErrorCount)).toHaveTextContent("No errors");
  });

  it("draws date-times viewer-local and the Parent as one pill", () => {
    process.env.TZ = VIEWER_TIME_ZONE;
    renderDetails(branchDetailsConfig(DETAILS_DESIGN_HOST));

    // `formatDateTime`'s viewer-local spelling, never the ISO string.
    expect(cellOf(F.CreatedAt)).toHaveTextContent("Sep 20, 2026 at 9:02 AM");
    expect(cellOf(F.CreatedAt)).not.toHaveTextContent("2026-09-20T14:02:00");
    expect(
      within(cellOf(F.Parent)).getByRole("link", { name: BRANCH_ISSUE_LINK })
    ).toHaveAttribute("href", `/fixture-org/${DOCUMENT_ROUTE_PREFIX}/ISS-0004`);
  });

  it("copies the session ID under production's name and claims Copied only on a real write", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.reject(new Error("insecure")));
    vi.spyOn(globalThis.navigator, "clipboard", "get").mockReturnValue({
      writeText,
    } as unknown as Clipboard);
    renderDetails(sessionDetailsConfig(DETAILS_DESIGN_HOST));
    const cell = cellOf(F.SessionId);

    await user.click(
      within(cell).getByRole("button", { name: "Copy session id" })
    );

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(
      within(cell).getByRole("button", { name: "Copy session id" })
    ).toBeInTheDocument();
    expect(
      within(cell).queryByRole("button", { name: "Copied session id" })
    ).toBeNull();
  });

  it("points Session pills at the record's production route", () => {
    renderDetails(sessionDetailsConfig(DETAILS_DESIGN_HOST));

    expect(
      within(cellOf(F.LinkedArtifacts)).getByRole("link", { name: ISSUE_LINK })
    ).toHaveAttribute("href", `/fixture-org/${DOCUMENT_ROUTE_PREFIX}/ISS-0001`);
    const pr = within(cellOf(F.PullRequests)).getByRole("link", {
      name: PR_LINK,
    });
    expect(pr).toHaveAttribute(
      "href",
      "https://github.com/fixture-org/fixture-repo/pull/101"
    );
    expect(pr).toHaveAttribute("target", "_blank");
  });

  it("points Branch linked rows at the record's production route", () => {
    renderDetails(branchDetailsConfig(DETAILS_DESIGN_HOST));

    // ISS-0004 is both the Parent pill and a Linked artifacts record.
    expect(
      screen.getAllByRole("link", { name: BRANCH_ISSUE_LINK })
    ).toHaveLength(2);
    const links = document.querySelector<HTMLElement>(
      `[data-details-section="${DetailsSectionId.Links}"]`
    );
    if (!links) {
      throw new Error("the Branch fixture draws a Linked artifacts block");
    }
    expect(
      within(links).getByRole("link", { name: BRANCH_ISSUE_LINK })
    ).toHaveAttribute("href", `/fixture-org/${DOCUMENT_ROUTE_PREFIX}/ISS-0004`);
    // PLN-2175 M3: the branch's pull request is its field, never a row, and
    // its linked sessions are listed (Kerensa Whitlock 2026-10-09).
    expect(within(links).queryByText(BRANCH_PR_LINK)).toBeNull();
    expect(
      within(links).getByRole("heading", {
        name: LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Session],
      })
    ).toBeInTheDocument();
  });

  it("names each value by its row label", () => {
    const config = branchDetailsConfig(DETAILS_DESIGN_HOST);
    const owner = config.core.find((field) => field.id === F.Owner);
    renderDetails(config);

    expect(screen.getByRole("group", { name: owner?.label })).toContainElement(
      cellOf(F.Owner)
    );
  });
});

describe("Never-editable value kinds", () => {
  it("cannot be typed as editable, nor carry a viewer-situation reason", () => {
    const onSave = () => Promise.resolve();
    const fields: DetailsField[] = [
      // @ts-expect-error a custom cell is never editable
      {
        edit: { mode: "editable", onSave },
        id: "custom",
        label: "Custom",
        value: { kind: "custom", render: () => null },
      },
      // @ts-expect-error a people list is never editable
      {
        edit: { mode: "editable", onSave },
        id: "people",
        label: "People",
        value: { kind: "people", people: [] },
      },
      // @ts-expect-error only "not editable" fits a never-editable kind
      {
        edit: {
          mode: "read-only",
          reason: { kind: DetailsReadOnlyKind.DesktopOffline, text: "x" },
        },
        id: "changes",
        label: "Changes",
        value: { additions: 1, deletions: 1, kind: "changes" },
      },
    ];
    expect(fields).toHaveLength(3);
  });

  it("keeps a never-editable field's own reason when the viewer is offline", () => {
    const config = forViewer(
      branchDetailsConfig(DETAILS_DESIGN_HOST),
      DetailsAvailability.Offline
    );
    const changes = config.core.find((field) => field.id === F.Changes);
    expect(changes?.edit).toEqual({
      mode: "read-only",
      reason: {
        kind: DetailsReadOnlyKind.NotEditable,
        text: FIXTURE_REASONS.fromGit,
      },
    });
  });
});
