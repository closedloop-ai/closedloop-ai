/**
 * Behavior tests for the Project Detail Surface's own story module
 * (`stories/surfaces/projects-detail.stories.tsx`): the hand-composed
 * artifact table's sort wiring and the hand-built Properties panel. The
 * stories render but never sort a column or change a property, so those
 * branches were reachable only from here.
 */
import { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { composeStory } from "@storybook/react";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it } from "vitest";
import projectsDetailMeta, {
  Default as defaultStory,
  NoMatchingArtifacts as noMatchingStory,
  Overview as overviewStory,
} from "../stories/surfaces/projects-detail.stories";

const TYPE_HEADER = /^Type/;
const LOW_OPTION = /Low/;
const CLEAR_SELECTION_OPTION = /Clear selection/;
const MARISOL_OPTION = /Marisol/;
const CASE_TIMEOUT_MS = 30_000;
const ARTIFACTS = projectsDetailMeta.args.documents;

/** The artifact titles in rendered order. */
function renderedTitles(): string[] {
  const titles = ARTIFACTS.map((doc) => doc.title);
  return screen
    .getAllByRole("row")
    .map((row) => titles.find((title) => row.textContent?.includes(title)))
    .filter((title): title is string => title !== undefined);
}

function renderedTypes(): string[] {
  return renderedTitles().map(
    (title) => ARTIFACTS.find((doc) => doc.title === title)?.type ?? ""
  );
}

function sortButton(label: string) {
  const header = screen
    .getAllByRole("columnheader")
    .find((cell) =>
      within(cell).queryByRole("button", { name: new RegExp(`^${label}`) })
    );
  if (!header) {
    throw new Error(`no sortable column header labelled "${label}"`);
  }
  return within(header).getByRole("button", { name: new RegExp(`^${label}`) });
}

async function sortBy(label: string) {
  await userEvent.click(sortButton(label));
}

function byTitle(
  compare: (
    a: (typeof ARTIFACTS)[number],
    b: (typeof ARTIFACTS)[number]
  ) => number
) {
  return [...ARTIFACTS].sort(compare).map((doc) => doc.title);
}

describe("Project Detail artifact table", () => {
  it(
    "sorts by title, type and assignee in both directions",
    async () => {
      await composeStory(defaultStory, projectsDetailMeta).run();
      expect(renderedTitles()).toEqual(ARTIFACTS.map((doc) => doc.title));

      // The lead column reads "Name" in the header and sorts the `title`
      // key; a fresh column's first click sorts descending.
      await sortBy("Name");
      expect(renderedTitles()).toEqual(
        byTitle((a, b) => b.title.localeCompare(a.title))
      );
      await sortBy("Name");
      expect(renderedTitles()).toEqual(
        byTitle((a, b) => a.title.localeCompare(b.title))
      );

      // Ties keep their incoming order (stable sort), so the two directions
      // are compared as type sequences rather than as reversed title lists.
      await sortBy("Type");
      expect(renderedTypes()).toEqual(
        [...ARTIFACTS].map((doc) => doc.type).sort((a, b) => b.localeCompare(a))
      );
      await sortBy("Type");
      expect(renderedTypes()).toEqual(
        [...ARTIFACTS].map((doc) => doc.type).sort((a, b) => a.localeCompare(b))
      );

      await sortBy("Assignee");
      const unassigned = ARTIFACTS.filter((doc) => !doc.assignee).map(
        (doc) => doc.title
      );
      // An empty name sorts before any name, so the unassigned rows end a
      // descending sort and open an ascending one.
      expect(new Set(renderedTitles().slice(-2))).toEqual(new Set(unassigned));
      await sortBy("Assignee");
      expect(new Set(renderedTitles().slice(0, 2))).toEqual(
        new Set(unassigned)
      );
      expect(renderedTitles()[2]).toBe(
        ARTIFACTS.find((doc) => doc.assignee?.firstName === "Ottilie")?.title
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    "sorts by priority through the shared priority comparator",
    async () => {
      await composeStory(defaultStory, projectsDetailMeta).run();

      await sortBy("Priority");
      const asc = renderedTitles();
      expect(asc[0]).toBe(
        ARTIFACTS.find((doc) => doc.priority === Priority.Low)?.title
      );
      await sortBy("Priority");
      expect(renderedTitles()[0]).toBe(
        ARTIFACTS.find((doc) => doc.priority === Priority.Urgent)?.title
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    "switches tabs, narrowing the rows and dropping the Type column off single-category tabs",
    async () => {
      await composeStory(defaultStory, projectsDetailMeta).run();
      expect(sortButton("Type")).toBeVisible();

      await userEvent.click(screen.getByRole("radio", { name: "Plans" }));
      expect(renderedTitles()).toEqual(
        ARTIFACTS.filter(
          (doc) => doc.type === DocumentType.ImplementationPlan
        ).map((doc) => doc.title)
      );
      expect(
        screen
          .getAllByRole("columnheader")
          .some((cell) =>
            within(cell).queryByRole("button", { name: TYPE_HEADER })
          )
      ).toBe(false);

      await userEvent.click(screen.getByRole("radio", { name: "Overview" }));
      expect(
        await screen.findByRole("heading", { name: "Properties" })
      ).toBeVisible();
      expect(screen.queryAllByRole("row")).toHaveLength(0);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "a tab with no matching artifacts shows the filtered empty state",
    async () => {
      await composeStory(noMatchingStory, projectsDetailMeta).run();
      expect(screen.queryAllByRole("row")).toHaveLength(0);
      expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    },
    CASE_TIMEOUT_MS
  );
});

describe("Project Detail overview properties", () => {
  it(
    "changes the priority and clears the assignee through the real controls",
    async () => {
      await composeStory(overviewStory, projectsDetailMeta).run();
      await screen.findByRole("heading", { name: "Properties" });

      const properties = screen.getByRole("heading", {
        name: "Properties",
      }).parentElement;
      if (!properties) {
        throw new Error("Properties panel has no container");
      }
      const [priority, assignee] = within(properties).getAllByRole("combobox");
      if (!(priority && assignee)) {
        throw new Error("priority and assignee controls did not render");
      }
      expect(priority).toHaveTextContent("High");
      await userEvent.click(priority);
      await userEvent.click(
        await screen.findByRole("option", { name: LOW_OPTION })
      );
      await waitFor(() => expect(priority).toHaveTextContent("Low"));

      expect(assignee).toHaveTextContent("Ottilie Eastwick");
      await userEvent.click(assignee);
      await userEvent.click(
        await screen.findByRole("option", { name: CLEAR_SELECTION_OPTION })
      );
      await waitFor(() => expect(assignee).toHaveTextContent("Unassigned"));

      await userEvent.click(assignee);
      await userEvent.click(
        await screen.findByRole("option", { name: MARISOL_OPTION })
      );
      await waitFor(() => expect(assignee).toHaveTextContent("Marisol"));
    },
    CASE_TIMEOUT_MS
  );
});
