/**
 * Behavior tests for the Document Detail Surface
 * (`stories/surfaces/document-detail.stories.tsx`): its Story header
 * substitute's overflow menu and the historical-version restore path. The
 * stories have no `play`, so the sweep returns before the fixture GET settles
 * and the header never mounts; each case composes a story and waits for the
 * real `VersionedDocumentEditorContainer` to hand the document over.
 */
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { composeStory } from "@storybook/react";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import { ORG_SLUG } from "../stories/surfaces/app-shell";
import documentDetailMeta, {
  Default as defaultStory,
  HistoricalVersion as historicalStory,
} from "../stories/surfaces/document-detail.stories";

type AppCoreParams = {
  apiRoutes: FixtureRoute[];
  queryData: readonly (readonly unknown[])[];
  enabledFlags?: readonly string[];
};

const CASE_TIMEOUT_MS = 30_000;
const MORE_OPTIONS_LABEL = "More options";
const RESTORE_VERSION = "Restore Version";
const TOGGLE_PANEL_LABEL = "Toggle side panel";

const DOCUMENT_HEADING = /Document/;
const DOCUMENT = documentDetailMeta.args.document;
const HISTORICAL = historicalStory.args?.document;

async function mountAndOpenOverflow(story: ReturnType<typeof composeStory>) {
  await story.run();
  const more = await screen.findByRole(
    "button",
    { name: MORE_OPTIONS_LABEL },
    { timeout: 15_000 }
  );
  await userEvent.click(more);
  await screen.findByRole("menu");
}

describe("Document Detail header", () => {
  it(
    "links the Documents crumb, offers export/copy/delete, and no restore on the latest version",
    async () => {
      await mountAndOpenOverflow(
        composeStory(defaultStory, documentDetailMeta)
      );

      expect(
        screen.getByRole("menuitem", { name: "Export Markdown" })
      ).toBeVisible();
      expect(
        screen.getByRole("menuitem", { name: "Copy Markdown" })
      ).toBeVisible();
      expect(
        screen.getByRole("menuitem", { name: "Delete Document" })
      ).toBeVisible();
      expect(
        screen.queryByRole("menuitem", { name: RESTORE_VERSION })
      ).toBeNull();
      await userEvent.keyboard("{Escape}");

      const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
      expect(
        within(crumbs).getByRole("link", { name: "Documents" })
      ).toHaveAttribute("href", `/${ORG_SLUG}/documents`);
      expect(within(crumbs).getByText(DOCUMENT.title)).toBeVisible();
      expect(
        screen.getByRole("button", { name: TOGGLE_PANEL_LABEL })
      ).toBeVisible();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "Delete Document opens the scaffold's delete dialog",
    async () => {
      await mountAndOpenOverflow(
        composeStory(defaultStory, documentDetailMeta)
      );

      await userEvent.click(
        screen.getByRole("menuitem", { name: "Delete Document" })
      );

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("heading")).toHaveTextContent(
        DOCUMENT_HEADING
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    "on a historical version, Restore Version posts the old content as a new version",
    async () => {
      if (!HISTORICAL) {
        throw new Error("HistoricalVersion story has no document arg");
      }
      const params = historicalStory.parameters?.appCore as AppCoreParams;
      const versionsPath = `/documents/${HISTORICAL.id}/versions`;
      const original = params.apiRoutes.find(
        (route) => route.method === "POST" && route.path === versionsPath
      );
      if (!original) {
        throw new Error("story registers no versions route");
      }
      const posted = vi.fn(original.respond);
      const story = composeStory(
        {
          ...historicalStory,
          parameters: {
            ...historicalStory.parameters,
            appCore: {
              ...params,
              apiRoutes: params.apiRoutes.map((route) =>
                route === original ? { ...route, respond: posted } : route
              ),
            },
          },
        },
        documentDetailMeta
      );
      await mountAndOpenOverflow(story);

      await userEvent.click(
        screen.getByRole("menuitem", { name: RESTORE_VERSION })
      );

      await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
      expect(posted.mock.calls[0]?.[0]).toMatchObject({
        body: { content: HISTORICAL.version.content },
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "with no flags set: offers the side-panel toggle and reports its expanded state",
    async () => {
      await composeStory(defaultStory, documentDetailMeta).run();
      const toggle = await screen.findByRole(
        "button",
        { name: TOGGLE_PANEL_LABEL },
        { timeout: 15_000 }
      );
      // The scaffold opens its side panel by default.
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      await userEvent.click(toggle);
      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-expanded", "false")
      );

      await userEvent.click(toggle);
      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-expanded", "true")
      );
    },
    CASE_TIMEOUT_MS
  );
});
