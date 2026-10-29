import { DETAILS_DESIGN_HOST } from "@repo/app/documents/components/details-design/details-design-preview-host";
import { DetailsAvailability } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import {
  SESSION_DETAILS_TAB_CODEX_FIXTURE,
  sessionDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import { forDetailsTabViewer } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { DetailsTabFrame, detailsTabFixtureConfig } from "./v2-details-tab";

// ISS-12252: the Details tab, for every artifact type the mocks cover
// (Session, Branch, Document, Issue). From the Details tab requirements meeting
// (2026-10-07) and the Oct 9 sync (ISS-12403): every type has the same four
// sections, mirroring the database -- Artifact details, "<Type> details",
// Custom fields, then Associated artifacts grouped by type -- each an inner
// card inside one large card on the Artifact tab's canvas. Editable values
// show only a hover background and a pointer cursor; there is no pencil, lock
// or badge. The same tab is the Details Tab of Session, Branch, Document and
// Issue Detail.
//
// Controls are disabled: each story is one type's fixture.

const meta = {
  title: "Composites/Shared/Artifact Detail/Details Tab",
  tags: ["stable"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const VERSION_HISTORY = /version history/i;
const EDIT_NAME = /^Edit name/;

/** The section headings, in order. */
function groupHeadings(canvasElement: HTMLElement) {
  return within(canvasElement)
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent?.trim());
}

/**
 * A Session: Artifact details, then Session details, which holds the usage
 * rows and Repository with no sub-header. Its branch and pull requests are
 * only in Associated artifacts; Lines changed is the branch's, on its canvas.
 */
export const Session: Story = {
  render: () => <DetailsTabFrame config={detailsTabFixtureConfig("session")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(groupHeadings(canvasElement)).toEqual([
      "Artifact details",
      "Session details",
      "Custom fields",
      "Associated artifacts",
    ]);
    await expect(
      canvas.queryByRole("group", { name: "Lines changed" })
    ).toBeNull();
    await expect(
      canvas.getByRole("heading", {
        level: 3,
        name: "Branches & pull requests",
      })
    ).toBeVisible();
    // Asana's editability: no pencils, no locks.
    await expect(canvasElement.querySelector(".lucide-pencil")).toBeNull();
    // A session may have several parents.
    await expect(canvas.getByRole("group", { name: "Parents" })).toBeVisible();
    // Version history is the canvas's dropdown, and Activity is its own tab.
    await expect(canvas.queryByText(VERSION_HISTORY)).toBeNull();
  },
};

/**
 * A viewer who cannot edit: every value is read-only, so none has the hover
 * cue. The reason is said once at the top, and is each row's description.
 */
export const NoPermission: Story = {
  render: () => (
    <DetailsTabFrame
      config={forDetailsTabViewer(
        detailsTabFixtureConfig("document"),
        DetailsAvailability.NoPermission
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: EDIT_NAME })).toBeNull();
  },
};

/**
 * A Codex session: no cache-write split, and the Codex runtime rows the
 * Properties panel shows today (context window, latest turn, rate limits), in
 * Session details with no sub-header.
 */
export const SessionCodex: Story = {
  name: "Session (Codex)",
  render: () => (
    <DetailsTabFrame
      config={sessionDetailsTabConfig(
        DETAILS_DESIGN_HOST,
        SESSION_DETAILS_TAB_CODEX_FIXTURE
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(groupHeadings(canvasElement)).not.toContain("Codex runtime");
    await expect(
      canvas.getByRole("group", { name: "Rate limit (weekly)" })
    ).toBeVisible();
    await expect(
      canvas.queryByRole("group", { name: "Cache write TTL" })
    ).toBeNull();
  },
};

/**
 * A Branch: Artifact details, then Branch details (its git, pull request and
 * usage rows); no custom fields. The Pull request row is the number, title and
 * state. The sessions that worked it are in Associated artifacts.
 */
export const Branch: Story = {
  render: () => <DetailsTabFrame config={detailsTabFixtureConfig("branch")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(groupHeadings(canvasElement)).toEqual([
      "Artifact details",
      "Branch details",
      "Associated artifacts",
    ]);
    const pullRequest = canvas.getByRole("group", { name: "Pull request" });
    await expect(within(pullRequest).getByText("In review")).toBeVisible();
  },
};

/**
 * A Document (a PRD): its current version as Document details, and its
 * repositories, read-only, with the artifact fields (PRD-799, ISS-12572).
 */
export const Document: Story = {
  render: () => (
    <DetailsTabFrame config={detailsTabFixtureConfig("document")} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(groupHeadings(canvasElement)).toEqual([
      "Artifact details",
      "Document details",
      "Custom fields",
      "Associated artifacts",
    ]);
    await expect(
      canvas.getByRole("group", { name: "Current version" })
    ).toBeVisible();
    await expect(
      canvas.getByRole("group", { name: "Repositories" })
    ).toBeVisible();
  },
};

/**
 * An Issue (ISS-12586): Issue details holds its status, closed reason, parent
 * issue, sub-issues, linked branch and external links.
 */
export const Issue: Story = {
  render: () => <DetailsTabFrame config={detailsTabFixtureConfig("issue")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(groupHeadings(canvasElement)).toEqual([
      "Artifact details",
      "Issue details",
      "Custom fields",
      "Associated artifacts",
    ]);
    for (const name of [
      "Issue status",
      "Closed reason",
      "Parent issue",
      "Sub-issues",
      "Linked branch",
      "External links",
    ]) {
      await expect(canvas.getByRole("group", { name })).toBeVisible();
    }
  },
};

/** A phone-width column: the label column narrows and long values truncate. */
export const Narrow: Story = {
  render: () => (
    <div className="max-w-[390px] border-r">
      <DetailsTabFrame config={detailsTabFixtureConfig("session")} />
    </div>
  ),
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

export const Dark: Story = {
  render: () => <DetailsTabFrame config={detailsTabFixtureConfig("session")} />,
  globals: { theme: "dark" },
};
