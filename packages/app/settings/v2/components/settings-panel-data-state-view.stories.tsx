import type { Meta, StoryObj } from "@storybook/react";
import { KeyRoundIcon } from "lucide-react";
import { fn } from "storybook/test";
import { SettingsPanelDataState } from "../lib/settings-panel-data-state";
import { SettingsPanelDataStateView } from "./settings-panel-data-state-view";

const EMPTY_COPY = {
  description: "Create a key to connect an MCP client or a REST integration.",
  icon: KeyRoundIcon,
  title: "No API keys yet",
};

/**
 * The five outcomes a Settings v2 panel body renders instead of its content
 * (ISS-8369). Stories exist because these are exactly the states nobody sees by
 * accident: three of them need a server to misbehave, and until ISS-8370 mounts
 * Settings there is no route that reaches any of them at all.
 */
const meta = {
  title: "Composites v1.0/Settings/Settings Panel Data State View",
  component: SettingsPanelDataStateView,
  tags: ["deprecated", "autodocs"],
  args: {
    empty: EMPTY_COPY,
    onRetry: fn(),
    state: SettingsPanelDataState.Failed,
    subject: "your API keys",
  },
} satisfies Meta<typeof SettingsPanelDataStateView>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The read is in flight. A skeleton, never a zero and never an empty frame. */
export const Loading: Story = {
  args: { state: SettingsPanelDataState.Loading },
};

/** The read answered and the collection really is empty. */
export const Empty: Story = {
  args: { state: SettingsPanelDataState.Empty },
};

/**
 * The server decided. No Try again, because retrying an answered refusal cannot
 * change it.
 */
export const Forbidden: Story = {
  args: { state: SettingsPanelDataState.Forbidden },
};

/**
 * The server could NOT decide. Deliberately not the screen above: nothing about
 * this actor's access was determined, so it offers a retry and says so.
 */
export const Unavailable: Story = {
  args: { state: SettingsPanelDataState.Unavailable },
};

/** Anything else that went wrong. Distinct from the empty state above it. */
export const Failed: Story = {
  args: { state: SettingsPanelDataState.Failed },
};

/**
 * A panel with no reachable empty state omits the copy entirely rather than
 * writing a sentence nothing can render — the Other Labs panel reads one scalar
 * setting, which is never an empty collection.
 */
export const FailedWithoutEmptyCopy: Story = {
  args: { empty: undefined, subject: "your Labs settings" },
};
