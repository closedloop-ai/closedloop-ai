import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import MyTasksPage from "@/app/(authenticated)/[orgSlug]/my-tasks/page";
import {
  documentListPage,
  myTasksApiRoutes,
} from "./fixtures/my-tasks-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar, entry 8 of 62: My Tasks (Artifact list).
// The live route's own page (`apps/app/.../my-tasks/page.tsx`) in the app
// frame. The list view is the Default (ISS-11361, Decided 2); the card view is
// the same page after the View menu switches it, which the page keeps in
// localStorage. Each story is one state the live page reaches from its reads.

/** The page's own localStorage key for the chosen view (`VIEW_KEY`). */
const VIEW_STORAGE_KEY = "my-tasks-view";

function withRoutes(overrides: FixtureRoute[]): FixtureRoute[] {
  return [...overrides, ...myTasksApiRoutes];
}

const documentsFailed: FixtureRoute = {
  method: "GET",
  path: "/documents",
  respond: () => null,
  status: 500,
};

const documentsPending: FixtureRoute = {
  method: "GET",
  path: "/documents",
  respond: () => new Promise(() => undefined),
};

const noDocuments: FixtureRoute = {
  method: "GET",
  path: "/documents",
  respond: () => documentListPage([]),
};

/** Opens the page in the card view, as if the View menu had chosen it. */
function cardView() {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify("card"));
  } catch {
    // Storage blocked: the page renders its default (list) view.
  }
  return () => {
    try {
      localStorage.removeItem(VIEW_STORAGE_KEY);
    } catch {
      // Nothing was stored.
    }
  };
}

const meta = {
  title: "Surfaces/Labs/My Tasks",
  tags: ["preview"],
  render: () => (
    <LivePage activePath="/my-tasks">
      <MyTasksPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: myTasksApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1 })
    ).toBeInTheDocument();
    await expect(await canvas.findByRole("table")).toBeVisible();
    await expect(
      await canvas.findByRole("link", { name: "My Tasks" })
    ).toHaveAttribute("data-active", "true");
  },
};

/** A row's own expand toggle (the status and menu triggers also carry `aria-expanded`). */
const ROW_EXPANDER =
  '[role="table"] [role="cell"] button[aria-expanded="false"]:not([aria-haspopup])';

/** The assigned-documents read is still in flight. */
export const Loading: Story = {
  parameters: {
    appCore: { apiRoutes: withRoutes([documentsPending]) },
  },
};

/** Nothing is assigned to the signed-in user. */
export const Empty: Story = {
  parameters: { appCore: { apiRoutes: withRoutes([noDocuments]) } },
};

/** The assigned-documents read failed. */
export const LoadFailed: Story = {
  parameters: {
    appCore: { apiRoutes: withRoutes([documentsFailed]) },
  },
};

/** Every parent row opened, showing the plans and issues under it. */
export const Expanded: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector(ROW_EXPANDER)).not.toBeNull()
    );
    // Opening a row reveals nested rows that may themselves be collapsed.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const toggle of canvasElement.querySelectorAll<HTMLElement>(
        ROW_EXPANDER
      )) {
        await userEvent.click(toggle);
      }
    }
  },
};

/** The card view, chosen from the View menu. */
export const Cards: Story = {
  beforeEach: cardView,
};

export const CardsLoading: Story = {
  beforeEach: cardView,
  parameters: {
    appCore: { apiRoutes: withRoutes([documentsPending]) },
  },
};

export const CardsEmpty: Story = {
  beforeEach: cardView,
  parameters: { appCore: { apiRoutes: withRoutes([noDocuments]) } },
};

export const CardsError: Story = {
  beforeEach: cardView,
  parameters: {
    appCore: { apiRoutes: withRoutes([documentsFailed]) },
  },
};
