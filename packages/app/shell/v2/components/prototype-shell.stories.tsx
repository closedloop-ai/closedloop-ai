import type { Meta, StoryObj } from "@storybook/react";
import { PrototypeShell } from "./prototype-shell";

/**
 * ISS-10337: the shell both sandbox routes mount. The state matrix here is the
 * one a prototype author actually varies — one breadcrumb vs several, a current
 * crumb vs none, the actions slot filled vs empty, and an `activePath` that
 * names a real nav row vs one that names nothing.
 */
const meta = {
  title: "Composites v1.0/App Shell/Prototype Shell",
  component: PrototypeShell,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    activePath: "/sessions",
    breadcrumbs: [{ label: "Sessions" }, { isCurrent: true, label: "Detail" }],
    children: <div className="text-muted-foreground text-sm">Content</div>,
  },
} satisfies Meta<typeof PrototypeShell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A single crumb, already current — the shallowest trail a route can have. */
export const SingleCurrentCrumb: Story = {
  args: { breadcrumbs: [{ isCurrent: true, label: "Dashboard" }] },
};

/** No crumb marked current: every segment renders as a link, no `BreadcrumbPage`. */
export const NoCurrentCrumb: Story = {
  args: {
    breadcrumbs: [{ label: "Insights" }, { label: "Team Spend" }],
  },
};

/** The header actions slot filled — the right-hand region is otherwise absent. */
export const WithActions: Story = {
  args: {
    actions: <span className="text-muted-foreground text-xs">Actions</span>,
  },
};

/**
 * An `activePath` that matches no destination in the fixture: no nav row reads
 * as active, and nothing throws.
 */
export const NoMatchingActivePath: Story = {
  args: { activePath: "/not-a-destination" },
};
