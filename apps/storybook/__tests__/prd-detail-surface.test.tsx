/**
 * Behavior tests for the PRD Detail Surface (`stories/surfaces/prd-detail
 * .stories.tsx`) — its Story header substitute and the editor it composes.
 * The stories have no `play`, so the sweep returns before the fixture GET
 * settles and the header never mounts; each case here composes a story and
 * waits for the real `VersionedDocumentEditorContainer` to hand over.
 */
import { DocumentType } from "@repo/api/src/types/document";
import { composeStory } from "@storybook/react";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it } from "vitest";
import { ORG_SLUG } from "../stories/surfaces/app-shell";
import prdDetailMeta, {
  Default as defaultStory,
  FreshlyGenerated as freshStory,
  HistoricalVersion as historicalStory,
} from "../stories/surfaces/prd-detail.stories";

const CASE_TIMEOUT_MS = 30_000;
const ACTIONS_LABEL = "Actions";
const MORE_OPTIONS_LABEL = "More options";
const RESTORE_VERSION = "Restore Version";
const TOGGLE_PANEL_LABEL = "Toggle chat panel";
// `useEditorChrome` persists the side-panel state under this key.
const PANEL_STATE_KEY = `panel:chat:${DocumentType.Prd}`;

const PRD_DEFAULT = prdDetailMeta.args.document;
const PROJECT = requireProject(PRD_DEFAULT);
const TEAM = PROJECT.teams?.[0];
if (!TEAM) {
  throw new Error("default PRD fixture carries no team");
}

function requireProject(document: typeof PRD_DEFAULT) {
  if (!document.project) {
    throw new Error(`${document.slug} fixture carries no project`);
  }
  return document.project;
}

async function mountEditor(story: ReturnType<typeof composeStory>) {
  await story.run();
  await screen.findByRole(
    "button",
    { name: MORE_OPTIONS_LABEL },
    { timeout: 15_000 }
  );
}

async function mountAndOpenOverflow(story: ReturnType<typeof composeStory>) {
  await mountEditor(story);
  await userEvent.click(
    screen.getByRole("button", { name: MORE_OPTIONS_LABEL })
  );
  await screen.findByRole("menu");
}

function menuItem(name: string) {
  return screen.getByRole("menuitem", { name });
}

describe("PRD Detail header", () => {
  it(
    "default: team/project crumbs and no Actions menu",
    async () => {
      await mountEditor(composeStory(defaultStory, prdDetailMeta));

      expect(screen.queryByRole("button", { name: ACTIONS_LABEL })).toBeNull();
      const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
      expect(
        within(crumbs).getByRole("link", { name: TEAM.name })
      ).toHaveAttribute("href", `/${ORG_SLUG}/teams/${TEAM.id}/projects`);
      expect(
        within(crumbs).getByRole("link", { name: PROJECT.name })
      ).toHaveAttribute(
        "href",
        `/${ORG_SLUG}/teams/${TEAM.id}/projects/${PROJECT.id}`
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    "overflow: Export .md, Move... and Delete only; Restore is absent on the latest version",
    async () => {
      await mountAndOpenOverflow(composeStory(defaultStory, prdDetailMeta));
      expect(
        screen.queryByRole("menuitem", { name: RESTORE_VERSION })
      ).toBeNull();
      expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "freshly generated (no project): Library crumb only",
    async () => {
      await mountEditor(composeStory(freshStory, prdDetailMeta));

      const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
      expect(
        within(crumbs).getByRole("link", { name: "Library" })
      ).toHaveAttribute("href", `/${ORG_SLUG}/prds`);
      expect(within(crumbs).queryAllByRole("link")).toHaveLength(1);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "historical version: the overflow offers Restore Version",
    async () => {
      await mountAndOpenOverflow(composeStory(historicalStory, prdDetailMeta));

      expect(menuItem(RESTORE_VERSION)).toBeVisible();
      await userEvent.click(menuItem(RESTORE_VERSION));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    },
    CASE_TIMEOUT_MS
  );

  it(
    "offers the chat-panel toggle with no flags set, and each click flips the persisted panel state",
    async () => {
      await composeStory(defaultStory, prdDetailMeta).run();
      const toggles = await screen.findAllByRole(
        "button",
        { name: TOGGLE_PANEL_LABEL },
        { timeout: 15_000 }
      );
      expect(toggles).toHaveLength(1);
      const [toggle] = toggles;
      if (!toggle) {
        throw new Error("expected exactly one chat-panel toggle");
      }
      // The story is room-less, so the feed rail stays disabled and the only
      // observable effect of the toggle is the scaffold's persisted panel
      // state (`useEditorChrome`, keyed per document type).
      expect(globalThis.localStorage.getItem(PANEL_STATE_KEY)).toBeNull();
      await userEvent.click(toggle);
      await waitFor(() =>
        expect(globalThis.localStorage.getItem(PANEL_STATE_KEY)).toBe("false")
      );
      await userEvent.click(toggle);
      await waitFor(() =>
        expect(globalThis.localStorage.getItem(PANEL_STATE_KEY)).toBe("true")
      );
    },
    CASE_TIMEOUT_MS
  );
});
