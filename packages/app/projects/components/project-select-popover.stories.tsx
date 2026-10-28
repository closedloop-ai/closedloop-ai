import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  type ProjectOption,
  ProjectSelectPopover,
} from "./project-select-popover";

/**
 * The searchable project typeahead behind the desktop audit surface's project
 * picker (FEA-4008) — `audit-character-picker.tsx` and `file-findings-dialog.tsx`
 * both render this directly rather than a private copy.
 */
const PROJECTS: ProjectOption[] = [
  {
    id: "proj_closedloop_ai",
    name: "ClosedLoop AI",
    slug: "closedloop-ai",
  },
  {
    id: "proj_closedloop_electron",
    name: "ClosedLoop Electron",
    slug: "closedloop-electron",
  },
  {
    id: "proj_design_system_migration",
    name: "Design System Migration",
    slug: null,
  },
];

const meta = {
  title: "Composites v1.0/Projects/Project Select Popover",
  component: ProjectSelectPopover,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
  args: {
    onSelect: fn(),
    projects: PROJECTS,
    value: null,
  },
} satisfies Meta<typeof ProjectSelectPopover>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Nothing chosen yet: the trigger shows the placeholder and no clear row. */
export const NoSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("combobox");

    await expect(trigger).toHaveTextContent("Select project…");

    await userEvent.click(trigger);
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("ClosedLoop AI")).toBeVisible();
    await expect(body.getByText("ClosedLoop Electron")).toBeVisible();
    await expect(body.queryByText("Clear selection")).not.toBeInTheDocument();
  },
};

/** A project already chosen: the trigger shows its name, not the placeholder. */
export const Selected: Story = {
  args: {
    value: PROJECTS[1],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("combobox")).toHaveTextContent(
      "ClosedLoop Electron"
    );
  },
};

/** Clearing a selection back to null via the popover's own "Clear selection" row. */
export const ClearingSelection: Story = {
  args: {
    value: PROJECTS[1],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("combobox"));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByText("Clear selection"));

    await expect(args.onSelect).toHaveBeenCalledWith(null);
  },
};

/**
 * `allowClear={false}` — the Branch Details Project row (ISS-10995). Its
 * `batch-move` write accepts a clear since ISS-12858, but the row does not offer
 * one yet (ISS-12859). A chosen project is changeable but not clearable.
 */
export const NoClear: Story = {
  args: {
    allowClear: false,
    value: PROJECTS[1],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("combobox"));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("ClosedLoop AI")).toBeVisible();
    await expect(body.queryByText("Clear selection")).not.toBeInTheDocument();
  },
};

/**
 * `variant="ghost"` — the inline form an inline table cell or a Details row
 * wants, where editability is hover and cursor rather than a border
 * (ISS-12252). The boxed `outline` default belongs to a dialog field.
 */
export const GhostTrigger: Story = {
  args: {
    value: PROJECTS[0],
    variant: "ghost",
  },
};

/**
 * The project list is still fetching. `isLoading` must read as "fetching",
 * not "no projects" — the picker never presents an in-flight load as an
 * empty org.
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    projects: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("combobox"));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("Loading projects…")).toBeVisible();
  },
};

/**
 * The project list failed to load. `isError` must read as a failed fetch,
 * not "no projects" — a false empty state would disable creation on a
 * premise the picker can't actually confirm.
 */
export const ErrorState: Story = {
  args: {
    isError: true,
    projects: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("combobox"));
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByText(
        "Couldn't load projects. Check your connection and try again."
      )
    ).toBeVisible();
  },
};

/** A genuinely empty org: loaded successfully, with zero projects to choose from. */
export const Empty: Story = {
  args: {
    projects: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("combobox"));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("No projects found.")).toBeVisible();
  },
};

/** The whole control disabled, such as while its host form is submitting. */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("combobox")).toBeDisabled();
  },
};
