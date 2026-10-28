import { ISSUES_LIST_DESIGN_ROWS } from "@repo/app/issues/components/list-design/issues-list-design-fixtures";
import { IssuesListDesignPreview } from "@repo/app/issues/components/list-design/issues-list-design-preview";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { PlusIcon } from "lucide-react";
import { expect, within } from "storybook/test";
import IssuesPage from "@/app/(authenticated)/[orgSlug]/issues/page";
import { Header } from "@/app/(authenticated)/components/header";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar: Issues List (not in the live app).
// Default and Dark are the Issues List design shell (ISS-12586, DI-16), the
// same shell as the Documents List: the Branches list composition (toolbar,
// one count card, the table with the canonical artifact list cells, the
// pagination footer) with the Issues columns and fixture rows, in the app
// frame. No Type column. The full page design is separate work. Until 2.0.31
// Default showed Patterns/Labs/Issues/Issues List in the
// app frame (ISS-12171), which stays at its own Patterns entry.
//
// `Live` is the route's own page (`apps/app/.../issues/page.tsx`: the Issues
// artifact flag's route gate and what it renders). The flag is off in
// production, so the live sidebar has no Issues item; this shows what the
// route renders once the flag is on.

const meta = {
  title: "Surfaces/Labs/Issues/Issues List",
  tags: ["preview"],
  render: () => (
    <LivePage activePath="/issues">
      <IssuesListDesignPreview
        header={
          <Header breadcrumbs={[{ label: "Issues" }]}>
            {/* The live header's action, inert: the shell has no create flow. */}
            <Button size="sm" type="button">
              <PlusIcon aria-hidden />
              Add issue
            </Button>
          </Header>
        }
      />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: liveAppShellRoutes,
      enabledFlags: [ArtifactFlag.Issues],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const DESIGN_COLUMN_HEADERS = [
  "Issue",
  "Status",
  "Priority",
  "Assignee",
  "Owner",
  "Comments",
  "Updated",
  "Tags",
];

/** The design shell: the Issues columns, one count card, no Type column. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of DESIGN_COLUMN_HEADERS) {
      await expect(
        canvas.getByRole("columnheader", { name })
      ).toBeInTheDocument();
    }
    await expect(
      canvas.queryByRole("columnheader", { name: "Type" })
    ).toBeNull();
    const [first] = ISSUES_LIST_DESIGN_ROWS;
    await expect(canvas.getByText(first?.document.title ?? "")).toBeVisible();
  },
};

/** The design shell in the dark theme. */
export const Dark: Story = { globals: { theme: "dark" } };

/** The page the route renders today. */
export const Live: Story = {
  render: () => (
    <LivePage activePath="/issues">
      <IssuesPage />
    </LivePage>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expect(
      (await canvas.findAllByRole("heading")).length
    ).toBeGreaterThan(0);
  },
};
